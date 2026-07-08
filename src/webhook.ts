import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-request-guards";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  buildCallContextPrompt,
  buildDevicePolicyPrompt,
  buildScreeningContextPrompt,
  resolveDevicePolicy,
} from "./device-policy.js";
import {
  OpenAIRealtimeConversationProvider,
  type RealtimeToolDefinition,
  type RealtimeToolResult,
} from "./providers/openai-realtime-conversation.js";
import { generateDtmfMulaw, isValidDtmfSequence } from "./dtmf.js";
import { createManagedRealtimeConversationSession } from "./providers/managed-realtime-conversation.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

/**
 * Module-level map tracking active HTTP servers by "bind:port" key.
 * Survives plugin re-registration (hot-reload) where the framework may call
 * register() again without first calling stop() on the previous service,
 * leaving the old server bound.  Before binding, start() checks this map and
 * closes any stale server so the new instance can take over the port.
 */
const activeServers = new Map<string, http.Server>();

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private listeningUrl: string | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;
  private stopStaleCallReaper: (() => void) | null = null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;

    // Initialize media stream handler if streaming is enabled
    if (config.streaming?.enabled) {
      this.initializeMediaStreaming();
    }
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  /**
   * Handle a function tool invoked by the realtime model during a call.
   */
  private async handleCallTool(
    session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession,
    providerCallId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<RealtimeToolResult> {
    switch (name) {
      case "report_call_outcome": {
        const status = typeof args.status === "string" ? args.status : "unknown";
        const details = typeof args.details === "string" ? args.details : "";
        const recorded = this.manager.recordCallOutcome(providerCallId, { status, details });
        return recorded
          ? "Outcome recorded for the owner."
          : "Could not find the active call to record against.";
      }

      case "press_phone_keys": {
        const digits = typeof args.digits === "string" ? args.digits.trim() : "";
        if (!digits || !isValidDtmfSequence(digits)) {
          return "Error: digits must contain only 0-9, *, #, and ','.";
        }
        const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
        if (!streamSession) {
          return "Error: no active audio stream for this call.";
        }
        const tone = generateDtmfMulaw(digits);
        this.mediaStreamHandler?.sendRawAudio(streamSession.streamSid, tone);
        console.log(`[voice-call] DTMF sent on ${providerCallId}: ${digits}`);
        return `Pressed ${digits}.`;
      }

      case "end_call": {
        const reason = typeof args.reason === "string" ? args.reason : "conversation complete";
        const finalMessage =
          typeof args.final_message === "string" ? args.final_message.trim() : "";
        console.log(`[voice-call] Model requested end_call (${reason}) on ${providerCallId}`);
        // From here on the call is wrapping up: disable barge-in so the other
        // party talking over the goodbye cannot cancel it or flush its audio.
        session.setEndingMode(true);
        void this.gracefulEndCall(session, providerCallId, { finalMessage }).catch((err) => {
          console.warn(
            "[voice-call] Graceful end_call failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
        // Suppress the auto-response: any further speech would be cut off.
        return { output: "Call will end after your goodbye finishes playing.", respond: false };
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  }

  /**
   * End a call once the model has finished speaking and the audio already
   * sent to Twilio has actually played out (Twilio mark echo), so the goodbye
   * is not cut off mid-sentence.
   */
  private async gracefulEndCall(
    session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession,
    providerCallId: string,
    opts?: { finalMessage?: string },
  ): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const waitWhileResponding = async (maxMs: number) => {
      const deadline = Date.now() + maxMs;
      while (session.isResponseActive() && Date.now() < deadline) {
        await sleep(150);
      }
    };

    // Let any in-flight model speech finish first — say() would cancel it
    // mid-word otherwise.
    await waitWhileResponding(15000);

    // Then speak the closing line and wait for it to finish generating.
    if (opts?.finalMessage) {
      session.say(opts.finalMessage);
      const start = Date.now();
      while (!session.isResponseActive() && Date.now() - start < 3000) {
        await sleep(100);
      }
      await waitWhileResponding(15000);
    }

    // Then wait for the audio already sent to Twilio to actually play out.
    const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
    if (streamSession && this.mediaStreamHandler) {
      await this.mediaStreamHandler.waitForPlayoutDrained(streamSession.streamSid, 10000);
    }

    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (call) {
      console.log(`[voice-call] Hanging up ${call.callId} after graceful end_call`);
      await this.manager.endCall(call.callId);
    }
  }

  /**
   * Initialize media streaming for STT and conversation modes.
   */
  private initializeMediaStreaming(): void {
    const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
      return;
    }

    const isConversationMode =
      this.config.streaming?.sttProvider === "openai-realtime-conversation";

    const sharedCallbacks: Omit<MediaStreamConfig, "sttProvider" | "conversationProvider"> = {
      preStartTimeoutMs: this.config.streaming?.preStartTimeoutMs,
      maxPendingConnections: this.config.streaming?.maxPendingConnections,
      maxPendingConnectionsPerIp: this.config.streaming?.maxPendingConnectionsPerIp,
      maxConnections: this.config.streaming?.maxConnections,
      shouldAcceptStream: ({ callId, token }) => {
        const call = this.manager.getCallByProviderCallId(callId);
        if (!call) {
          return false;
        }
        if (this.provider.name === "twilio") {
          const twilio = this.provider as TwilioProvider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId: string, transcript: string) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);

        // STT mode only: clear queued TTS on barge-in.
        if (!isConversationMode && this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }

        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-response via agent for STT mode only.
        // In conversation mode, OpenAI Realtime handles the full loop
        // (STT → LLM → TTS). Calling speak() here would fall back to
        // TwiML <Say> which replaces the active <Connect><Stream>,
        // killing the media stream and dropping the call.
        // IVR/gatekeeper handling in conversation mode is covered by the
        // screening-awareness system prompt injected at session start.
        if (!isConversationMode) {
          const callMode = call.metadata?.mode as string | undefined;
          const shouldRespond = call.direction === "inbound" || callMode === "conversation";
          if (shouldRespond) {
            this.handleInboundResponse(call.callId, transcript).catch((err) => {
              console.warn(`[voice-call] Failed to auto-respond:`, err);
            });
          }
        }
      },
      onSpeechStart: (providerCallId: string) => {
        if (!isConversationMode && this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
      },
      onPartialTranscript: (callId: string, partial: string) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onResponseTranscript: (providerCallId: string, transcript: string) => {
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          return;
        }
        const event: NormalizedEvent = {
          id: `stream-ai-transcript-${Date.now()}`,
          type: "call.speaking",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          text: transcript,
        };
        this.manager.processEvent(event);
      },
      onConnect: (callId: string, streamSid: string) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // STT mode only: speak initial message via telephony TTS.
        // Conversation mode uses onConversationConnected + triggerGreeting.
        if (!isConversationMode) {
          setTimeout(() => {
            this.manager.speakInitialMessage(callId).catch((err) => {
              console.warn(`[voice-call] Failed to speak initial message:`, err);
            });
          }, 500);
        }
      },
      onDisconnect: (callId: string) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        const disconnectedCall = this.manager.getCallByProviderCallId(callId);
        if (disconnectedCall) {
          console.log(
            `[voice-call] Stream disconnected for call ${disconnectedCall.callId}; keeping phone call alive and waiting for provider/webhook state instead of auto-hanging up`,
          );
        }
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId);
        }
      },
    };

    let streamConfig: MediaStreamConfig;
    if (isConversationMode) {
      const callTools: RealtimeToolDefinition[] = [
        {
          name: "end_call",
          description:
            "Hang up the phone call. Only use this after you have spoken every " +
            "detail out loud and the other party has acknowledged. Always provide " +
            "final_message with your closing sentence — it is spoken aloud and " +
            "played out fully before the line disconnects. Any confirmation you " +
            "have not already said out loud will NOT be heard unless it is in " +
            "final_message.",
          parameters: {
            type: "object",
            properties: {
              final_message: {
                type: "string",
                description:
                  "Closing sentence to speak before hanging up, e.g. " +
                  "'Perfect, that's confirmed for Friday at 7pm. Thanks so much, goodbye!'",
              },
              reason: {
                type: "string",
                description: "Brief reason the call is ending (e.g. 'task complete').",
              },
            },
            required: ["final_message"],
          },
        },
        {
          name: "report_call_outcome",
          description:
            "Record the outcome of this call for the owner. Call this once, before " +
            "ending the call, with everything the owner needs to know: whether the " +
            "goal was accomplished and all key facts collected (times, prices, " +
            "hours, confirmation numbers, names).",
          parameters: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["success", "partial", "failed"],
                description: "Whether the call goal was accomplished.",
              },
              details: {
                type: "string",
                description:
                  "The concrete result: facts gathered, commitments made, follow-ups needed.",
              },
            },
            required: ["status", "details"],
          },
        },
        {
          name: "press_phone_keys",
          description:
            "Press phone keypad keys (DTMF touch-tones) on this call. Use this to " +
            "navigate automated phone menus (IVR), e.g. 'press 2 for reservations'. " +
            "Use ',' for a short pause between keys.",
          parameters: {
            type: "object",
            properties: {
              digits: {
                type: "string",
                description: "Keys to press: 0-9, *, #, and ',' for a 500ms pause.",
              },
            },
            required: ["digits"],
          },
        },
      ];

      const baseConversationProvider = new OpenAIRealtimeConversationProvider({
        apiKey,
        model: this.config.streaming?.realtimeModel,
        voice: this.config.streaming?.realtimeVoice,
        systemPrompt: this.config.streaming?.realtimeSystemPrompt,
        silenceDurationMs: this.config.streaming?.silenceDurationMs,
        vadThreshold: this.config.streaming?.vadThreshold,
        tools: callTools,
      });
      const conversationProvider = {
        createSession: (providerCallId: string) => {
          const policy = resolveDevicePolicy(this.config).realtime;
          const managed = createManagedRealtimeConversationSession({
            provider: baseConversationProvider,
            policy,
          });
          managed.onToolCall(async (name, args): Promise<RealtimeToolResult> => {
            return this.handleCallTool(managed, providerCallId, name, args);
          });
          managed.onLifecycleEvent((event) => {
            console.log(`[voice-call] ${event.type}`, event.detail ?? {});
            // Policy-driven closes (idle/max-session) would otherwise leave the
            // caller in dead air: the phone call stays up but nobody is home.
            // End the call gracefully instead.
            if (
              event.type === "realtime.idle_timeout" ||
              event.type === "realtime.max_session_reached"
            ) {
              const call = this.manager.getCallByProviderCallId(providerCallId);
              if (call) {
                console.log(
                  `[voice-call] Ending call ${call.callId} after ${event.type} to avoid dead air`,
                );
                void this.manager.endCall(call.callId).catch((err) => {
                  console.warn(
                    `[voice-call] Failed to end call after ${event.type}:`,
                    err instanceof Error ? err.message : String(err),
                  );
                });
              }
            }
          });
          return managed;
        },
      };
      streamConfig = {
        conversationProvider,
        ...sharedCallbacks,
        onConversationConnected: (callId: string, _streamSid: string, session) => {
          const call = this.manager.getCallByProviderCallId(callId);
          const devicePolicy = resolveDevicePolicy(this.config, { from: call?.from });
          const policyPrompt = buildDevicePolicyPrompt(devicePolicy);
          if (policyPrompt) {
            console.log("[voice-call] realtime.policy.applied", {
              callId,
              deviceId: devicePolicy.deviceId,
              responseLength: devicePolicy.responseLength,
              forbiddenActions: devicePolicy.forbiddenActions,
            });
          }

          // Build call-context prompt from metadata (talking points + party)
          const callContextPrompt = buildCallContextPrompt({
            callParty: call?.metadata?.callParty as "first-party" | "third-party" | undefined,
            talkingPoints: call?.metadata?.talkingPoints as string[] | undefined,
          });

          // Screening-awareness prompt for outbound calls. A per-call identity
          // (initiate_call caller_identity) overrides the configured default.
          const perCallIdentity =
            typeof call?.metadata?.callerIdentity === "string"
              ? call.metadata.callerIdentity
              : undefined;
          const screeningPrompt =
            this.config.callScreening?.enabled && call?.direction === "outbound"
              ? buildScreeningContextPrompt({
                  callerIdentity: perCallIdentity ?? this.config.callScreening.callerIdentity,
                })
              : undefined;

          const toolGuidancePrompt =
            "Call management tools:\n" +
            "- If you reach an automated phone menu (IVR) asking you to press keys, use press_phone_keys with the right digits and keep listening.\n" +
            "- Closing sequence, in order: (1) speak the full confirmation of every agreed detail out loud and wait for the other party to acknowledge; " +
            "(2) use report_call_outcome exactly once with the goal status and every concrete fact gathered (times, prices, hours, names, confirmation numbers); " +
            "(3) use end_call with final_message set to your goodbye line.\n" +
            "- Never announce that you are about to confirm something and then hang up — say the details first, then end. " +
            "Anything you have not spoken aloud (or put in final_message) will never be heard. Never leave the line open after the conversation is over.";

          // Merge base system prompt + device policy + call context + screening + tool guidance into updated instructions
          const promptParts = [
            this.config.streaming?.realtimeSystemPrompt,
            policyPrompt,
            callContextPrompt,
            screeningPrompt,
            toolGuidancePrompt,
          ].filter(Boolean);
          if (promptParts.length > 0) {
            session.updateInstructions(promptParts.join("\n\n"));
          }

          const initialMessage = call?.metadata?.initialMessage as string | undefined;
          if (call?.metadata?.initialMessage) {
            delete call.metadata.initialMessage;
          }
          session.triggerGreeting(initialMessage);
        },
      };
    } else {
      const sttProvider = new OpenAIRealtimeSTTProvider({
        apiKey,
        model: this.config.streaming?.sttModel,
        silenceDurationMs: this.config.streaming?.silenceDurationMs,
        vadThreshold: this.config.streaming?.vadThreshold,
      });
      streamConfig = { sttProvider, ...sharedCallbacks };
    }

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }


  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

    // Guard: if a server is already listening, return the existing URL.
    // This prevents EADDRINUSE when start() is called more than once on the
    // same instance (e.g. during config hot-reload or concurrent ensureRuntime).
    if (this.server?.listening) {
      return this.listeningUrl ?? this.resolveListeningUrl(bind, webhookPath);
    }

    // Close any stale server left over from a previous plugin registration
    // that was never properly stopped (e.g. hot-reload without stop()).
    const bindKey = `${bind}:${port}`;
    const stale = activeServers.get(bindKey);
    if (stale) {
      console.log(`[voice-call] Closing stale server on ${bindKey} before rebinding`);
      activeServers.delete(bindKey);
      await new Promise<void>((resolve) => {
        stale.close(() => resolve());
        // Force-destroy open connections so close() doesn't hang.
        stale.closeAllConnections?.();
      });
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for media streams
      if (this.mediaStreamHandler) {
        this.server.on("upgrade", (request, socket, head) => {
          try {
            const path = this.getUpgradePathname(request);
            if (path === streamPath) {
              console.log("[voice-call] WebSocket upgrade for media stream");
              this.mediaStreamHandler?.handleUpgrade(request, socket, head);
            } else {
              socket.destroy();
            }
          } catch (err) {
            console.error(
              "[voice-call] WebSocket upgrade failed:",
              err instanceof Error ? err.message : String(err),
            );
            socket.destroy();
          }
        });
      }

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `[voice-call] EADDRINUSE: port ${port} is already bound on ${bind}. ` +
              `This usually means the built-in voice-call extension is running alongside ` +
              `this custom fork. Disable it with: plugins.entries.voice-call.enabled = false`,
          );
        }
        reject(err);
      });

      this.server.listen(port, bind, () => {
        const url = this.resolveListeningUrl(bind, webhookPath);
        this.listeningUrl = url;
        activeServers.set(bindKey, this.server!);
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          const address = this.server?.address();
          const actualPort =
            address && typeof address === "object" ? address.port : this.config.serve.port;
          console.log(
            `[voice-call] Media stream WebSocket on ws://${bind}:${actualPort}${streamPath}`,
          );
        }
        resolve(url);

        // Start the stale call reaper if configured
        this.stopStaleCallReaper = startStaleCallReaper({
          manager: this.manager,
          staleCallReaperSeconds: this.config.staleCallReaperSeconds,
        });
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    if (this.stopStaleCallReaper) {
      this.stopStaleCallReaper();
      this.stopStaleCallReaper = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        // Remove from module-level tracking so future start() doesn't
        // try to close this already-stopped server.
        for (const [key, server] of activeServers) {
          if (server === this.server) {
            activeServers.delete(key);
            break;
          }
        }
        this.server.closeAllConnections?.();
        this.server.close(() => {
          this.server = null;
          this.listeningUrl = null;
          resolve();
        });
      } else {
        this.listeningUrl = null;
        resolve();
      }
    });
  }

  private resolveListeningUrl(bind: string, webhookPath: string): string {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      const host = address.address && address.address.length > 0 ? address.address : bind;
      const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `http://${normalizedHost}:${address.port}${webhookPath}`;
    }
    return `http://${bind}:${this.config.serve.port}${webhookPath}`;
  }

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      const host = request.headers.host || "localhost";
      return new URL(request.url || "/", `http://${host}`).pathname;
    } catch {
      return null;
    }
  }

  private normalizeWebhookPathForMatch(pathname: string): string {
    const trimmed = pathname.trim();
    if (!trimmed) {
      return "/";
    }
    const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (prefixed === "/") {
      return prefixed;
    }
    return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  }

  private isWebhookPathMatch(requestPath: string, configuredPath: string): boolean {
    return (
      this.normalizeWebhookPathForMatch(requestPath) ===
      this.normalizeWebhookPathForMatch(configuredPath)
    );
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const payload = await this.runWebhookPipeline(req, webhookPath);
    this.writeWebhookResponse(res, payload);
  }

  private async runWebhookPipeline(
    req: http.IncomingMessage,
    webhookPath: string,
  ): Promise<WebhookResponsePayload> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/voice/hold-music") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`,
      };
    }

    if (!this.isWebhookPathMatch(url.pathname, webhookPath)) {
      return { statusCode: 404, body: "Not Found" };
    }

    if (req.method !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        return { statusCode: 413, body: "Payload Too Large" };
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        return { statusCode: 408, body: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") };
      }
      throw err;
    }

    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
      return { statusCode: 401, body: "Unauthorized" };
    }
    if (!verification.verifiedRequestKey) {
      console.warn("[voice-call] Webhook verification succeeded without request identity key");
      return { statusCode: 401, body: "Unauthorized" };
    }

    const parsed = this.provider.parseWebhookEvent(ctx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    if (verification.isReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      this.processParsedEvents(parsed.events);
    }

    return {
      statusCode: parsed.statusCode || 200,
      headers: parsed.providerResponseHeaders,
      body: parsed.providerResponseBody || "OK",
    };
  }

  private processParsedEvents(events: NormalizedEvent[]): void {
    for (const event of events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }
  }

  private writeWebhookResponse(res: http.ServerResponse, payload: WebhookResponsePayload): void {
    res.statusCode = payload.statusCode;
    if (payload.headers) {
      for (const [key, value] of Object.entries(payload.headers)) {
        res.setHeader(key, value);
      }
    }
    res.end(payload.body);
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = 30_000,
  ): Promise<string> {
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
        callMetadata: call.metadata,
      });

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        console.log(`[voice-call] AI response: "${result.text}"`);
        await this.manager.speak(callId, result.text);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}
