// Chain-specific types — kept separate from core types

export type SupportedChain = "solana";

// Solana-specific simulation response (raw chain payload)
export interface SolanaSimulationPayload {
  logs: string[];
  unitsConsumed: number;
  accountsAccessed: string[];
  err: unknown;
}

// Structured transaction metadata extracted from deserialized tx
export interface TransactionMeta {
  programIds: string[];
  accounts: string[];
  signers: string[];
  recentBlockhash: string;
  numInstructions: number;
}

// Jupiter Price API response shape
export interface JupiterPriceResponse {
  data: Record<
    string,
    {
      id: string;
      mintSymbol: string;
      vsToken: string;
      vsTokenSymbol: string;
      price: number;
    }
  >;
  timeTaken: number;
}

// Options for SolanaSimulator constructor
export interface SolanaSimulatorOptions {
  heliusRpcUrl: string;
  jupiterPriceApiUrl?: string;
  fetch?: typeof globalThis.fetch;
  fetchTimeoutMs?: number;
}
