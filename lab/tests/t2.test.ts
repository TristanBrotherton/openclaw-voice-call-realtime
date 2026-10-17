import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeMulaw, FRAME_MS, FRAME_SAMPLES, rmsDbfs } from "../harness/audio.ts";
import { tone } from "../harness/fixtures.ts";
import type { RenderedStep } from "../harness/render.ts";
import { type Scenario, type Step, validateScenario } from "../harness/scenario.ts";
import { maskNumber } from "../t2/boot-real.ts";
import { decideFront, PartyServer, PartySession, writePartyOutputs, type Armed, type PartyResult } from "../t2/party-server.ts";
import { parseTunnelUrl } from "../t2/tunnel.ts";

const TOKEN = "test-auth-token";
const OURS = "+15555550100";
const STRANGER = "+15555550177";
const FRONT = "https://lab-b.trycloudflare.com/front";
const LIVE = "https://live.example.com/voice/webhook?x=1&y=2";

function sign(url: string, params: URLSearchParams, token = TOKEN): string {
  const data = url + [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + v).join("");
  return crypto.createHmac("sha1", token).update(data).digest("base64");
}

const params = (from: string) => new URLSearchParams({ CallSid: "CA" + "0".repeat(32), From: from, To: OURS });
const armed = (over: Partial<Armed> = {}): Armed => ({ scenarioId: "oh-x", token: "tok", expiresAt: 10_000, used: false, ...over });

function decide(from: string, a: Armed | null, opts: { now?: number; sig?: string; liveUrl?: string | null } = {}) {
  const p = params(from);
  return decideFront({
    authToken: TOKEN,
    frontUrl: FRONT,
    signature: opts.sig ?? sign(FRONT, p),
    params: p,
    ourNumber: OURS,
    armed: a,
    now: opts.now ?? 1000,
    liveUrl: opts.liveUrl === undefined ? LIVE : opts.liveUrl,
    partyStreamUrl: "wss://lab-b.trycloudflare.com/party",
  });
}

describe("front door decision", () => {
  it("armed lab call from our number with a valid signature -> party stream, once", () => {
    const a = armed();
    const d = decide(OURS, a);
    expect(d.kind).toBe("stream");
    expect(d.body).toContain('<Stream url="wss://lab-b.trycloudflare.com/party">');
    expect(d.body).toContain('<Parameter name="scenario" value="oh-x"/>');
    expect(d.body).toContain('<Parameter name="token" value="tok"/>');
    expect(a.used).toBe(true);
    expect(decide(OURS, a).kind).toBe("redirect");
  });

  it("invalid or missing signature -> 403 (Twilio falls back to the live URL)", () => {
    expect(decide(OURS, armed(), { sig: "nope" }).status).toBe(403);
    const p = params(OURS);
    expect(decide(OURS, armed(), { sig: sign(FRONT, p, "other-token") }).kind).toBe("forbidden");
  });

  it("expired arm -> redirect to live", () => {
    const d = decide(OURS, armed({ expiresAt: 500 }), { now: 1000 });
    expect(d.kind).toBe("redirect");
    expect(d.log).toContain("arm expired");
  });

  it("non-lab caller -> redirect to live, even while armed; URL escaped; no number in the log", () => {
    const a = armed();
    const d = decide(STRANGER, a);
    expect(d.kind).toBe("redirect");
    expect(d.body).toContain('<Redirect method="POST">https://live.example.com/voice/webhook?x=1&amp;y=2</Redirect>');
    expect(a.used).toBe(false);
    expect(d.log).not.toContain(STRANGER);
    expect(d.log).toContain(maskNumber(STRANGER));
  });

  it("no live URL known -> 503 so Twilio uses the fallback", () => {
    expect(decide(STRANGER, null, { liveUrl: null }).status).toBe(503);
  });
});

function scenario(steps: Step[], limits?: Scenario["limits"]): Scenario {
  const s: Scenario = { id: "oh-x", class: "test", direction: "outbound", call: {}, steps, ...(limits ? { limits } : {}) };
  steps.forEach((st, i) => (st.id ??= `s${i + 1}`));
  validateScenario(s);
  return s;
}
const clip = (ms: number): RenderedStep => ({ pcm: tone([300], ms, 0.2), durationMs: ms, speech: { start_ms: 0, end_ms: ms } });
const botFrame = (loud: boolean) =>
  encodeMulaw(loud ? tone([440], FRAME_MS, 0.3) : new Int16Array(FRAME_SAMPLES)).toString("base64");

describe("party media stream session", () => {
  it("one party frame per inbound frame; party speaks, then hangs up the leg", async () => {
    const sent: any[] = [];
    const hung: string[] = [];
    let result: PartyResult | null = null;
    const sc = scenario([{ say: "hello", gate: { at_ms: 40 } }, { hangup: true }]);
    const s = new PartySession({
      scenario: sc,
      rendered: [clip(100), { pcm: new Int16Array(0), durationMs: 0 }],
      send: (m) => sent.push(JSON.parse(m)),
      hangupLeg: async (sid) => {
        hung.push(sid);
      },
      onEnd: (r) => (result = r),
      now: () => 5000,
    });
    s.handle({ event: "connected" });
    s.handle({ event: "start", start: { streamSid: "MZ1", callSid: "CA" + "1".repeat(32), customParameters: {} } });
    // 2 frames in one message (Twilio may batch) + single frames
    s.handle({ event: "media", media: { track: "inbound", payload: Buffer.concat([Buffer.from(botFrame(true), "base64"), Buffer.from(botFrame(false), "base64")]).toString("base64") } });
    for (let i = 0; i < 20; i++) s.handle({ event: "media", media: { track: "inbound", payload: botFrame(false) } });
    expect(hung).toEqual(["CA" + "1".repeat(32)]);
    expect(s.endedBy).toBe("party");
    const n = sent.length;
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThan(22); // stops ticking after the hangup
    expect(sent.every((m) => m.event === "media" && m.streamSid === "MZ1" && Buffer.from(m.media.payload, "base64").length === FRAME_SAMPLES)).toBe(true);
    s.handle({ event: "stop" });
    s.handle({ event: "stop" });
    const r = result as PartyResult | null;
    expect(r).not.toBeNull();
    expect(r!.t0).toBe(5000);
    expect(r!.left.length).toBe(n * FRAME_SAMPLES);
    expect(r!.right.length).toBe(n * FRAME_SAMPLES);
    expect(rmsDbfs(r!.right, 0, FRAME_SAMPLES)).toBeGreaterThan(-20); // bot heard in frame 0
    expect(rmsDbfs(r!.left, 2 * FRAME_SAMPLES, 3 * FRAME_SAMPLES)).toBeGreaterThan(-30); // party speaks from 40 ms
    const types = r!.events.map((e) => e.type);
    expect(types).toContain("step_start");
    expect(types).toContain("party_hangup");
    expect(types.filter((t) => t === "stream_stop")).toHaveLength(1);
  });

  it("ends at max duration and hangs up the leg", () => {
    const hung: string[] = [];
    const s = new PartySession({
      scenario: scenario([{ wait_silence: 60000 }], { max_duration_ms: 200 }),
      rendered: [{ pcm: new Int16Array(0), durationMs: 60000 }],
      send: () => {},
      hangupLeg: async (sid) => {
        hung.push(sid);
      },
      onEnd: () => {},
    });
    s.handle({ event: "start", start: { streamSid: "MZ1", callSid: "CA" + "2".repeat(32) } });
    for (let i = 0; i < 30; i++) s.handle({ event: "media", media: { payload: botFrame(false) } });
    expect(s.endedBy).toBe("max_duration");
    expect(hung).toHaveLength(1);
  });

  it("writes a stereo 8 kHz WAV: left = party, right = bot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-wav-"));
    const left = new Int16Array([1, 2, 3]);
    const right = new Int16Array([-1, -2, -3]);
    writePartyOutputs(dir, { scenarioId: "x", callSid: null, endedBy: "party", t0: 0, durationMs: 0, events: [{ t_ms: 0, type: "answered" }], left, right });
    const b = fs.readFileSync(path.join(dir, "recording.wav"));
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.readUInt16LE(22)).toBe(2);
    expect(b.readUInt32LE(24)).toBe(8000);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.readUInt32LE(40)).toBe(12);
    expect([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48), b.readInt16LE(50)]).toEqual([1, -1, 2, -2]);
    expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim()).toBe('{"t_ms":0,"type":"answered"}');
    fs.rmSync(dir, { recursive: true });
  });
});

describe("party server (localhost)", () => {
  let srv: PartyServer | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it("signed front-door POST -> stream TwiML; the stream with its token runs the party", async () => {
    const hung: string[] = [];
    srv = new PartyServer({ creds: { accountSid: "AC0", authToken: TOKEN }, ourNumber: OURS, log: () => {}, hangupLeg: async (s) => void hung.push(s) });
    const port = await srv.listen(0);
    const base = `http://127.0.0.1:${port}`;
    srv.setPublicBase(base);
    srv.setLiveUrl(LIVE);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-srv-"));
    const done = srv.arm({ scenario: scenario([{ say: "hi", gate: { at_ms: 0 } }, { hangup: true }]), rendered: [clip(60), { pcm: new Int16Array(0), durationMs: 0 }], dir });
    const p = params(OURS);
    const res = await fetch(`${base}/front`, { method: "POST", headers: { "X-Twilio-Signature": sign(`${base}/front`, p), "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() });
    const twiml = await res.text();
    expect(twiml).toContain(`<Stream url="ws://127.0.0.1:${port}/party">`);
    const token = twiml.match(/name="token" value="([0-9a-f]+)"/)![1];

    // A stranger's call while the lab call is live goes to the live assistant.
    const q = params(STRANGER);
    const res2 = await fetch(`${base}/front`, { method: "POST", headers: { "X-Twilio-Signature": sign(`${base}/front`, q) }, body: q.toString() });
    expect(await res2.text()).toContain("<Redirect");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/party`);
    const got: any[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ9", callSid: "CA" + "3".repeat(32), customParameters: { scenario: "oh-x", token } } }));
    for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: botFrame(false) } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.streamActive).toBe(true);
    ws.send(JSON.stringify({ event: "stop" }));
    const r = await done;
    ws.close();
    expect(r.endedBy).toBe("party");
    expect(hung).toEqual(["CA" + "3".repeat(32)]);
    expect(got.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "recording.wav"))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it("a stream without the armed token is closed", async () => {
    srv = new PartyServer({ creds: { accountSid: "AC0", authToken: TOKEN }, ourNumber: OURS, log: () => {}, hangupLeg: async () => {} });
    const port = await srv.listen(0);
    srv.setPublicBase(`http://127.0.0.1:${port}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/party`);
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise((r) => ws.once("close", r));
    ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ9", callSid: "CA" + "4".repeat(32), customParameters: { scenario: "oh-x", token: "guess" } } }));
    await closed;
    expect(srv.streamActive).toBe(false);
  });
});

describe("tunnel", () => {
  it("parses the quick-tunnel URL from cloudflared output", () => {
    const log = "2026-10-16T10:00:00Z INF |  https://some-words-here-1234.trycloudflare.com                |\n";
    expect(parseTunnelUrl(log)).toBe("https://some-words-here-1234.trycloudflare.com");
    expect(parseTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
  });
});
