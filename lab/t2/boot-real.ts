/**
 * Boot the lab instance of the plugin (this branch) with the REAL Twilio
 * provider for T2, via createVoiceCallRuntime. Behaviour settings come from
 * the lab config (live profile), Twilio credentials and our number from the
 * installed plugin's entry. It never answers inbound calls
 * (inboundPolicy "disabled"), never transfers, dials only our own number,
 * and every side effect (assistant, owner messages, post-call report) is a stub.
 */
import fs from "node:fs";
import { VoiceCallConfigSchema } from "../../src/config.js";
import type { InitiateCallInput } from "../../src/types.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "../../src/runtime.js";
import { buildLabRawConfig, createStubs, readLiveEntry, type BootOptions, type StubLog, type Stubs } from "../harness/boot.ts";
import type { TwilioCreds } from "./number.ts";

export type LiveTwilio = TwilioCreds & { fromNumber: string; publicUrl?: string };

/** Twilio creds + our number from plugins.entries["voice-call-tristan"].config (never printed). */
export function readLiveTwilio(): LiveTwilio {
  const live = readLiveEntry();
  const accountSid = live?.twilio?.accountSid;
  const authToken = live?.twilio?.authToken;
  const fromNumber = live?.fromNumber;
  if (!accountSid || !authToken || !fromNumber) throw new Error("live plugin entry lacks twilio.accountSid/authToken or fromNumber");
  return { accountSid, authToken, fromNumber, publicUrl: live?.publicUrl };
}

/** Mask a phone number for logs: keep the last two digits. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return "(none)";
  return n.replace(/\d(?=\d{2})/g, "*");
}

/** Mask a URL for logs: host only, path kept, query dropped. */
export function maskUrl(u: string | undefined | null): string {
  if (!u) return "(none)";
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}${x.search ? "?…" : ""}`;
  } catch {
    return "(unparsable)";
  }
}

export type RealRuntime = {
  runtime: VoiceCallRuntime;
  stubLog: StubLog;
  notes: string[];
  setProviderCallId: (id: string) => void;
  /** Epoch ms of each provider.hangupCall (the bot ending the call). */
  hangups: Array<{ wall: number; providerCallId: string; reason: string }>;
  stop: () => Promise<void>;
};

export async function bootReal(
  opts: BootOptions & {
    port: number;
    /** https://<tunnel A> (no path); the webhook is <publicBase>/voice/webhook. */
    publicBase: string;
    twilio: LiveTwilio;
    stubs?: Stubs;
    maxDurationSeconds?: number;
    /** Also allow dialing this number (owner test calls only, confirmed with the owner). */
    allowDestination?: string;
    /** Extra config merged last (e.g. voiceBridge for owner tool tests). */
    extraConfig?: Record<string, unknown>;
  },
): Promise<RealRuntime> {
  const { raw, notes } = buildLabRawConfig(opts);
  const streaming = raw.streaming as Record<string, unknown>;
  const real: Record<string, unknown> = {
    ...raw,
    provider: "twilio",
    twilio: { accountSid: opts.twilio.accountSid, authToken: opts.twilio.authToken },
    fromNumber: opts.twilio.fromNumber,
    publicUrl: `${opts.publicBase}/voice/webhook`,
    serve: { port: opts.port, bind: "127.0.0.1", path: "/voice/webhook" },
    // The lab instance must never answer a real inbound call.
    inboundPolicy: "disabled",
    allowFrom: [],
    transfer: { enabled: false },
    assistantBridge: { ...(raw.assistantBridge as object), trustedNumbers: [] },
    amd: { enabled: true, onMachine: "leave-message" },
    recording: { enabled: true },
    streaming: { ...streaming, streamPath: "/voice/stream" },
    ...(opts.maxDurationSeconds ? { maxDurationSeconds: opts.maxDurationSeconds } : {}),
    ...(opts.allowDestination ? { toNumber: opts.allowDestination } : {}),
    ...(opts.extraConfig ?? {}),
  };
  if (!opts.allowDestination) delete real.toNumber;
  const config = VoiceCallConfigSchema.parse(real);
  fs.mkdirSync(opts.storeDir, { recursive: true });

  const stubs = createStubs(opts.stubs);
  const runtime = await createVoiceCallRuntime({
    config,
    coreConfig: {},
    assistantBridge: stubs.assistantBridge,
    ownerMessenger: stubs.ownerMessenger,
    postCallReporter: stubs.postCallReporter,
  });
  stubs.attach(runtime.webhookServer);

  // Dial guard: our own number only. Record the bot's hangups.
  const provider = runtime.provider;
  const hangups: RealRuntime["hangups"] = [];
  const origInitiate = provider.initiateCall.bind(provider);
  provider.initiateCall = async (input: InitiateCallInput) => {
    if (input.to !== opts.twilio.fromNumber && input.to !== opts.allowDestination) {
      throw new Error("T2 refuses any destination but our own number");
    }
    return origInitiate(input);
  };
  const origHangup = provider.hangupCall.bind(provider);
  provider.hangupCall = async (input) => {
    hangups.push({ wall: Date.now(), providerCallId: input.providerCallId, reason: String(input.reason) });
    return origHangup(input);
  };

  return {
    runtime,
    stubLog: stubs.stubLog,
    notes,
    setProviderCallId: stubs.setProviderCallId,
    hangups,
    stop: async () => {
      runtime.webhookServer.getMediaStreamHandler()?.closeAll();
      await runtime.stop();
    },
  };
}
