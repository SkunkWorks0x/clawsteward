// Solana Chain Adapter — implements ChainSimulator for Solana v1
// Uses Helius RPC for simulation, Jupiter Price API for USD estimation

import {
  Connection,
  Transaction,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import type { AssetDelta, SimulationContext, SimulationResult } from "../core/types.js";
import type { ChainSimulator } from "./simulator.js";
import type {
  JupiterPriceResponse,
  SolanaSimulationPayload,
  SolanaSimulatorOptions,
  TransactionMeta,
} from "./types.js";

const DEFAULT_JUPITER_PRICE_URL = "https://price.jup.ag/v6";
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export class SolanaSimulator implements ChainSimulator {
  readonly chain = "solana";

  private readonly rpcUrl: string;
  private readonly jupiterPriceUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly fetchTimeoutMs: number;

  constructor(options: SolanaSimulatorOptions) {
    this.rpcUrl = options.heliusRpcUrl;
    this.jupiterPriceUrl = options.jupiterPriceApiUrl ?? DEFAULT_JUPITER_PRICE_URL;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  private createTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.fetchTimeoutMs);
  }

  async simulate(tx: unknown, context: SimulationContext): Promise<SimulationResult> {
    const rawTxBase64 = tx as string;
    const now = new Date().toISOString();

    let txMeta: TransactionMeta;
    try {
      txMeta = this.extractTransactionMeta(rawTxBase64);
    } catch (err) {
      return {
        success: false,
        chain: this.chain,
        estimated_usd_value: 0,
        estimated_slippage_pct: 0,
        counterparties: [],
        assets_affected: [],
        raw_chain_payload: null,
        simulation_timestamp: now,
        error: `Transaction deserialization failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const connection = new Connection(context.rpc_url || this.rpcUrl, {
        fetch: this.fetchFn,
      });

      const txBuffer = Buffer.from(rawTxBase64, "base64");
      let simResult;

      try {
        // Try as VersionedTransaction first
        const versionedTx = VersionedTransaction.deserialize(txBuffer);
        simResult = await connection.simulateTransaction(versionedTx);
      } catch {
        // Fall back to legacy Transaction
        const legacyTx = Transaction.from(txBuffer);
        simResult = await connection.simulateTransaction(legacyTx);
      }

      const simValue = simResult.value;
      const success = simValue.err === null;

      const payload: SolanaSimulationPayload = {
        logs: simValue.logs ?? [],
        unitsConsumed: simValue.unitsConsumed ?? 0,
        accountsAccessed: txMeta.accounts,
        err: simValue.err,
      };

      return {
        success,
        chain: this.chain,
        estimated_usd_value: 0, // Caller should use estimateUsdValue separately
        estimated_slippage_pct: 0,
        counterparties: txMeta.programIds,
        assets_affected: [],
        raw_chain_payload: payload,
        simulation_timestamp: now,
        error: success ? undefined : JSON.stringify(simValue.err),
      };
    } catch (err) {
      return {
        success: false,
        chain: this.chain,
        estimated_usd_value: 0,
        estimated_slippage_pct: 0,
        counterparties: txMeta.programIds,
        assets_affected: [],
        raw_chain_payload: null,
        simulation_timestamp: now,
        error: `Simulation RPC error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  validateAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  async estimateUsdValue(assets: AssetDelta[]): Promise<number | null> {
    if (assets.length === 0) return 0;

    const mints = [...new Set(assets.map((a) => a.asset))];
    const url = `${this.jupiterPriceUrl}/price?ids=${mints.join(",")}`;

    try {
      const response = await this.fetchFn(url, {
        signal: this.createTimeoutSignal(),
      });
      if (!response.ok) {
        // Jupiter API failure — return null, don't crash
        return null;
      }
      const data = (await response.json()) as JupiterPriceResponse;

      let totalUsd = 0;
      for (const asset of assets) {
        const priceInfo = data.data[asset.asset];
        if (priceInfo) {
          totalUsd += Math.abs(asset.delta) * priceInfo.price;
        }
      }
      return totalUsd;
    } catch {
      // Network timeout, abort, or parse error — USD estimation unavailable
      return null;
    }
  }

  /**
   * Estimate USD value for a single token given its mint, raw amount, and decimals.
   * Convenience method wrapping estimateUsdValue.
   */
  async estimateSingleTokenUsd(
    mint: string,
    amount: bigint,
    decimals: number
  ): Promise<number | null> {
    const humanAmount = Number(amount) / 10 ** decimals;
    const assets: AssetDelta[] = [
      { asset: mint, symbol: "", delta: humanAmount, usd_value: 0 },
    ];
    return this.estimateUsdValue(assets);
  }

  extractTransactionMeta(rawTxBase64: string): TransactionMeta {
    let txBuffer: Buffer;
    try {
      txBuffer = Buffer.from(rawTxBase64, "base64");
    } catch {
      throw new Error("Invalid base64 encoding");
    }

    if (txBuffer.length === 0) {
      throw new Error("Empty transaction data");
    }

    // Try VersionedTransaction first, then legacy
    try {
      const vtx = VersionedTransaction.deserialize(txBuffer);
      const msg = vtx.message;
      const accountKeys = msg.staticAccountKeys.map((k) => k.toBase58());

      // In versioned transactions, program IDs are referenced by instruction programIdIndex
      const programIds = [
        ...new Set(
          msg.compiledInstructions.map(
            (ix) => accountKeys[ix.programIdIndex] ?? ""
          )
        ),
      ].filter(Boolean);

      // Signers are the first N accounts where N = header.numRequiredSignatures
      const numSigners = msg.header.numRequiredSignatures;
      const signers = accountKeys.slice(0, numSigners);

      return {
        programIds,
        accounts: accountKeys,
        signers,
        recentBlockhash: msg.recentBlockhash,
        numInstructions: msg.compiledInstructions.length,
      };
    } catch {
      // Try legacy transaction
      try {
        const legacyTx = Transaction.from(txBuffer);
        const instructions = legacyTx.instructions;

        const programIds = [
          ...new Set(instructions.map((ix) => ix.programId.toBase58())),
        ];

        const accounts = [
          ...new Set(
            instructions.flatMap((ix) =>
              ix.keys.map((k) => k.pubkey.toBase58())
            )
          ),
        ];

        const signers = [
          ...new Set(
            instructions.flatMap((ix) =>
              ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())
            )
          ),
        ];

        return {
          programIds,
          accounts,
          signers,
          recentBlockhash: legacyTx.recentBlockhash ?? "",
          numInstructions: instructions.length,
        };
      } catch (innerErr) {
        throw new Error(
          `Failed to deserialize transaction: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`
        );
      }
    }
  }
}
