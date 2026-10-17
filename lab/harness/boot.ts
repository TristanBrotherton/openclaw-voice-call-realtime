/**
 * Boot the real plugin in-process for T1: real webhook server, media-stream
 * handler, call manager and voice model; a lab provider in place of Twilio
 * (it never dials anything); stubbed assistant bridge, owner messenger and
 * post-call reporter (no real messages, ever).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { VoiceCallConfigSchema, resolveVoiceCallConfig, type VoiceCallConfig } from "../../src/config.js";
import { CallManager } from "../../src/manager.js";
import type { VoiceCallProvider } from "../../src/providers/base.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  WebhookVerificationResult,
} from "../../src/types.js";
import { VoiceCallWebhookServer } from "../../src/webhook.js";
import type { CallReport } from "../../src/assistant-bridge.js";

export const STATE_DIR = process.env.VOICE_CALL_LAB_STATE || path.join(os.homedir(), ".local", "state", "voice-call-lab");
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const LIVE_ENTRY = "voice-call-tristan";

/** Fictional numbers (555-01xx is reserved for fiction). The lab dials nothing. */
export const LAB_NUMBERS = {
  plugin: "+15555550100",
  owner: "+15555550142",
  trusted: "+15555550143",
  unknown: "+15555550177",
  business: "+15555550188",
} as const;

type LiveConfig = Record<string, any>;

export function readLiveEntry(): LiveConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8"));
    return c?.plugins?.entries?.[LIVE_ENTRY]?.config ?? null;
  } catch {
    return null;
  }
}

/** The OpenAI key, read at runtime from the live plugin config (never printed). */
export function readOpenAiKey(): string {
  const key = readLiveEntry()?.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`No OpenAI key at plugins.entries["${LIVE_ENTRY}"].config.streaming.openaiApiKey`);
  return key;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export type BootOptions = {
  runtime?: string;
  model: string;
  voice: string;
  /** "live": copy behaviour settings (persona, turn detection, greeting, screening) from the live config. */
  profile: "live" | "generic";
  persona?: string;
  storeDir: string;
  apiKey: string;
  /** Use the real Voice PE bridge for owner tools (explain, discussions, owner questions). */
  realBridge?: boolean;
};

const REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

const GENERIC_PERSONA =
  "You are a capable, polite personal assistant making and taking phone calls for the person you work for, Sam. " +
  "Be brief and natural; one short turn at a time.";

/** The lab's raw (unparsed) plugin config; T2 overrides the provider parts. */
export function buildLabRawConfig(opts: BootOptions & { port: number }): { raw: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const live = opts.profile === "live" ? readLiveEntry() : null;
  if (opts.profile === "live" && !live) notes.push("live profile unavailable; using generic settings");
  const ls = live?.streaming ?? {};
  const streaming: Record<string, unknown> = {
    enabled: true,
    sttProvider: "openai-realtime-conversation",
    openaiApiKey: opts.apiKey,
    realtimeModel: opts.model,
    // GPT-Live voices (e.g. vesper) are not Realtime voices: keep a valid
    // Realtime voice for the fallback and pass the Live voice in streaming.live.
    realtimeVoice: REALTIME_VOICES.includes(opts.voice) ? opts.voice : (ls.realtimeVoice ?? "marin"),
    realtimeSystemPrompt: opts.persona ?? ls.realtimeSystemPrompt ?? GENERIC_PERSONA,
    turnDetection: ls.turnDetection ?? "semantic_vad",
    ...(ls.vadEagerness ? { vadEagerness: ls.vadEagerness } : {}),
    ...(ls.language ? { language: ls.language } : { language: "en" }),
    ...(ls.silenceDurationMs ? { silenceDurationMs: ls.silenceDurationMs } : {}),
    ...(ls.vadThreshold ? { vadThreshold: ls.vadThreshold } : {}),
    realtimePolicy: { ...(ls.realtimePolicy ?? {}) },
    streamPath: "/voice/stream",
    disconnectGraceMs: 0,
  };
  const raw: Record<string, unknown> = {
    enabled: true,
    provider: "mock",
    fromNumber: LAB_NUMBERS.plugin,
    toNumber: LAB_NUMBERS.owner,
    inboundPolicy: "allowlist",
    allowFrom: [LAB_NUMBERS.owner, LAB_NUMBERS.trusted, LAB_NUMBERS.unknown],
    ...(live?.inboundGreeting ? { inboundGreeting: live.inboundGreeting } : {}),
    inboundSecurity: { trustStirA: true, rejectUnverified: false },
    serve: { port: opts.port, bind: "127.0.0.1", path: "/voice/webhook" },
    outbound: { defaultMode: "conversation" },
    streaming,
    maxDurationSeconds: 600,
    logTranscripts: true,
    store: opts.storeDir,
    callScreening: live?.callScreening ?? { enabled: true, callerIdentity: "Hi, this is Sam's assistant calling." },
    amd: { enabled: true, onMachine: live?.amd?.onMachine ?? "leave-message" },
    askOwner: { enabled: true, timeoutMs: 60000 },
    assistantBridge: {
      enabled: true,
      timeoutMs: 60000,
      trustedNumbers: [LAB_NUMBERS.trusted],
      ownerActions: "full",
      fastRecall: { enabled: false },
    },
    postCallReport: { enabled: true },
    ...(opts.realBridge
      ? {
          voiceBridge: {
            enabled: true,
            url: "http://127.0.0.1:3338",
            askPathFile: path.join(os.homedir(), "development/voice-pe/voice-pe-bridge/.ask-path"),
          },
        }
      : {}),
    // Exercise the plugin's own recorder too (lab state dir, never the repo).
    recording: { enabled: true },
  };
  if (opts.runtime) {
    const withRuntime = {
      ...raw,
      streaming: {
        ...streaming,
        runtime: opts.runtime,
        ...(opts.runtime === "live" ? { live: { ...(ls.live ?? {}), voice: opts.voice } } : {}),
      },
    };
    if (VoiceCallConfigSchema.safeParse(withRuntime).success) {
      raw.streaming = withRuntime.streaming;
    } else {
      notes.push(`streaming.runtime="${opts.runtime}" not accepted by this plugin build; ignored`);
    }
  }
  return { raw, notes };
}

export function buildLabConfig(opts: BootOptions & { port: number }): { config: VoiceCallConfig; notes: string[] } {
  const { raw, notes } = buildLabRawConfig(opts);
  const config = resolveVoiceCallConfig(VoiceCallConfigSchema.parse(raw));
  return { config, notes };
}

/** Provider stand-in: accepts streams, never dials, turns hangups into harness callbacks. */
export class LabProvider implements VoiceCallProvider {
  readonly name = "mock" as const;
  onHangup: ((providerCallId: string, reason: string) => void) | null = null;
  readonly calls: Array<{ op: string; at: number; detail?: unknown }> = [];

  verifyWebhook(): WebhookVerificationResult {
    return { ok: false, reason: "lab provider accepts no HTTP webhooks" };
  }
  parseWebhookEvent(): ProviderWebhookParseResult {
    return { events: [], statusCode: 404 };
  }
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (!Object.values(LAB_NUMBERS).includes(input.to as never)) {
      throw new Error(`lab provider refuses non-lab destination`);
    }
    this.calls.push({ op: "initiateCall", at: Date.now() });
    return { providerCallId: `CA${crypto.randomBytes(16).toString("hex")}`, status: "initiated" };
  }
  async hangupCall(input: HangupCallInput): Promise<void> {
    this.calls.push({ op: "hangupCall", at: Date.now(), detail: input.reason });
    console.log(`[lab-provider] hangupCall ${input.providerCallId} (${input.reason})`);
    this.onHangup?.(input.providerCallId, input.reason);
  }
  async playTts(input: PlayTtsInput): Promise<void> {
    this.calls.push({ op: "playTts", at: Date.now() });
    console.log(`[lab-provider] playTts requested (${input.text.length} chars) — not supported in lab`);
  }
  async playTtsFallback(input: PlayTtsInput): Promise<boolean> {
    this.calls.push({ op: "playTtsFallback", at: Date.now() });
    console.log(`[lab-provider] playTtsFallback requested (${input.text.length} chars) — not supported in lab`);
    return false;
  }
  async startListening(): Promise<void> {}
  async stopListening(): Promise<void> {}
  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return { status: "in-progress", isTerminal: false };
  }
}

/** Captures console output (plugin logs) with timestamps; restores on `restore()`. */
export class ConsoleCapture {
  readonly lines: Array<{ wall: number; level: string; msg: string }> = [];
  private saved: Partial<Record<"log" | "info" | "warn" | "error" | "debug", (...a: unknown[]) => void>> = {};
  constructor(private readonly echo: boolean, private readonly redact: string[] = []) {}

  install(): void {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      this.saved[level] = console[level];
      console[level] = (...args: unknown[]) => {
        let msg = util.format(...args);
        for (const r of this.redact) if (r) msg = msg.split(r).join("<redacted>");
        this.lines.push({ wall: Date.now(), level, msg });
        if (this.echo) process.stderr.write(`  [plugin] ${msg}\n`);
      };
    }
  }
  restore(): void {
    for (const [level, fn] of Object.entries(this.saved)) {
      (console as unknown as Record<string, unknown>)[level] = fn;
    }
  }
  /** Write lines logged at or after `since` (epoch ms), times relative to t0. */
  write(file: string, t0: number, since = 0): void {
    const out = this.lines
      .filter((l) => l.wall >= since)
      .map((l) => `${((l.wall - t0) / 1000).toFixed(3).padStart(9)} ${new Date(l.wall).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`)
      .join("\n");
    fs.writeFileSync(file, out + "\n");
  }
}

export type StubLog = Array<{ wall: number; kind: string; detail: unknown }>;

export type Stubs = {
  assistant?: Array<{ match: string; answer: string; delay_ms?: number }>;
  owner_reply?: { text: string; after_ms?: number };
};

export type LabRuntime = {
  config: VoiceCallConfig;
  manager: CallManager;
  provider: LabProvider;
  webhookServer: VoiceCallWebhookServer;
  port: number;
  streamUrl: string;
  stubLog: StubLog;
  notes: string[];
  /** Set by the harness once the call exists, so the owner-reply stub can answer it. */
  setProviderCallId: (id: string) => void;
  stop: () => Promise<void>;
};

/**
 * Stubbed side effects (no real messages, ever): ask_assistant answers from the
 * scenario, owner messages and post-call reports are only recorded.
 */
export function createStubs(stubs: Stubs | undefined) {
  const stubLog: StubLog = [];
  let providerCallId = "";
  let webhookServer: VoiceCallWebhookServer | null = null;
  const assistantBridge = async (question: string, context: string): Promise<string> => {
    const rule = stubs?.assistant?.find((r) => new RegExp(r.match, "i").test(question));
    stubLog.push({ wall: Date.now(), kind: "ask_assistant", detail: { question, context, matched: rule?.match ?? null } });
    if (rule?.delay_ms) await new Promise((r) => setTimeout(r, rule.delay_ms));
    return rule?.answer ?? "I don't have that information right now.";
  };
  const ownerMessenger = async (text: string): Promise<void> => {
    stubLog.push({ wall: Date.now(), kind: "owner_message", detail: { text } });
    const reply = stubs?.owner_reply;
    if (reply) {
      setTimeout(() => {
        const ok = webhookServer?.answerOwnerQuestion(providerCallId, reply.text) ?? false;
        stubLog.push({ wall: Date.now(), kind: "owner_reply", detail: { text: reply.text, delivered: ok } });
      }, reply.after_ms ?? 5000).unref?.();
    }
  };
  const postCallReporter = async (report: CallReport): Promise<void> => {
    stubLog.push({ wall: Date.now(), kind: "post_call_report", detail: report });
  };
  return {
    stubLog,
    assistantBridge,
    ownerMessenger,
    postCallReporter,
    attach: (server: VoiceCallWebhookServer) => {
      webhookServer = server;
    },
    setProviderCallId: (id: string) => {
      providerCallId = id;
    },
  };
}

export async function bootPlugin(opts: BootOptions & { stubs?: Stubs }): Promise<LabRuntime> {
  const port = await freePort();
  const { config, notes } = buildLabConfig({ ...opts, port });
  fs.mkdirSync(opts.storeDir, { recursive: true });
  const stubs = createStubs(opts.stubs);

  const provider = new LabProvider();
  const manager = new CallManager(config);
  manager.setPostCallReporter(stubs.postCallReporter);
  const server = new VoiceCallWebhookServer(config, manager, provider, {}, {
    assistantBridge: stubs.assistantBridge,
    ownerMessenger: stubs.ownerMessenger,
  });
  stubs.attach(server);
  const url = await server.start();
  await manager.initialize(provider, url);
  return {
    config,
    manager,
    provider,
    webhookServer: server,
    port,
    streamUrl: `ws://127.0.0.1:${port}/voice/stream`,
    stubLog: stubs.stubLog,
    notes,
    setProviderCallId: stubs.setProviderCallId,
    stop: async () => {
      server.getMediaStreamHandler()?.closeAll();
      await server.stop();
    },
  };
}
