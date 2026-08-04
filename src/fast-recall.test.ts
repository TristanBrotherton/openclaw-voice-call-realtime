import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { createTestStorePath } from "./manager.test-harness.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { buildFastRecallReply, searchLocalMemory } from "./fast-recall.js";

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "fast-recall-"));
  writeFileSync(
    join(dir, "MEMORY.md"),
    ["# Memory", "- Buddy's phone number is +15550001111", "- We park at the north lot"].join("\n"),
  );
  mkdirSync(join(dir, "memory"));
  writeFileSync(
    join(dir, "memory", "buddy.md"),
    ["- **Phone:** +15550001111", "- Birthday: March 3", "- **Phone:** +15550001111"].join("\n"),
  );
  return dir;
}

describe("searchLocalMemory", () => {
  const config = { enabled: true, maxLines: 10 };

  it("finds matching lines, counting the filename toward the match", () => {
    const workspaceDir = makeWorkspace();
    const lines = searchLocalMemory("buddy phone", { ...config, workspaceDir });
    expect(lines.length).toBeGreaterThan(0);
    // top hit answers the question
    expect(lines[0]).toContain("+15550001111");
    // buddy.md's detail line ranks via its filename (no "buddy" in the line)
    expect(lines.some((l) => l.startsWith("[buddy.md]"))).toBe(true);
  });

  it("dedupes repeated lines and respects maxLines", () => {
    const workspaceDir = makeWorkspace();
    const lines = searchLocalMemory("buddy phone", { ...config, workspaceDir });
    const bodies = lines.map((l) => l.replace(/^\[[^\]]+\] /, ""));
    expect(new Set(bodies).size).toBe(bodies.length);

    const capped = searchLocalMemory("buddy phone", { enabled: true, maxLines: 1, workspaceDir });
    expect(capped.length).toBe(1);
  });

  it("returns nothing for short-term-only or unmatched queries", () => {
    const workspaceDir = makeWorkspace();
    expect(searchLocalMemory("a b", { ...config, workspaceDir })).toEqual([]);
    expect(searchLocalMemory("zzzqqq unmatched", { ...config, workspaceDir })).toEqual([]);
  });

  it("returns nothing when the workspace does not exist", () => {
    const workspaceDir = join(tmpdir(), "fast-recall-missing-xyz");
    expect(searchLocalMemory("buddy phone", { ...config, workspaceDir })).toEqual([]);
  });
});

describe("buildFastRecallReply", () => {
  it("carries the lines, the question, and escalation guidance", () => {
    const reply = buildFastRecallReply("what is buddy's number", ["[buddy.md] Phone: +15550001111"]);
    expect(reply).toContain("+15550001111");
    expect(reply).toContain("what is buddy's number");
    expect(reply).toContain("escalate");
    expect(reply).toContain("never read these lines aloud");
  });
});

describe("ask_assistant fast recall gating", () => {
  const OWNER = "+15550000077";
  const OTHER = "+15550000099";

  const makeServer = async (opts: { to: string; workspaceDir: string }) => {
    const bridgeCalls: string[] = [];
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      toNumber: OWNER,
      assistantBridge: {
        enabled: true,
        fastRecall: { enabled: true, workspaceDir: opts.workspaceDir },
      },
    });
    const manager = new CallManager(config, createTestStorePath());
    await manager.initialize(new MockProvider(), "https://example.com/voice/webhook");
    const server = new VoiceCallWebhookServer(config, manager, new MockProvider(), undefined, {
      assistantBridge: async (question) => {
        bridgeCalls.push(question);
        return "full bridge answer";
      },
    });
    const { callId } = await manager.initiateCall(opts.to);
    const call = manager.getCall(callId)!;
    call.providerCallId = call.providerCallId || "prov-recall";
    return { server, bridgeCalls, providerCallId: call.providerCallId! };
  };

  const invokeTool = (
    server: VoiceCallWebhookServer,
    providerCallId: string,
    args: Record<string, unknown>,
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).handleCallTool(
      { isResponseActive: () => false },
      providerCallId,
      "ask_assistant",
      args,
    ) as Promise<string>;

  it("answers verified first-party recall from memory without the bridge", async () => {
    const { server, bridgeCalls, providerCallId } = await makeServer({
      to: OWNER,
      workspaceDir: makeWorkspace(),
    });
    const result = await invokeTool(server, providerCallId, { question: "what is buddy's phone" });
    expect(result).toContain("Quick memory lookup");
    expect(result).toContain("+15550001111");
    expect(bridgeCalls).toEqual([]);
  });

  it("escalate:true skips fast recall and uses the full bridge", async () => {
    const { server, bridgeCalls, providerCallId } = await makeServer({
      to: OWNER,
      workspaceDir: makeWorkspace(),
    });
    const result = await invokeTool(server, providerCallId, {
      question: "what is buddy's phone",
      escalate: true,
    });
    expect(result).toBe("full bridge answer");
    expect(bridgeCalls.length).toBe(1);
  });

  it("falls through to the bridge on a recall miss", async () => {
    const { server, bridgeCalls, providerCallId } = await makeServer({
      to: OWNER,
      workspaceDir: makeWorkspace(),
    });
    const result = await invokeTool(server, providerCallId, {
      question: "zzzqqq nothing matches this",
    });
    expect(result).toBe("full bridge answer");
    expect(bridgeCalls.length).toBe(1);
  });

  it("never offers fast recall to unverified calls", async () => {
    const { server, bridgeCalls, providerCallId } = await makeServer({
      to: OTHER,
      workspaceDir: makeWorkspace(),
    });
    const result = await invokeTool(server, providerCallId, { question: "what is buddy's phone" });
    expect(result).toBe("full bridge answer");
    expect(bridgeCalls.length).toBe(1);
  });
});
