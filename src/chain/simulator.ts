// ChainSimulator Interface — adapter pattern for multi-chain support
// v1: Only SolanaAdapter exists
// v2: Add EvmAdapter — zero changes to core/policy/reputation

import type { AssetDelta, SimulationContext, SimulationResult } from "../core/types.js";

export interface ChainSimulator {
  chain: string;
  simulate(tx: unknown, context: SimulationContext): Promise<SimulationResult>;
  validateAddress(address: string): boolean;
  estimateUsdValue(assets: AssetDelta[]): Promise<number>;
}
