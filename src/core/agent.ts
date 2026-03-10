// ClawSteward Agent Model — UUIDv7 identity + chain_signers map

import { v7 as uuidv7 } from "uuid";
import type { Agent } from "./types.js";

/**
 * Create a new Agent with UUIDv7 identity.
 * Agent ID is NEVER a wallet address — it's chain-agnostic by design.
 */
export function createAgent(params: {
  name: string;
  chain: string;
  signer_address: string;
  metadata?: Record<string, unknown>;
}): Agent {
  return {
    id: uuidv7(),
    name: params.name,
    chain_signers: { [params.chain]: params.signer_address },
    registered_at: new Date().toISOString(),
    metadata: params.metadata ?? {},
    is_paused: false,
  };
}
