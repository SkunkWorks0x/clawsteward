import { describe, it, expect, vi, beforeEach } from "vitest";
import { SolanaSimulator } from "../../src/chain/solana-adapter.js";
import type { AssetDelta, SimulationContext } from "../../src/core/types.js";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// ─── Helpers ──────────────────────────────────────────────────────

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createMockFetch(responses: Record<string, unknown> | FetchFn): FetchFn {
  if (typeof responses === "function") return responses;

  return async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // RPC calls (POST to Helius)
    if (_init?.method === "POST" || (_init?.body && typeof _init.body === "string")) {
      const body = JSON.parse(_init!.body as string);
      const method = body.method as string;
      const responseData = responses[method];
      if (responseData) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: responseData }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Jupiter price API (GET)
    if (urlStr.includes("/price")) {
      const priceResponse = responses["jupiter_price"];
      if (priceResponse) {
        return new Response(JSON.stringify(priceResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

function buildLegacyTx(): { base64: string; payer: Keypair; recipient: Keypair } {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const tx = new Transaction({
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    feePayer: payer.publicKey,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1_000_000,
    })
  );
  tx.sign(payer);
  return { base64: tx.serialize().toString("base64"), payer, recipient };
}

function buildVersionedTx(): { base64: string; payer: Keypair; recipient: Keypair } {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 500_000,
      }),
    ],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(messageV0);
  vtx.sign([payer]);
  return { base64: Buffer.from(vtx.serialize()).toString("base64"), payer, recipient };
}

const defaultContext: SimulationContext = {
  agent_id: "test-agent-001",
  rpc_url: "https://mock-helius.example.com",
};

// ─── Tests ────────────────────────────────────────────────────────

describe("SolanaSimulator", () => {
  describe("constructor", () => {
    it("uses default Jupiter URL when not provided", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      expect(sim.chain).toBe("solana");
    });

    it("accepts custom Jupiter URL", () => {
      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        jupiterPriceApiUrl: "https://custom-jupiter.example.com",
      });
      expect(sim.chain).toBe("solana");
    });
  });

  describe("validateAddress", () => {
    it("returns true for valid Solana public key", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      const kp = Keypair.generate();
      expect(sim.validateAddress(kp.publicKey.toBase58())).toBe(true);
    });

    it("returns true for system program address", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      expect(sim.validateAddress("11111111111111111111111111111111")).toBe(true);
    });

    it("returns false for invalid address", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      expect(sim.validateAddress("not-a-valid-address")).toBe(false);
    });

    it("returns false for empty string", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      expect(sim.validateAddress("")).toBe(false);
    });
  });

  describe("extractTransactionMeta", () => {
    it("extracts metadata from legacy transaction", () => {
      const { base64, payer, recipient } = buildLegacyTx();
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });

      const meta = sim.extractTransactionMeta(base64);

      expect(meta.programIds).toContain(SystemProgram.programId.toBase58());
      expect(meta.numInstructions).toBe(1);
      expect(meta.recentBlockhash).toBe("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
      expect(meta.signers.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts metadata from versioned transaction", () => {
      const { base64, payer } = buildVersionedTx();
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });

      const meta = sim.extractTransactionMeta(base64);

      expect(meta.programIds).toContain(SystemProgram.programId.toBase58());
      expect(meta.numInstructions).toBe(1);
      expect(meta.signers).toContain(payer.publicKey.toBase58());
    });

    it("throws on invalid base64 input", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      expect(() => sim.extractTransactionMeta("!!!invalid-base64!!!")).toThrow();
    });

    it("throws on empty transaction data", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      const emptyBase64 = Buffer.from([]).toString("base64");
      expect(() => sim.extractTransactionMeta(emptyBase64)).toThrow("Empty transaction data");
    });

    it("throws on random garbage bytes", () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      const garbage = Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x03]).toString("base64");
      expect(() => sim.extractTransactionMeta(garbage)).toThrow();
    });
  });

  describe("simulate", () => {
    it("returns successful simulation result", async () => {
      const { base64 } = buildLegacyTx();

      const mockFetch = createMockFetch({
        getLatestBlockhash: {
          value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 100 },
          context: { slot: 1 },
        },
        simulateTransaction: {
          value: {
            err: null,
            logs: ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"],
            unitsConsumed: 150,
            accounts: null,
          },
          context: { slot: 100 },
        },
      });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://mock-helius.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const result = await sim.simulate(base64, defaultContext);

      expect(result.success).toBe(true);
      expect(result.chain).toBe("solana");
      expect(result.error).toBeUndefined();
      expect(result.counterparties).toContain(SystemProgram.programId.toBase58());
      expect(result.simulation_timestamp).toBeTruthy();
      expect(result.raw_chain_payload).toBeTruthy();

      const payload = result.raw_chain_payload as { logs: string[]; unitsConsumed: number };
      expect(payload.logs).toHaveLength(2);
      expect(payload.unitsConsumed).toBe(150);
    });

    it("returns failed simulation with error details", async () => {
      const { base64 } = buildLegacyTx();

      const mockFetch = createMockFetch({
        getLatestBlockhash: {
          value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 100 },
          context: { slot: 1 },
        },
        simulateTransaction: {
          value: {
            err: { InstructionError: [0, { Custom: 1 }] },
            logs: ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 failed: custom error"],
            unitsConsumed: 50,
            accounts: null,
          },
          context: { slot: 100 },
        },
      });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://mock-helius.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const result = await sim.simulate(base64, defaultContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("InstructionError");
    });

    it("handles RPC timeout/network error", async () => {
      const { base64 } = buildLegacyTx();

      const mockFetch = async () => {
        throw new Error("Network timeout: connection refused");
      };

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://dead-rpc.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const result = await sim.simulate(base64, defaultContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Simulation RPC error");
      expect(result.error).toContain("Network timeout");
    });

    it("handles invalid base64 transaction gracefully", async () => {
      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        fetch: (async () => new Response("", { status: 200 })) as typeof globalThis.fetch,
      });

      const result = await sim.simulate("!!!not-base64!!!", defaultContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("deserialization failed");
    });

    it("uses context.rpc_url over constructor rpcUrl", async () => {
      const { base64 } = buildLegacyTx();
      let capturedUrl = "";

      const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: {
                err: null,
                logs: [],
                unitsConsumed: 0,
                accounts: null,
              },
              context: { slot: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://default-rpc.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      await sim.simulate(base64, {
        ...defaultContext,
        rpc_url: "https://custom-context-rpc.example.com",
      });

      expect(capturedUrl).toContain("custom-context-rpc.example.com");
    });
  });

  describe("estimateUsdValue", () => {
    it("returns total USD value from Jupiter prices", async () => {
      const mockFetch = createMockFetch({
        jupiter_price: {
          data: {
            SOL_MINT: { id: "SOL_MINT", mintSymbol: "SOL", vsToken: "USDC", vsTokenSymbol: "USDC", price: 150.0 },
            USDC_MINT: { id: "USDC_MINT", mintSymbol: "USDC", vsToken: "USDC", vsTokenSymbol: "USDC", price: 1.0 },
          },
          timeTaken: 0.005,
        },
      });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        jupiterPriceApiUrl: "https://mock-jupiter.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const assets: AssetDelta[] = [
        { asset: "SOL_MINT", symbol: "SOL", delta: -2.0, usd_value: 0 },
        { asset: "USDC_MINT", symbol: "USDC", delta: 300.0, usd_value: 0 },
      ];

      const usd = await sim.estimateUsdValue(assets);

      // abs(-2.0) * 150 + abs(300) * 1.0 = 300 + 300 = 600
      expect(usd).toBe(600);
    });

    it("returns 0 for empty assets array", async () => {
      const sim = new SolanaSimulator({ heliusRpcUrl: "https://rpc.example.com" });
      const usd = await sim.estimateUsdValue([]);
      expect(usd).toBe(0);
    });

    it("skips assets not found in Jupiter response", async () => {
      const mockFetch = createMockFetch({
        jupiter_price: {
          data: {
            SOL_MINT: { id: "SOL_MINT", mintSymbol: "SOL", vsToken: "USDC", vsTokenSymbol: "USDC", price: 150.0 },
          },
          timeTaken: 0.003,
        },
      });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        jupiterPriceApiUrl: "https://mock-jupiter.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const assets: AssetDelta[] = [
        { asset: "SOL_MINT", symbol: "SOL", delta: 1.0, usd_value: 0 },
        { asset: "UNKNOWN_MINT", symbol: "???", delta: 100.0, usd_value: 0 },
      ];

      const usd = await sim.estimateUsdValue(assets);
      expect(usd).toBe(150);
    });

    it("throws on Jupiter API failure", async () => {
      const mockFetch = async () => new Response("Internal Server Error", { status: 500 });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const assets: AssetDelta[] = [
        { asset: "SOL_MINT", symbol: "SOL", delta: 1.0, usd_value: 0 },
      ];

      await expect(sim.estimateUsdValue(assets)).rejects.toThrow("USD estimation failed");
    });

    it("throws on network error to Jupiter", async () => {
      const mockFetch = async () => {
        throw new Error("DNS resolution failed");
      };

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      const assets: AssetDelta[] = [
        { asset: "SOL_MINT", symbol: "SOL", delta: 1.0, usd_value: 0 },
      ];

      await expect(sim.estimateUsdValue(assets)).rejects.toThrow("USD estimation failed");
    });
  });

  describe("estimateSingleTokenUsd", () => {
    it("converts raw token amount using decimals", async () => {
      const mockFetch = createMockFetch({
        jupiter_price: {
          data: {
            SOL_MINT: { id: "SOL_MINT", mintSymbol: "SOL", vsToken: "USDC", vsTokenSymbol: "USDC", price: 150.0 },
          },
          timeTaken: 0.002,
        },
      });

      const sim = new SolanaSimulator({
        heliusRpcUrl: "https://rpc.example.com",
        jupiterPriceApiUrl: "https://mock-jupiter.example.com",
        fetch: mockFetch as typeof globalThis.fetch,
      });

      // 2 SOL = 2_000_000_000 lamports, 9 decimals
      const usd = await sim.estimateSingleTokenUsd("SOL_MINT", 2_000_000_000n, 9);
      expect(usd).toBe(300); // 2 * 150
    });
  });
});
