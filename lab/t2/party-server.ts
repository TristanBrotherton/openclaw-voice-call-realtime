/**
 * T2 party server (port B, behind tunnel B):
 *
 *   POST /front   the number's voice webhook during a run. A signed call from
 *                 our own number while a lab call is armed gets the party
 *                 stream; anything else is redirected to the live webhook.
 *   WS   /party   Twilio bidirectional Media Stream: runs the PartyEngine on
 *                 the bot's audio and streams the party's audio back.
 *   GET  /healthz
 *
 * Recording: stereo 8 kHz WAV, left = party (sent), right = bot (received),
 * plus events.jsonl, in the armed scenario's directory.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { validateTwilioSignature } from "../../src/webhook-security.js";
import { decodeMulaw, encodeMulaw, FRAME_MS, FRAME_SAMPLES, stereoWav } from "../harness/audio.ts";
import { dtmfTones } from "../harness/fixtures.ts";
import { PartyEngine, type PartyEvent } from "../harness/party.ts";
import type { RenderedStep } from "../harness/render.ts";
import type { Scenario } from "../harness/scenario.ts";
import { maskNumber, maskUrl } from "./boot-real.ts";
import type { TwilioCreds } from "./number.ts";

export const ARM_TTL_MS = 60000;

// --- front door decision ----------------------------------------------------------

export type Armed = {
  scenarioId: string;
  token: string;
  expiresAt: number;
  used: boolean;
};

export type FrontDecision = {
  kind: "stream" | "redirect" | "forbidden" | "unavailable";
  status: number;
  body: string;
  /** Log line (numbers masked). */
  log: string;
};

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function streamTwiml(streamUrl: string, params: Record<string, string>): string {
  const p = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(streamUrl)}">${p}</Stream></Connect></Response>`;
}

export function redirectTwiml(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${xmlEscape(url)}</Redirect></Response>`;
}

/**
 * Decide what a POST to the front door gets. Pure; marks `armed.used` when
 * it hands out the party stream.
 */
export function decideFront(input: {
  authToken: string;
  /** Exact public URL Twilio posted to (signature base). */
  frontUrl: string;
  signature: string | undefined;
  params: URLSearchParams;
  ourNumber: string;
  armed: Armed | null;
  now: number;
  liveUrl: string | null;
  partyStreamUrl: string;
}): FrontDecision {
  const from = input.params.get("From") ?? "";
  const who = `from=${maskNumber(from)}`;
  if (!validateTwilioSignature(input.authToken, input.signature, input.frontUrl, input.params)) {
    // A non-2xx makes Twilio use the number's fallback URL (the live webhook).
    return { kind: "forbidden", status: 403, body: "Forbidden", log: `front: bad signature (${who}) -> 403` };
  }
  const a = input.armed;
  const isUs = from === input.ourNumber;
  if (isUs && a && !a.used && input.now < a.expiresAt) {
    a.used = true;
    return {
      kind: "stream",
      status: 200,
      body: streamTwiml(input.partyStreamUrl, { scenario: a.scenarioId, token: a.token }),
      log: `front: lab call (${who}, scenario=${a.scenarioId}) -> party stream`,
    };
  }
  const why = !isUs ? "not a lab caller" : !a ? "no lab call armed" : a.used ? "armed call already answered" : "arm expired";
  if (!input.liveUrl) {
    return { kind: "unavailable", status: 503, body: "Unavailable", log: `front: ${why} (${who}), live URL unknown -> 503 (Twilio fallback)` };
  }
  return {
    kind: "redirect",
    status: 200,
    body: redirectTwiml(input.liveUrl),
    log: `front: ${why} (${who}) -> redirect to live ${maskUrl(input.liveUrl)}`,
  };
}

// --- media stream session -----------------------------------------------------------

export type PartyResult = {
  scenarioId: string;
  callSid: string | null;
  endedBy: string;
  /** Epoch ms of the stream `start` (t = 0). */
  t0: number;
  durationMs: number;
  events: PartyEvent[];
  left: Int16Array;
  right: Int16Array;
};

function concat(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * One Twilio media stream driving the PartyEngine. Paced by Twilio: every
 * inbound 20 ms frame (what the bot says) is one engine tick, and one party
 * frame goes back.
 */
export class PartySession {
  private engine: PartyEngine;
  private readonly events: PartyEvent[] = [];
  private readonly left: Int16Array[] = [];
  private readonly right: Int16Array[] = [];
  private inbound = Buffer.alloc(0);
  private dtmfQueue: Int16Array | null = null;
  private dtmfPos = 0;
  private k = 0;
  private streamSid = "";
  private partyDoneAt: number | null = null;
  callSid: string | null = null;
  t0 = 0;
  endedBy = "";
  private finished = false;

  constructor(
    private readonly p: {
      scenario: Scenario;
      rendered: RenderedStep[];
      send: (msg: string) => void;
      hangupLeg: (callSid: string) => Promise<void>;
      onEnd: (r: PartyResult) => void;
      now?: () => number;
      log?: (msg: string) => void;
    },
  ) {
    this.engine = new PartyEngine(p.scenario, p.rendered, { onEvent: (ev) => this.events.push(ev) });
  }

  private get t(): number {
    return this.k * FRAME_MS;
  }

  private ev(e: Omit<PartyEvent, "t_ms"> & { t_ms?: number }): void {
    this.events.push({ t_ms: this.t, ...e } as PartyEvent);
  }

  handle(msg: Record<string, any>): void {
    switch (msg.event) {
      case "start": {
        this.t0 = (this.p.now ?? Date.now)();
        this.streamSid = msg.start?.streamSid ?? msg.streamSid ?? "";
        this.callSid = msg.start?.callSid ?? null;
        this.ev({ t_ms: 0, type: "answered", direction: "outbound" });
        this.ev({ t_ms: 0, type: "stream_start" });
        break;
      }
      case "media": {
        if (this.endedBy || !this.streamSid) return;
        if (msg.media?.track && msg.media.track !== "inbound") return;
        this.inbound = Buffer.concat([this.inbound, Buffer.from(msg.media?.payload ?? "", "base64")]);
        while (this.inbound.length >= FRAME_SAMPLES && !this.endedBy) {
          const frame = this.inbound.subarray(0, FRAME_SAMPLES);
          this.inbound = this.inbound.subarray(FRAME_SAMPLES);
          this.tickFrame(frame);
        }
        break;
      }
      case "dtmf": {
        // Twilio reports keys as events (and may strip them from the audio);
        // feed the tones to the engine's detector so on_dtmf gates still work.
        const digit = String(msg.dtmf?.digit ?? "");
        this.ev({ type: "dtmf_twilio", digit });
        if (/^[0-9A-D*#]$/i.test(digit)) {
          this.dtmfQueue = dtmfTones(digit, 120, 80);
          this.dtmfPos = 0;
        }
        break;
      }
      case "mark":
        this.ev({ type: "mark", name: msg.mark?.name });
        break;
      case "stop":
        this.ev({ type: "stream_stop_twilio" });
        this.end(this.endedBy || "stream_stopped");
        break;
    }
  }

  private tickFrame(frame: Uint8Array): void {
    const heard = decodeMulaw(frame);
    let bot = heard;
    if (this.dtmfQueue) {
      bot = heard.slice();
      for (let i = 0; i < FRAME_SAMPLES && this.dtmfPos < this.dtmfQueue.length; i++, this.dtmfPos++) {
        bot[i] = Math.max(-32768, Math.min(32767, bot[i] + this.dtmfQueue[this.dtmfPos]));
      }
      if (this.dtmfPos >= this.dtmfQueue.length) this.dtmfQueue = null;
    }
    const t = this.t;
    const out = encodeMulaw(this.engine.tick(t, bot));
    this.p.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: out.toString("base64") } }));
    this.left.push(decodeMulaw(out));
    this.right.push(heard);
    this.k++;

    const s = this.p.scenario;
    const maxMs = s.limits?.max_duration_ms ?? 120000;
    const idleEnd = s.limits?.idle_end_ms ?? 12000;
    if (this.engine.done && this.partyDoneAt === null) this.partyDoneAt = t;
    let ended = "";
    if (this.engine.hungUp) ended = "party";
    else if (t >= maxMs) ended = "max_duration";
    else if (
      this.partyDoneAt !== null &&
      !this.engine.botIsSpeaking &&
      t - Math.max(this.partyDoneAt, this.engine.botQuietSinceMs ?? 0) >= idleEnd
    )
      ended = "party_idle";
    if (ended) {
      this.endedBy = ended;
      this.ev({ type: "party_hangup_leg", ended_by: ended });
      if (this.callSid) {
        this.p.hangupLeg(this.callSid).catch((err) => this.p.log?.(`party: hangup failed: ${err instanceof Error ? err.message : err}`));
      }
    }
  }

  /** Stream over (Twilio `stop` or socket closed). Idempotent. */
  end(endedBy: string): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.endedBy) this.endedBy = endedBy;
    this.ev({ type: "stream_stop", ended_by: this.endedBy, dropped_ms: 0 });
    this.p.onEnd(this.result());
  }

  result(): PartyResult {
    return {
      scenarioId: this.p.scenario.id,
      callSid: this.callSid,
      endedBy: this.endedBy,
      t0: this.t0,
      durationMs: this.left.length * FRAME_MS,
      events: this.events,
      left: concat(this.left),
      right: concat(this.right),
    };
  }
}

export function writePartyOutputs(dir: string, r: PartyResult): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "recording.wav"), stereoWav(r.left, r.right));
  fs.writeFileSync(path.join(dir, "events.jsonl"), r.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// --- server ------------------------------------------------------------------------------

export async function twilioHangupLeg(c: TwilioCreds, callSid: string): Promise<void> {
  if (!/^CA[0-9a-f]{32}$/.test(callSid)) throw new Error("bad call sid");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "completed" }).toString(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Twilio hangup -> ${res.status}`);
}

type ArmState = Armed & {
  scenario: Scenario;
  rendered: RenderedStep[];
  dir: string;
  resolve: (r: PartyResult) => void;
};

export class PartyServer {
  private server: http.Server;
  private wss = new WebSocketServer({ noServer: true });
  private armed: ArmState | null = null;
  private publicBase: string | null = null;
  private liveUrl: string | null = null;
  readonly decisions: FrontDecision[] = [];
  private activeStreams = 0;
  port = 0;

  constructor(
    private readonly opts: {
      creds: TwilioCreds;
      ourNumber: string;
      log?: (msg: string) => void;
      /** Override for tests; default hangs up via Twilio REST. */
      hangupLeg?: (callSid: string) => Promise<void>;
    },
  ) {
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        this.log(`party server error: ${err instanceof Error ? err.message : err}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/party") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.log(`[t2] ${m}`)))(msg);
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    const a = this.server.address();
    this.port = typeof a === "object" && a ? a.port : port;
    return this.port;
  }

  setPublicBase(base: string): void {
    this.publicBase = base.replace(/\/$/, "");
  }
  setLiveUrl(url: string | null): void {
    this.liveUrl = url || null;
  }
  get frontUrl(): string {
    return `${this.publicBase}/front`;
  }
  get partyStreamUrl(): string {
    return `${this.publicBase!.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/party`;
  }

  /** Expect one lab call for this scenario within ARM_TTL_MS; resolves when its stream ends. */
  arm(params: { scenario: Scenario; rendered: RenderedStep[]; dir: string; ttlMs?: number }): Promise<PartyResult> {
    return new Promise((resolve) => {
      this.armed = {
        scenarioId: params.scenario.id,
        token: crypto.randomBytes(16).toString("hex"),
        expiresAt: Date.now() + (params.ttlMs ?? ARM_TTL_MS),
        used: false,
        scenario: params.scenario,
        rendered: params.rendered,
        dir: params.dir,
        resolve,
      };
    });
  }

  /** A party media stream is open. */
  get streamActive(): boolean {
    return this.activeStreams > 0;
  }

  disarm(): void {
    this.armed = null;
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (req.method === "POST" && url.pathname === "/front") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) {
          res.writeHead(413).end();
          return;
        }
      }
      if (!this.publicBase) {
        res.writeHead(503).end();
        return;
      }
      const sig = req.headers["x-twilio-signature"];
      const d = decideFront({
        authToken: this.opts.creds.authToken,
        frontUrl: this.frontUrl + url.search,
        signature: Array.isArray(sig) ? sig[0] : sig,
        params: new URLSearchParams(body),
        ourNumber: this.opts.ourNumber,
        armed: this.armed,
        now: Date.now(),
        liveUrl: this.liveUrl,
        partyStreamUrl: this.partyStreamUrl,
      });
      this.decisions.push(d);
      this.log(d.log);
      res.writeHead(d.status, { "Content-Type": d.status === 200 ? "text/xml" : "text/plain" }).end(d.body);
      return;
    }
    res.writeHead(404).end();
  }

  private onSocket(ws: WebSocket): void {
    let session: PartySession | null = null;
    ws.on("message", (data) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.event === "start" && !session) {
        const params = msg.start?.customParameters ?? {};
        const a = this.armed;
        if (!a || !a.used || params.token !== a.token || params.scenario !== a.scenarioId) {
          this.log("party: stream start without a matching armed call -> closing");
          ws.close();
          return;
        }
        this.armed = null;
        this.activeStreams++;
        const hangupLeg = this.opts.hangupLeg ?? ((sid: string) => twilioHangupLeg(this.opts.creds, sid));
        session = new PartySession({
          scenario: a.scenario,
          rendered: a.rendered,
          send: (m) => {
            if (ws.readyState === ws.OPEN) ws.send(m);
          },
          hangupLeg,
          log: (m) => this.log(m),
          onEnd: (r) => {
            try {
              writePartyOutputs(a.dir, r);
            } catch (err) {
              this.log(`party: write failed: ${err instanceof Error ? err.message : err}`);
            }
            a.resolve(r);
          },
        });
        this.log(`party: stream started (scenario=${a.scenarioId})`);
      }
      session?.handle(msg);
    });
    ws.on("close", () => {
      if (session) this.activeStreams--;
      session?.end("stream_closed");
    });
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
