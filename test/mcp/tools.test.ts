import { describe, it, expect } from "vitest";
import {
  StewardEvaluateInputSchema,
  StewardRegisterInputSchema,
  StewardScoreInputSchema,
  StewardLeaderboardInputSchema,
  StewardScanInputSchema,
} from "../../src/mcp/tools.js";

// ─── steward_evaluate ─────────────────────────────────────────────

describe("StewardEvaluateInputSchema", () => {
  it("accepts valid evaluate input", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "01912345-6789-7abc-def0-123456789abc",
      raw_transaction_base64: "AQAAAA==",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("accepts evaluate input with optional policy_set_id", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "agent-1",
      raw_transaction_base64: "dHgxMjM=",
      chain: "solana",
      policy_set_id: "conservative",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy_set_id).toBe("conservative");
    }
  });

  it("rejects missing agent_id", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      raw_transaction_base64: "AQAAAA==",
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty agent_id", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "",
      raw_transaction_base64: "AQAAAA==",
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported chain value", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "agent-1",
      raw_transaction_base64: "AQAAAA==",
      chain: "ethereum",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing raw_transaction_base64", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "agent-1",
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty raw_transaction_base64", () => {
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: "agent-1",
      raw_transaction_base64: "",
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });
});

// ─── steward_register ─────────────────────────────────────────────

describe("StewardRegisterInputSchema", () => {
  it("accepts valid register input", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "MyDeFAIAgent",
      chain_signers: [{ chain: "solana", address: "3eCxxPzt35ziJGK8JVqSmWaFokxZAggiby1Dybmj2GeJ" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts register input with optional policy_set_id", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "TestAgent",
      chain_signers: [{ chain: "solana", address: "pubkey123" }],
      policy_set_id: "institutional",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy_set_id).toBe("institutional");
    }
  });

  it("rejects missing name", () => {
    const result = StewardRegisterInputSchema.safeParse({
      chain_signers: [{ chain: "solana", address: "pubkey" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "",
      chain_signers: [{ chain: "solana", address: "pubkey" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty chain_signers array", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "Agent",
      chain_signers: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects chain_signers with empty address", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "Agent",
      chain_signers: [{ chain: "solana", address: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects chain_signers with unsupported chain", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "Agent",
      chain_signers: [{ chain: "base", address: "0xabc" }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── steward_score ────────────────────────────────────────────────

describe("StewardScoreInputSchema", () => {
  it("accepts valid score input", () => {
    const result = StewardScoreInputSchema.safeParse({
      agent_id: "agent-uuid-v7",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing agent_id", () => {
    const result = StewardScoreInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty agent_id", () => {
    const result = StewardScoreInputSchema.safeParse({ agent_id: "" });
    expect(result.success).toBe(false);
  });
});

// ─── steward_leaderboard ──────────────────────────────────────────

describe("StewardLeaderboardInputSchema", () => {
  it("accepts empty input (uses defaults)", () => {
    const result = StewardLeaderboardInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("accepts custom limit", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it("accepts min_score filter", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ min_score: 7.5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_score).toBe(7.5);
    }
  });

  it("rejects limit over 200", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 500 });
    expect(result.success).toBe(false);
  });

  it("rejects limit of 0", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it("rejects min_score above 10", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ min_score: 11 });
    expect(result.success).toBe(false);
  });

  it("rejects negative min_score", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ min_score: -1 });
    expect(result.success).toBe(false);
  });
});

// ─── steward_scan ─────────────────────────────────────────────────

describe("StewardScanInputSchema", () => {
  it("accepts valid scan input with defaults", () => {
    const result = StewardScanInputSchema.safeParse({ agent_id: "agent-1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days).toBe(30);
    }
  });

  it("accepts custom days", () => {
    const result = StewardScanInputSchema.safeParse({ agent_id: "agent-1", days: 90 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days).toBe(90);
    }
  });

  it("rejects missing agent_id", () => {
    const result = StewardScanInputSchema.safeParse({ days: 30 });
    expect(result.success).toBe(false);
  });

  it("rejects days over 365", () => {
    const result = StewardScanInputSchema.safeParse({ agent_id: "agent-1", days: 500 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer days", () => {
    const result = StewardScanInputSchema.safeParse({ agent_id: "agent-1", days: 30.5 });
    expect(result.success).toBe(false);
  });

  it("rejects days of 0", () => {
    const result = StewardScanInputSchema.safeParse({ agent_id: "agent-1", days: 0 });
    expect(result.success).toBe(false);
  });
});
