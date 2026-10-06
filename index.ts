import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// NOTE: import from `agent-harness-runtime`, not `agent-harness`. The gateway
// (2026.9.6) only exports callGatewayTool from the runtime subpath; the older
// openclaw devDependency in this fork still exports it from both, which is why
// `tsc` cannot catch the wrong subpath. Verified live on 2026-09-29.
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  VoiceCallConfigSchema,
  resolveVoiceCallConfig,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";
import {
  createAssistantBridge,
  createOwnerMessenger,
  createPostCallReporter,
} from "./src/assistant-bridge.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./src/runtime.js";

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const twilio = raw.twilio as Record<string, unknown> | undefined;
    const legacyFrom = typeof twilio?.from === "string" ? twilio.from : undefined;

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const providerRaw = raw.provider === "log" ? "mock" : raw.provider;
    const provider = providerRaw ?? (enabled ? "mock" : undefined);

    return VoiceCallConfigSchema.parse({
      ...raw,
      enabled,
      provider,
      fromNumber: raw.fromNumber ?? legacyFrom,
    });
  },
  uiHints: {
    provider: {
      label: "Provider",
      help: "Use twilio, telnyx, or mock for dev/no-network.",
    },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    inboundPolicy: { label: "Inbound Policy" },
    allowFrom: { label: "Inbound Allowlist" },
    inboundGreeting: { label: "Inbound Greeting", advanced: true },
    "telnyx.apiKey": { label: "Telnyx API Key", sensitive: true },
    "telnyx.connectionId": { label: "Telnyx Connection ID" },
    "telnyx.publicKey": { label: "Telnyx Public Key", sensitive: true },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "outbound.notifyHangupDelaySec": {
      label: "Notify Hangup Delay (sec)",
      advanced: true,
    },
    "serve.port": { label: "Webhook Port" },
    "serve.bind": { label: "Webhook Bind" },
    "serve.path": { label: "Webhook Path" },
    "tailscale.mode": { label: "Tailscale Mode", advanced: true },
    "tailscale.path": { label: "Tailscale Path", advanced: true },
    "tunnel.provider": { label: "Tunnel Provider", advanced: true },
    "tunnel.ngrokAuthToken": {
      label: "ngrok Auth Token",
      sensitive: true,
      advanced: true,
    },
    "tunnel.ngrokDomain": { label: "ngrok Domain", advanced: true },
    "tunnel.allowNgrokFreeTierLoopbackBypass": {
      label: "Allow ngrok Free Tier (Loopback Bypass)",
      advanced: true,
    },
    "streaming.enabled": { label: "Enable Streaming", advanced: true },
    "streaming.openaiApiKey": {
      label: "OpenAI Realtime API Key",
      sensitive: true,
      advanced: true,
    },
    "streaming.sttModel": { label: "Realtime STT Model", advanced: true },
    "streaming.realtimeModel": { label: "Realtime Conversation Model", advanced: true },
    "streaming.realtimeVoice": { label: "Realtime Voice", advanced: true },
    "streaming.realtimeSystemPrompt": { label: "Realtime System Prompt", advanced: true },
    "streaming.streamPath": { label: "Media Stream Path", advanced: true },
    "tts.provider": {
      label: "TTS Provider Override",
      help: "Deep-merges with messages.tts (Edge is ignored for calls).",
      advanced: true,
    },
    "tts.openai.model": { label: "OpenAI TTS Model", advanced: true },
    "tts.openai.voice": { label: "OpenAI TTS Voice", advanced: true },
    "tts.openai.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.modelId": { label: "ElevenLabs Model ID", advanced: true },
    "tts.elevenlabs.voiceId": { label: "ElevenLabs Voice ID", advanced: true },
    "tts.elevenlabs.apiKey": {
      label: "ElevenLabs API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.baseUrl": { label: "ElevenLabs Base URL", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    skipSignatureVerification: {
      label: "Skip Signature Verification",
      advanced: true,
    },
    store: { label: "Call Log Store Path", advanced: true },
    responseModel: { label: "Response Model", advanced: true },
    responseSystemPrompt: { label: "Response System Prompt", advanced: true },
    responseTimeoutMs: { label: "Response Timeout (ms)", advanced: true },
  },
};

const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.String({
      description:
        "The opening line spoken to whoever answers — the first thing said on " +
        "the call. Write it as direct speech that identifies the caller and " +
        "states the purpose, e.g. \"Hi, this is Sam, Alex's assistant — Alex " +
        "asked me to call about tomorrow's reservation.\" Never meta-narration " +
        "like 'calling you now' or 'placing the call'.",
    }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
    talking_points: Type.Optional(
      Type.Array(Type.String(), { description: "Talking points to cover during the call" }),
    ),
    call_party: Type.Optional(
      Type.Union([Type.Literal("first-party"), Type.Literal("third-party")], {
        description:
          "Who is being called: first-party (the owner/user) or third-party (a business, restaurant, contact, etc.)",
      }),
    ),
    caller_identity: Type.Optional(
      Type.String({
        description:
          "How the assistant should identify itself on this call (to call screening, " +
          "voicemail, or when asked who is calling), e.g. \"Hi, this is Sam, Alex's " +
          "assistant.\" Overrides the configured default identity.",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_transcript"),
    callId: Type.String({ description: "Call ID (works for ended calls too)" }),
  }),
  Type.Object({
    action: Type.Literal("answer_call_question"),
    callId: Type.String({
      description: "Call ID the question came from (the 📞 message includes its short prefix)",
    }),
    answer: Type.String({ description: "The owner's reply, verbatim or summarized faithfully" }),
  }),
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
  }),
]);

/**
 * Process-wide runtime slot, shared across plugin registrations.
 *
 * OpenClaw ≥ 2026.9 can call `register()` more than once in the same gateway
 * process: the gateway registers the plugin at startup (and starts the
 * service), and agent tool resolution may cold-load a separate "standalone"
 * plugin registry — a fresh module instance with its own `register()` closure.
 * If the runtime lived in the closure, that second closure would build a second
 * VoiceCallRuntime and try to bind the webhook port again (EADDRINUSE on 3336).
 * Keying the slot on `bind:port` and storing it on `globalThis` lets every
 * registration in the process share the one live runtime.
 */
type SharedRuntimeSlot = {
  runtime: VoiceCallRuntime | null;
  runtimePromise: Promise<VoiceCallRuntime> | null;
};

const SHARED_RUNTIME_SLOTS = Symbol.for("openclaw.voice-call-tristan.runtime-slots");

function resolveSharedRuntimeSlot(key: string): SharedRuntimeSlot {
  const globalSlots = globalThis as unknown as Record<symbol, Map<string, SharedRuntimeSlot>>;
  const slots = (globalSlots[SHARED_RUNTIME_SLOTS] ??= new Map<string, SharedRuntimeSlot>());
  let slot = slots.get(key);
  if (!slot) {
    slot = { runtime: null, runtimePromise: null };
    slots.set(key, slot);
  }
  return slot;
}

const voiceCallPlugin = {
  id: "voice-call-tristan",
  name: "Voice Call",
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      const raw = api.pluginConfig as Record<string, unknown>;
      const twilio = raw.twilio as Record<string, unknown> | undefined;
      if (raw.provider === "log") {
        api.logger.warn('[voice-call] provider "log" is deprecated; use "mock" instead');
      }
      if (typeof twilio?.from === "string") {
        api.logger.warn("[voice-call] twilio.from is deprecated; use fromNumber instead");
      }
    }

    // Shared across every registration in this process (see resolveSharedRuntimeSlot).
    const slot = resolveSharedRuntimeSlot(`${config.serve.bind}:${config.serve.port}`);

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (slot.runtime) {
        return slot.runtime;
      }
      if (!slot.runtimePromise) {
        const subagent = (api.runtime as { subagent?: import("./src/assistant-bridge.js").SubagentRuntime })
          .subagent;
        const assistantBridge =
          config.assistantBridge?.enabled && subagent
            ? createAssistantBridge({
                subagent,
                timeoutMs: config.assistantBridge.timeoutMs,
                model: config.assistantBridge.model,
                ownerActions: config.assistantBridge.ownerActions,
              })
            : undefined;
        if (config.assistantBridge?.enabled && !subagent) {
          api.logger.warn(
            "[voice-call] assistantBridge enabled but this OpenClaw build does not expose runtime.subagent; ask_assistant disabled",
          );
        }
        const postCallReporter =
          config.postCallReport?.enabled && subagent
            ? createPostCallReporter({
                subagent,
                timeoutMs: config.postCallReport.timeoutMs,
                ownerTarget: config.toNumber,
              })
            : undefined;
        const ownerMessenger =
          config.askOwner?.enabled && subagent ? createOwnerMessenger({ subagent }) : undefined;
        if (config.askOwner?.enabled && !subagent) {
          api.logger.warn(
            "[voice-call] askOwner enabled but this OpenClaw build does not expose runtime.subagent; ask_owner disabled",
          );
        }
        if (config.postCallReport?.enabled && !subagent) {
          api.logger.warn(
            "[voice-call] postCallReport enabled but this OpenClaw build does not expose runtime.subagent; reports disabled",
          );
        }
        slot.runtimePromise = createVoiceCallRuntime({
          config,
          coreConfig: api.config as CoreConfig,
          ttsRuntime: api.runtime.tts,
          logger: api.logger,
          assistantBridge,
          postCallReporter,
          ownerMessenger,
        });
      }
      const pending = slot.runtimePromise;
      try {
        const rt = await pending;
        slot.runtime = rt;
        return rt;
      } catch (err) {
        // Reset so the next call can retry instead of caching the
        // rejected promise forever (which also leaves the port orphaned
        // if the server started before the failure).  See: #32387
        if (slot.runtimePromise === pending) {
          slot.runtimePromise = null;
        }
        throw err;
      }
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error(`[voice-call] request failed: ${message}`);
      respond(false, { error: message });
    };

    const resolveCallMessageRequest = async (params: GatewayRequestHandlerOptions["params"]) => {
      const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
      const message = typeof params?.message === "string" ? params.message.trim() : "";
      if (!callId || !message) {
        return { error: "callId and message required" } as const;
      }
      const rt = await ensureRuntime();
      return { rt, callId, message } as const;
    };

    api.registerGatewayMethod(
      "voicecall-tristan.initiate",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!message) {
            respond(false, { error: "message required" });
            return;
          }
          const rt = await ensureRuntime();
          const to =
            typeof params?.to === "string" && params.to.trim()
              ? params.to.trim()
              : rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          const talkingPoints = Array.isArray(params?.talking_points)
            ? (params.talking_points as string[]).filter(
                (p: unknown) => typeof p === "string" && (p as string).trim(),
              )
            : undefined;
          const callParty =
            params?.call_party === "first-party" || params?.call_party === "third-party"
              ? params.call_party
              : undefined;
          const callerIdentity =
            typeof params?.caller_identity === "string" && params.caller_identity.trim()
              ? params.caller_identity.trim()
              : undefined;
          const result = await rt.manager.initiateCall(to, undefined, {
            message,
            mode,
            talkingPoints,
            callParty,
            callerIdentity,
          });
          if (!result.success) {
            respond(false, { error: result.error || "initiate failed" });
            return;
          }
          respond(true, { callId: result.callId, initiated: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.continue",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const request = await resolveCallMessageRequest(params);
          if ("error" in request) {
            respond(false, { error: request.error });
            return;
          }
          const result = await request.rt.manager.continueCall(request.callId, request.message);
          if (!result.success) {
            respond(false, { error: result.error || "continue failed" });
            return;
          }
          respond(true, { success: true, transcript: result.transcript });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const request = await resolveCallMessageRequest(params);
          if ("error" in request) {
            respond(false, { error: request.error });
            return;
          }
          const result = await request.rt.manager.speak(request.callId, request.message);
          if (!result.success) {
            respond(false, { error: result.error || "speak failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.endCall(callId);
          if (!result.success) {
            respond(false, { error: result.error || "end failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            typeof params?.callId === "string"
              ? params.callId.trim()
              : typeof params?.sid === "string"
                ? params.sid.trim()
                : "";
          if (!raw) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const call = await rt.manager.findCall(raw);
          if (!call) {
            respond(true, { found: false });
            return;
          }
          const pendingQuestion = rt.webhookServer.getPendingOwnerQuestion(call.callId);
          respond(true, { found: true, call, ...(pendingQuestion ? { pendingQuestion } : {}) });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.calendar",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const start = typeof params?.start === "string" ? params.start : "";
          const end = typeof params?.end === "string" ? params.end : start;
          if (!start) {
            respond(false, { error: "start (YYYY-MM-DD) required" });
            return;
          }
          await ensureRuntime();
          const { resolveAvailability } = await import("./src/calendar.js");
          const availability = await resolveAvailability(
            config.calendar as import("./src/calendar.js").CalendarBackendConfig,
            start,
            end,
          );
          respond(true, { availability });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.transcript",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.getTranscript(callId);
          if (!result) {
            respond(true, { found: false });
            return;
          }
          respond(true, { found: true, ...result });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.answer-question",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          const answer = typeof params?.answer === "string" ? params.answer.trim() : "";
          if (!callId || !answer) {
            respond(false, { error: "callId and answer required" });
            return;
          }
          const rt = await ensureRuntime();
          const delivered = rt.webhookServer.answerOwnerQuestion(callId, answer);
          respond(
            true,
            delivered
              ? { delivered: true }
              : {
                  delivered: false,
                  note: "No pending question for that call — it may have timed out or the call ended. The voice AI was told to proceed conservatively.",
                },
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall-tristan.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          const rt = await ensureRuntime();
          // Legacy tool path (no `action`) never required `to`; keep the config default so
          // routing through this method does not change behaviour.
          const to =
            typeof params?.to === "string" && params.to.trim() ? params.to.trim() : rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const result = await rt.manager.initiateCall(to, undefined, {
            message: message || undefined,
          });
          if (!result.success) {
            respond(false, { error: result.error || "initiate failed" });
            return;
          }
          respond(true, { callId: result.callId, initiated: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "voice_call",
      label: "Voice Call",
      description:
        "Make phone calls and have voice conversations via the voice-call plugin. " +
        "In conversation mode the realtime AI handles the dialogue autonomously. " +
        (config.postCallReport?.enabled
          ? "Call results are reported to the owner automatically when the call ends — " +
            "do NOT poll get_status or send your own completion report unless asked. "
          : "Poll get_status until the call ends, then use get_transcript to fetch the " +
            "call summary and full transcript to report back. ") +
        "get_transcript works any time after a call ends. " +
        "IMPORTANT: if the owner replies to a relayed live-call question (messages starting " +
        "with 📞, which include the call id prefix), immediately pass their reply to the call " +
        "with answer_call_question — do not answer it yourself.",
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, rawParams) {
        const params = asParamRecord(rawParams);
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const dispatch = (method: string, payload: Record<string, unknown>) =>
            callGatewayTool(method, {}, payload, { scopes: ["operator.admin"] });

          if (typeof params?.action === "string") {
            switch (params.action) {
              case "initiate_call": {
                const message = String(params.message || "").trim();
                if (!message) {
                  throw new Error("message required");
                }
                return json(await dispatch("voicecall-tristan.initiate", params));
              }
              case "continue_call": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                return json(await dispatch("voicecall-tristan.continue", { callId, message }));
              }
              case "speak_to_user": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                return json(await dispatch("voicecall-tristan.speak", { callId, message }));
              }
              case "end_call": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                return json(await dispatch("voicecall-tristan.end", { callId }));
              }
              case "get_status": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                return json(await dispatch("voicecall-tristan.status", { callId }));
              }
              case "answer_call_question": {
                const callId = String(params.callId || "").trim();
                const answer = String(params.answer || "").trim();
                if (!callId || !answer) {
                  throw new Error("callId and answer required");
                }
                return json(
                  await dispatch("voicecall-tristan.answer-question", { callId, answer }),
                );
              }
              case "get_transcript": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                return json(await dispatch("voicecall-tristan.transcript", { callId }));
              }
            }
          }

          const mode = params?.mode ?? "call";
          if (mode === "status") {
            const sid = typeof params.sid === "string" ? params.sid.trim() : "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            return json(await dispatch("voicecall-tristan.status", { sid }));
          }

          return json(await dispatch("voicecall-tristan.start", params));
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall-tristan"] },
    );

    api.registerService({
      id: "voicecall-tristan",
      start: async () => {
        if (!config.enabled) {
          return;
        }
        try {
          await ensureRuntime();
        } catch (err) {
          api.logger.error(
            `[voice-call] Failed to start runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
      stop: async () => {
        const pending = slot.runtimePromise;
        if (!pending) {
          return;
        }
        try {
          const rt = await pending;
          await rt.stop();
        } finally {
          if (slot.runtimePromise === pending) {
            slot.runtimePromise = null;
            slot.runtime = null;
          }
        }
      },
    });
  },
};

export default voiceCallPlugin;
