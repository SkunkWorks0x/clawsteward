import { describe, it, expect } from "vitest";
import { createAgent } from "../../src/core/agent.js";

describe("Agent Model", () => {
  it("creates an agent with UUIDv7 id", () => {
    const agent = createAgent({
      name: "TestAgent",
      chain: "solana",
      signer_address: "So11111111111111111111111111111111111111112",
    });

    expect(agent.id).toBeDefined();
    expect(agent.id).toHaveLength(36); // UUIDv7 format
    expect(agent.name).toBe("TestAgent");
  });

  it("maps chain signer correctly", () => {
    const pubkey = "So11111111111111111111111111111111111111112";
    const agent = createAgent({
      name: "SolAgent",
      chain: "solana",
      signer_address: pubkey,
    });

    expect(agent.chain_signers).toEqual({ solana: pubkey });
  });

  it("sets default metadata to empty object", () => {
    const agent = createAgent({
      name: "TestAgent",
      chain: "solana",
      signer_address: "abc123",
    });

    expect(agent.metadata).toEqual({});
  });

  it("stores custom metadata", () => {
    const agent = createAgent({
      name: "TestAgent",
      chain: "solana",
      signer_address: "abc123",
      metadata: { description: "A trading bot", version: "1.0" },
    });

    expect(agent.metadata).toEqual({ description: "A trading bot", version: "1.0" });
  });

  it("starts unpaused", () => {
    const agent = createAgent({
      name: "TestAgent",
      chain: "solana",
      signer_address: "abc123",
    });

    expect(agent.is_paused).toBe(false);
  });

  it("sets registered_at to ISO 8601 timestamp", () => {
    const before = new Date().toISOString();
    const agent = createAgent({
      name: "TestAgent",
      chain: "solana",
      signer_address: "abc123",
    });
    const after = new Date().toISOString();

    expect(agent.registered_at >= before).toBe(true);
    expect(agent.registered_at <= after).toBe(true);
  });

  it("generates unique IDs for each agent", () => {
    const agent1 = createAgent({ name: "A", chain: "solana", signer_address: "abc" });
    const agent2 = createAgent({ name: "B", chain: "solana", signer_address: "def" });

    expect(agent1.id).not.toBe(agent2.id);
  });
});
