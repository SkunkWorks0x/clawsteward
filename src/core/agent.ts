// ClawSteward Agent Model — UUIDv7 identity + chain_signers map
// Database-aware agent operations for the full registration flow.

import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import type { Agent } from "./types.js";
import {
  insertAgent,
  getAgent as getAgentQuery,
  getAgentBySignerAddress as getAgentBySignerQuery,
  setAgentPaused,
} from "../db/queries.js";

/**
 * Create a new Agent with UUIDv7 identity (in-memory only, no DB).
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

/**
 * Register a new agent: create + persist to database.
 * Returns the created Agent.
 */
export function registerAgent(
  db: Database.Database,
  params: {
    name: string;
    chain: string;
    signer_address: string;
    metadata?: Record<string, unknown>;
  },
): Agent {
  const agent = createAgent(params);
  insertAgent(db, agent);
  return agent;
}

/**
 * Get an agent by ID from the database.
 */
export function getAgent(db: Database.Database, id: string): Agent | undefined {
  return getAgentQuery(db, id);
}

/**
 * Find an agent by their signer address on a given chain.
 */
export function getAgentBySignerAddress(
  db: Database.Database,
  chain: string,
  address: string,
): Agent | undefined {
  return getAgentBySignerQuery(db, chain, address);
}

/**
 * Update an agent's paused state.
 */
export function updateAgentPausedState(
  db: Database.Database,
  id: string,
  paused: boolean,
): void {
  setAgentPaused(db, id, paused);
}
