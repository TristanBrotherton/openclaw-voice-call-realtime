import { describe, expect, it, vi } from "vitest";
import { VoiceBridgeClient, parseTaskResult, phoneSessionKey } from "./voice-bridge-client.js";

function client(handler: (body: any) => { status: number; json: unknown }) {
  const calls: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { c: new VoiceBridgeClient({ url: "http://127.0.0.1:3338", askPath: "/ask-x", fetchImpl }), calls };
}

describe("VoiceBridgeClient", () => {
  it("session keys match the bridge's accepted shape", () => {
    const key = phoneSessionKey("explain", "ddc83e8d-aa52-491b-90a0-189c165a3dca");
    expect(key).toMatch(/^voicepe-[A-Za-z0-9_-]{1,112}$/);
  });

  it("starts an explain task with the server-side brief and a callback", async () => {
    const { c, calls } = client(() => ({ status: 200, json: { accepted: true, task_id: "t1", eta_s: 180 } }));
    const r = await c.explain({
      question: "How does our voice bridge work?",
      sessionKey: "voicepe-phone-explain-1",
      requestId: "t1",
      callbackUrl: "http://127.0.0.1:3336/voice/task-result",
      callbackToken: "tok",
    });
    expect(r).toEqual({ accepted: true, taskId: "t1", etaS: 180 });
    expect(calls[0]).toMatchObject({ mode: "explain", brief: "server", callback_token: "tok", request_id: "t1" });
  });

  it("reports busy and errors", async () => {
    const busy = client(() => ({ status: 409, json: { error: "busy" } }));
    expect((await busy.c.explain({ question: "q", sessionKey: "k", requestId: "r", callbackUrl: "u", callbackToken: "t" })).accepted).toBe(false);
    const off = client(() => ({ status: 403, json: {} }));
    expect(await off.c.discuss("list")).toMatchObject({ error: expect.stringContaining("not switched on") });
  });

  it("passes discussion actions through", async () => {
    const { c, calls } = client(() => ({ status: 200, json: { ok: true, staged: true } }));
    expect(await c.discuss("stage", { item: "vb-4", decision: "Ship it" })).toMatchObject({ staged: true });
    expect(calls[0]).toEqual({ discuss: { action: "stage", item: "vb-4", decision: "Ship it" } });
  });

  it("parses task results", () => {
    expect(parseTaskResult({ task_id: "t", ok: true, spoken: "S", text: "T" })).toEqual({ taskId: "t", ok: true, spoken: "S", text: "T" });
    expect(parseTaskResult({ ok: true })).toBeNull();
  });
});
