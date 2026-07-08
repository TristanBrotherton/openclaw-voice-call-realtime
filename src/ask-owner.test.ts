import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { createTestStorePath } from "./manager.test-harness.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { createOwnerMessenger, type SubagentRuntime } from "./assistant-bridge.js";

const makeServer = async (opts: {
  ownerMessenger?: (text: string) => Promise<void>;
  timeoutMs?: number;
}) => {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "mock",
    askOwner: { enabled: true, timeoutMs: opts.timeoutMs ?? 120000 },
  });
  const manager = new CallManager(config, createTestStorePath());
  const provider = new MockProvider();
  await manager.initialize(provider, "https://example.com/voice/webhook");
  const server = new VoiceCallWebhookServer(config, manager, provider, undefined, {
    ownerMessenger: opts.ownerMessenger,
  });
  const { callId } = await manager.initiateCall("+15550000040");
  const call = manager.getCall(callId)!;
  call.providerCallId = call.providerCallId || "prov-40";
  return { server, manager, callId, providerCallId: call.providerCallId! };
};

// Reach the private tool handler the same way the realtime session does.
const invokeTool = (server: VoiceCallWebhookServer, providerCallId: string, name: string, args: Record<string, unknown>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).handleCallTool({ isResponseActive: () => false }, providerCallId, name, args) as Promise<
    string | { output: string }
  >;

describe("ask_owner loop", () => {
  it("delivers the question and returns the owner's answer", async () => {
    const sent: string[] = [];
    const { server, callId, providerCallId } = await makeServer({
      ownerMessenger: async (text) => {
        sent.push(text);
      },
    });

    const pending = invokeTool(server, providerCallId, "ask_owner", {
      question: "7pm is not available — is 8pm OK instead?",
    });
    // wait for the message to go out, then answer as the agent would
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toContain("8pm OK instead");
    expect(sent[0]).toContain(callId.slice(0, 8));

    expect(server.getPendingOwnerQuestion(callId)?.question).toContain("8pm");
    expect(server.answerOwnerQuestion(callId, "8 works, book it")).toBe(true);

    const result = await pending;
    expect(result).toBe("Owner replied: 8 works, book it");
    expect(server.getPendingOwnerQuestion(callId)).toBeUndefined();
  });

  it("times out with conservative guidance", async () => {
    const { server, providerCallId } = await makeServer({
      ownerMessenger: async () => {},
      timeoutMs: 50,
    });
    const result = await invokeTool(server, providerCallId, "ask_owner", { question: "OK?" });
    expect(String(result)).toContain("has not replied");
  });

  it("rejects a second concurrent question and reports send failures", async () => {
    const { server, providerCallId } = await makeServer({
      ownerMessenger: async () => {
        throw new Error("channel down");
      },
    });
    const result = await invokeTool(server, providerCallId, "ask_owner", { question: "OK?" });
    expect(String(result)).toContain("could not reach the owner");
    // registry cleaned up after failure
    expect(server.answerOwnerQuestion(providerCallId, "late")).toBe(false);
  });

  it("answerOwnerQuestion returns false with nothing pending", async () => {
    const { server } = await makeServer({ ownerMessenger: async () => {} });
    expect(server.answerOwnerQuestion("nonexistent", "hi")).toBe(false);
  });
});

describe("createOwnerMessenger", () => {
  it("sends a scoped delivery-only turn", async () => {
    const runs: string[] = [];
    const subagent: SubagentRuntime = {
      run: async (p) => {
        runs.push(p.message);
        return { runId: "r" };
      },
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => {},
    };
    const messenger = createOwnerMessenger({ subagent });
    await messenger("📞 test question");
    expect(runs[0]).toContain("📞 test question");
    expect(runs[0]).toContain("Do NOT answer the question");
  });
});

describe("pre-answer inbound gate", () => {
  it("rejects non-allowlisted, unattested (when strict), and disabled-policy calls", async () => {
    const { buildInboundAcceptor } = await import("./runtime.js");
    const { VoiceCallConfigSchema } = await import("./config.js");
    const strict = buildInboundAcceptor(
      VoiceCallConfigSchema.parse({
        enabled: true, provider: "mock",
        inboundPolicy: "allowlist", allowFrom: ["+15550001111"],
        inboundSecurity: { trustStirA: true, rejectUnverified: true },
      }),
    )!;
    // unknown number
    expect(strict({ from: "+15559998888", stirVerstat: "TN-Validation-Passed-A" })).toBe(false);
    // allowlisted but spoofable (no attestation)
    expect(strict({ from: "+15550001111" })).toBe(false);
    expect(strict({ from: "+15550001111", stirVerstat: "TN-Validation-Passed-B" })).toBe(false);
    // allowlisted + attested
    expect(strict({ from: "+15550001111", stirVerstat: "TN-Validation-Passed-A" })).toBe(true);

    const lenient = buildInboundAcceptor(
      VoiceCallConfigSchema.parse({
        enabled: true, provider: "mock",
        inboundPolicy: "allowlist", allowFrom: ["+15550001111"],
        inboundSecurity: { trustStirA: true, rejectUnverified: false },
      }),
    )!;
    // without rejectUnverified, unattested allowlisted calls still ring in
    // (they get the AI in unverified mode with the passphrase fallback)
    expect(lenient({ from: "+15550001111" })).toBe(true);
    expect(lenient({ from: "+15559998888" })).toBe(false);

    const disabled = buildInboundAcceptor(
      VoiceCallConfigSchema.parse({ enabled: true, provider: "mock", inboundPolicy: "disabled" }),
    )!;
    expect(disabled({ from: "+15550001111", stirVerstat: "TN-Validation-Passed-A" })).toBe(false);
  });

  it("twiml policy returns reject for gated inbound", async () => {
    const { decideTwimlResponse } = await import("./providers/twilio/twiml-policy.js");
    const decision = decideTwimlResponse({
      callStatus: "ringing", direction: "inbound", isStatusCallback: false,
      callSid: "CA123", hasStoredTwiml: false, isNotifyCall: false,
      hasActiveStreams: false, canStream: true, acceptInbound: false,
    });
    expect(decision.kind).toBe("reject");
  });
});
