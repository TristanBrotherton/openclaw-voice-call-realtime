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
import { pickCalendarCommand, resolveAvailability } from "./calendar.js";
import {
  controlHomeEntity,
  queryHomeStates,
  HA_COMMANDS,
  type HomeAssistantConfig,
} from "./home-assistant.js";
import { resolveCallParty } from "./assistant-bridge.js";
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
  /** Optional bridge for relaying mid-call questions to the owner's agent */
  private assistantBridge: import("./assistant-bridge.js").AssistantBridge | null = null;
  /** Optional direct-message sender to the owner (for ask_owner) */
  private ownerMessenger: import("./assistant-bridge.js").OwnerMessenger | null = null;
  /** Pending ask_owner questions per call, resolved by answer_call_question */
  private pendingOwnerQuestions = new Map<
    string,
    { question: string; askedAt: number; resolve: (answer: string | null) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
    options?: {
      assistantBridge?: import("./assistant-bridge.js").AssistantBridge;
      ownerMessenger?: import("./assistant-bridge.js").OwnerMessenger;
    },
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;
    this.assistantBridge = options?.assistantBridge ?? null;
    this.ownerMessenger = options?.ownerMessenger ?? null;

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
   * Render text for logs. Unless logTranscripts is enabled, only the length
   * is logged — call content routinely includes personal data.
   */
  private loggableText(text: string): string {
    return this.config.logTranscripts ? text : `<redacted, ${text.length} chars>`;
  }

  /** Resolve the effective Home Assistant config (env fallback), or null if unusable. */
  private resolveHomeAssistantConfig(): HomeAssistantConfig | null {
    const ha = this.config.homeAssistant;
    if (!ha?.enabled) {
      return null;
    }
    const baseUrl = ha.baseUrl || process.env.HA_BASE_URL;
    const token = ha.token || process.env.HA_TOKEN;
    if (!baseUrl || !token) {
      return null;
    }
    return {
      baseUrl,
      token,
      exposeDomains: ha.exposeDomains,
      allowControl: ha.allowControl,
      maxResults: ha.maxResults,
      timeoutMs: ha.timeoutMs,
    };
  }

  /** Centralized trust-tier resolution for a call (see resolveCallParty). */
  private resolvePartyForCall(
    call?: import("./types.js").CallRecord,
  ): "first-party" | "trusted-contact" | "third-party" | "unverified" {
    return resolveCallParty({
      direction: call?.direction,
      from: call?.from,
      to: call?.to,
      callParty: call?.metadata?.callParty,
      trustedNumbers: this.config.assistantBridge?.trustedNumbers ?? [],
      ownerNumbers: [this.config.toNumber, this.config.transfer?.number].filter(
        Boolean,
      ) as string[],
      verifiedOwner: call?.metadata?.verifiedOwner === true,
      stirVerstat:
        typeof call?.metadata?.stirVerstat === "string" ? call.metadata.stirVerstat : undefined,
      trustStirA: this.config.inboundSecurity?.trustStirA ?? true,
    });
  }

  /**
   * Resolve a pending ask_owner question with the owner's reply.
   * Returns false when no question is pending for the call.
   */
  answerOwnerQuestion(callIdOrProviderCallId: string, answer: string): boolean {
    // Accept either the internal callId or the provider SID.
    const call =
      this.manager.getCall(callIdOrProviderCallId) ??
      this.manager.getCallByProviderCallId(callIdOrProviderCallId);
    const keys = [
      callIdOrProviderCallId,
      call?.callId,
      call?.providerCallId,
    ].filter(Boolean) as string[];
    for (const key of keys) {
      const pending = this.pendingOwnerQuestions.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingOwnerQuestions.delete(key);
        pending.resolve(answer);
        return true;
      }
    }
    return false;
  }

  /** Pending ask_owner question for a call, if any (for get_status). */
  getPendingOwnerQuestion(callIdOrProviderCallId: string): { question: string; askedAt: number } | undefined {
    const call =
      this.manager.getCall(callIdOrProviderCallId) ??
      this.manager.getCallByProviderCallId(callIdOrProviderCallId);
    for (const key of [callIdOrProviderCallId, call?.callId, call?.providerCallId]) {
      if (key && this.pendingOwnerQuestions.has(key)) {
        const p = this.pendingOwnerQuestions.get(key)!;
        return { question: p.question, askedAt: p.askedAt };
      }
    }
    return undefined;
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

      case "verify_passphrase": {
        const expected = this.config.inboundSecurity?.passphrase;
        if (!expected) {
          return "Error: no passphrase is configured.";
        }
        const normalize = (s: string) =>
          s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const spoken = typeof args.phrase === "string" ? args.phrase : "";
        const vCall = this.manager.getCallByProviderCallId(providerCallId);
        if (normalize(spoken) === normalize(expected)) {
          if (vCall) {
            vCall.metadata = { ...(vCall.metadata ?? {}), verifiedOwner: true };
            console.log(`[voice-call] Caller verified via passphrase on ${vCall.callId}`);
          }
          return "Verified. Treat the caller as the owner for the rest of this call.";
        }
        console.log(`[voice-call] Passphrase check FAILED on ${vCall?.callId ?? providerCallId}`);
        return "Not verified. Do not grant owner-level access. You may allow one more attempt, then continue treating them as an unverified caller.";
      }

      case "transfer_to_owner": {
        const target = this.config.transfer?.number || this.config.toNumber;
        if (!this.config.transfer?.enabled || !target || this.provider.name !== "twilio") {
          return "Error: transfer is not available on this call.";
        }
        const reason = typeof args.reason === "string" ? args.reason : "caller request";
        console.log(`[voice-call] transfer_to_owner requested (${reason}) on ${providerCallId}`);
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (call) {
          this.manager.recordCallOutcome(providerCallId, {
            status: "partial",
            details: `Transferred to owner: ${reason}`,
          });
          call.metadata = { ...(call.metadata ?? {}), transferredTo: target };
        }
        void (async () => {
          try {
            // Announce, let it play out fully, then hand the call over.
            session.setEndingMode(true);
            session.say("Of course — one moment while I transfer you.");
            await new Promise((r) => setTimeout(r, 500));
            const deadline = Date.now() + 10000;
            while (session.isResponseActive() && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 150));
            }
            const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
            if (streamSession && this.mediaStreamHandler) {
              await this.mediaStreamHandler.waitForPlayoutDrained(streamSession.streamSid, 8000);
            }
            await (this.provider as TwilioProvider).transferCall({
              providerCallId,
              to: target,
              callerId: this.config.fromNumber ?? target,
              timeoutSec: this.config.transfer?.timeoutSec ?? 25,
            });
            console.log(`[voice-call] Transfer initiated to ${target} for ${providerCallId}`);
          } catch (err) {
            console.warn(
              "[voice-call] Transfer failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
        return { output: "Transferring now; you will leave the call.", respond: false };
      }

      case "ask_owner": {
        if (!this.config.askOwner?.enabled || !this.ownerMessenger) {
          return "Error: owner messaging is not available on this call.";
        }
        const question = typeof args.question === "string" ? args.question.trim() : "";
        if (!question) {
          return "Error: question required.";
        }
        const ownerCall = this.manager.getCallByProviderCallId(providerCallId);
        const key = ownerCall?.callId ?? providerCallId;
        if (this.pendingOwnerQuestions.has(key)) {
          return "Error: a question to the owner is already pending on this call.";
        }
        const shortId = key.slice(0, 8);
        const counterparty =
          ownerCall?.direction === "inbound" ? ownerCall.from : (ownerCall?.to ?? "unknown");
        const timeoutMs = this.config.askOwner.timeoutMs;

        const waitForAnswer = new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingOwnerQuestions.delete(key);
            resolve(null);
          }, timeoutMs);
          timer.unref?.();
          this.pendingOwnerQuestions.set(key, { question, askedAt: Date.now(), resolve, timer });
        });

        try {
          await this.ownerMessenger(
            `📞 Live call question (call ${shortId}, with ${counterparty}):\n${question}\n\nReply here and I'll relay it to the call.`,
          );
        } catch (err) {
          const pending = this.pendingOwnerQuestions.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingOwnerQuestions.delete(key);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] ask_owner send failed: ${message}`);
          return `Error: could not reach the owner (${message}). Use your judgment and note it in the outcome.`;
        }

        console.log(`[voice-call] ask_owner pending on ${key}: ${this.loggableText(question)}`);
        const answer = await waitForAnswer;
        if (answer === null) {
          return (
            "The owner has not replied yet. Proceed conservatively: accept a reasonable " +
            "option tentatively and say the owner will confirm, or offer to call back. " +
            "Record what happened via report_call_outcome."
          );
        }
        console.log(`[voice-call] ask_owner answered on ${key} (${answer.length} chars)`);
        return `Owner replied: ${answer}`;
      }

      case "ask_assistant": {
        if (!this.assistantBridge) {
          return "Error: the assistant bridge is not available on this call.";
        }
        const question = typeof args.question === "string" ? args.question.trim() : "";
        if (!question) {
          return "Error: question required.";
        }
        const call = this.manager.getCallByProviderCallId(providerCallId);
        const party = this.resolvePartyForCall(call);
        const context = [
          call?.direction === "inbound" ? `inbound call from ${call.from}` : `outbound call to ${call?.to ?? "unknown"}`,
          `party: ${party}`,
          Array.isArray(call?.metadata?.talkingPoints)
            ? `goal: ${(call.metadata.talkingPoints as string[]).join("; ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        try {
          const answer = await this.assistantBridge(question, context || "no additional context");
          console.log(
            `[voice-call] ask_assistant answered (${answer.length} chars) for ${providerCallId}`,
          );
          return answer;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] ask_assistant failed: ${message}`);
          const askIsOwner = party === "first-party" || party === "trusted-contact";
          return (
            "The answer is not available right now (internal — do not read this aloud). " +
            (askIsOwner
              ? "Tell them naturally, ONCE, that you can't get to it this moment and " +
                "you'll text them the answer shortly. "
              : "Tell them naturally, ONCE, that you can't get to it this moment and " +
                "someone will follow up. ") +
            "Do not repeat this. Record the open item with report_call_outcome so it is " +
            "followed up after the call."
          );
        }
      }

      case "check_home": {
        const haConfig = this.resolveHomeAssistantConfig();
        const haCall = this.manager.getCallByProviderCallId(providerCallId);
        const haParty = this.resolvePartyForCall(haCall);
        const verified = haParty === "first-party" || haParty === "trusted-contact";
        if (!haConfig || !verified) {
          return "Error: home status is not available on this call.";
        }
        try {
          const query = typeof args.query === "string" ? args.query : undefined;
          const summary = await queryHomeStates(haConfig, query);
          return `Home status:\n${summary}`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] check_home failed: ${message}`);
          return "I couldn't reach the home system right now (internal — don't read this aloud). Tell them naturally you can't check that this moment.";
        }
      }

      case "control_home": {
        const haConfig = this.resolveHomeAssistantConfig();
        const hcCall = this.manager.getCallByProviderCallId(providerCallId);
        const hcParty = this.resolvePartyForCall(hcCall);
        const verified = hcParty === "first-party" || hcParty === "trusted-contact";
        if (!haConfig || !haConfig.allowControl || !verified) {
          return "Error: home control is not available on this call.";
        }
        const entityId = typeof args.entity_id === "string" ? args.entity_id.trim() : "";
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!entityId || !command) {
          return "Error: entity_id and command required.";
        }
        try {
          const result = await controlHomeEntity(haConfig, entityId, command);
          console.log(
            `[voice-call] control_home ${command} ${entityId} on ${providerCallId}: ${result.ok ? "ok" : "denied"}`,
          );
          return result.ok ? `Done — ${result.message}` : `Error: ${result.message}`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] control_home failed: ${message}`);
          return "That didn't go through (internal — don't read this aloud). Tell them naturally it didn't work and you'll sort it out.";
        }
      }

      case "check_calendar": {
        const cal = this.config.calendar;
        if (!cal?.enabled || (!cal.icsUrl && !cal.command)) {
          return "Error: calendar is not configured.";
        }
        const startDate = typeof args.start_date === "string" ? args.start_date : "";
        const endDate = typeof args.end_date === "string" ? args.end_date : startDate;
        const calCall = this.manager.getCallByProviderCallId(providerCallId);
        const calParty = this.resolvePartyForCall(calCall);
        try {
          const availability = await resolveAvailability(
            { ...cal, command: pickCalendarCommand(cal, calParty) },
            startDate,
            endDate,
          );
          return `Owner's calendar for ${startDate}..${endDate}:\n${availability}`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[voice-call] check_calendar failed: ${message}`);
          return `Error: could not check the calendar (${message}). Offer to confirm the time later instead of guessing.`;
        }
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
        console.log(
          `[voice-call] DTMF sent on ${providerCallId}: ${this.loggableText(digits)}`,
        );
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
  private rejectPendingOwnerQuestion(callIdOrProviderCallId: string): void {
    const call =
      this.manager.getCall(callIdOrProviderCallId) ??
      this.manager.getCallByProviderCallId(callIdOrProviderCallId);
    for (const key of [callIdOrProviderCallId, call?.callId, call?.providerCallId]) {
      const pending = key ? this.pendingOwnerQuestions.get(key) : undefined;
      if (pending && key) {
        clearTimeout(pending.timer);
        this.pendingOwnerQuestions.delete(key);
        pending.resolve(null);
      }
    }
  }

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
        console.log(
          `[voice-call] Transcript for ${providerCallId}: ${this.loggableText(transcript)}`,
        );

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
        if (this.config.logTranscripts) {
          console.log(`[voice-call] Partial for ${callId}: ${partial}`);
        }
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
        this.rejectPendingOwnerQuestion(callId);
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
            "detail out loud and the other party has acknowledged. Provide " +
            "final_message with your ENTIRE goodbye — it is spoken aloud and " +
            "played out fully before the line disconnects. Do not say a goodbye " +
            "or wrap-up sentence yourself before calling this; final_message " +
            "replaces it. Anything not already said aloud (or in final_message) " +
            "will never be heard.",
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
        ...(this.config.transfer?.enabled && (this.config.transfer.number || this.config.toNumber)
          ? [
              {
                name: "transfer_to_owner",
                description:
                  "Transfer this call to the owner's real phone. Use when the other " +
                  "party genuinely needs the owner (payment details, personal " +
                  "authorization, or they insist on a human). Announce the transfer " +
                  "first is handled for you — just call the tool. After it runs you " +
                  "will leave the call.",
                parameters: {
                  type: "object",
                  properties: {
                    reason: {
                      type: "string",
                      description: "Why the transfer is needed.",
                    },
                  },
                  required: ["reason"],
                },
              },
            ]
          : []),
        ...(this.config.inboundSecurity?.passphrase
          ? [
              {
                name: "verify_passphrase",
                description:
                  "Check the caller's spoken access phrase. Use when an inbound " +
                  "caller wants owner-level help (personal info, actions) but their " +
                  "identity is not yet verified: ask them for the access phrase, " +
                  "then call this with what they said. Never reveal or hint at the " +
                  "phrase yourself, and never say whether individual words were " +
                  "close. Allow two attempts at most.",
                parameters: {
                  type: "object",
                  properties: {
                    phrase: {
                      type: "string",
                      description: "The access phrase exactly as the caller spoke it.",
                    },
                  },
                  required: ["phrase"],
                },
              },
            ]
          : []),
        ...(this.config.askOwner?.enabled && this.ownerMessenger
          ? [
              {
                name: "ask_owner",
                description:
                  "Send the owner a text message with a question and wait for their " +
                  "reply (up to ~2 minutes) while staying on the call. Use for " +
                  "decisions only the owner can make, e.g. accepting an alternative " +
                  "time. Tell the other party you are checking BEFORE calling this, " +
                  "and keep the conversation going naturally while you wait.",
                parameters: {
                  type: "object",
                  properties: {
                    question: {
                      type: "string",
                      description:
                        "Short, self-contained question with the key context, e.g. " +
                        "'7pm is not available — is 8pm OK instead?'",
                    },
                  },
                  required: ["question"],
                },
              },
            ]
          : []),
        ...(this.assistantBridge
          ? [
              {
                name: "ask_assistant",
                description:
                  "Relay a request to the owner's personal assistant, which has the " +
                  "owner's full toolset, and get an answer to use on the call. Use it " +
                  "to look up facts/preferences, and — on a verified call with the " +
                  "owner or a trusted contact — to actually GET THINGS DONE (control " +
                  "smart home, add reminders, send a message, etc.); the assistant " +
                  "enforces what is allowed and may ask you to get spoken confirmation " +
                  "for sensitive actions. Takes 10-40 seconds: tell the other party " +
                  "you need a moment BEFORE calling this. One request at a time.",
                parameters: {
                  type: "object",
                  properties: {
                    question: {
                      type: "string",
                      description:
                        "The specific question, with any needed context, e.g. " +
                        "'Is Wednesday July 15 free between 2 and 4pm?'",
                    },
                  },
                  required: ["question"],
                },
              },
            ]
          : []),
        ...(this.resolveHomeAssistantConfig()
          ? [
              {
                name: "check_home",
                description:
                  "Check the state of the owner's home devices (locks, doors, lights, " +
                  "covers, climate, switches) — e.g. 'are the doors locked?'. Responds " +
                  "in about a second. Pass a query to filter (e.g. 'front door', " +
                  "'lights'); omit it to list exposed devices. Owner/trusted calls only.",
                parameters: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: "Optional filter on device name (e.g. 'garage', 'kitchen light').",
                    },
                  },
                  required: [],
                },
              },
              ...(this.config.homeAssistant?.allowControl
                ? [
                    {
                      name: "control_home",
                      description:
                        "Control one of the owner's home devices. First use check_home " +
                        "to get the exact entity_id, then call this with that entity_id " +
                        `and a command (${HA_COMMANDS.join(", ")}). Owner/trusted calls only.`,
                      parameters: {
                        type: "object",
                        properties: {
                          entity_id: {
                            type: "string",
                            description: "Exact entity_id from check_home, e.g. 'lock.front_door'.",
                          },
                          command: {
                            type: "string",
                            enum: HA_COMMANDS,
                            description: "What to do.",
                          },
                        },
                        required: ["entity_id", "command"],
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(this.config.calendar?.enabled &&
        (this.config.calendar.icsUrl || this.config.calendar.command)
          ? [
              {
                name: "check_calendar",
                description:
                  "Look up the owner's calendar for a date range — use this for ANY " +
                  "question about the owner's schedule: what's coming up, when an " +
                  "event is, whether a time is free, before agreeing to appointments. " +
                  "It responds in about a second. The level of detail adapts " +
                  "automatically to who is on the call. Never use ask_assistant for " +
                  "calendar questions.",
                parameters: {
                  type: "object",
                  properties: {
                    start_date: {
                      type: "string",
                      description: "First day to check, YYYY-MM-DD.",
                    },
                    end_date: {
                      type: "string",
                      description: "Last day to check (inclusive), YYYY-MM-DD.",
                    },
                  },
                  required: ["start_date", "end_date"],
                },
              },
            ]
          : []),
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
        turnDetection: this.config.streaming?.turnDetection,
        vadEagerness: this.config.streaming?.vadEagerness,
        language: this.config.streaming?.language,
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

          // Inbound trust context: tell the model who it may be talking to and
          // how much to trust that before verification.
          const inboundParty = call?.direction === "inbound" ? this.resolvePartyForCall(call) : null;
          const inboundSecurityPrompt =
            call?.direction === "inbound"
              ? `This is an INBOUND call from ${call.from}. Current trust tier: ${inboundParty}. ` +
                (inboundParty === "first-party"
                  ? "The carrier verified this caller ID and it is the owner's number — treat them as the owner."
                  : inboundParty === "trusted-contact"
                    ? "The carrier verified this caller ID and it is a trusted contact's number."
                    : this.config.inboundSecurity?.passphrase
                      ? "The caller's identity is NOT verified (caller ID can be faked). Be helpful with general matters, but before sharing personal information or doing anything owner-level, ask for the access phrase and check it with verify_passphrase. Never reveal the phrase."
                      : "The caller's identity is NOT verified (caller ID can be faked). Be helpful with general matters only; do not share personal information or perform owner-level actions.")
              : undefined;

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

          const bridgeGuidance = this.assistantBridge
            ? "- For non-calendar things mid-call — facts, preferences, and (on a verified owner/trusted call) ACTIONS like controlling the home, reminders, or messages — FIRST tell the other party this may take up to a minute, then use ask_assistant. If it asks you to confirm a sensitive action, get the caller's explicit spoken 'confirm' and relay it back. " +
              `Today's date is ${new Date().toISOString().slice(0, 10)}.\n`
            : "";
          const askOwnerGuidance =
            this.config.askOwner?.enabled && this.ownerMessenger
              ? "- For decisions only the owner can make (accepting an alternative time, spending money), say you'll quickly check with them, then use ask_owner. They reply by text within a couple of minutes; keep chatting naturally while you wait.\n"
              : "";
          const transferGuidance =
            this.config.transfer?.enabled && (this.config.transfer.number || this.config.toNumber)
              ? "- If the other party genuinely needs the owner in person (payment, authorization, or they insist), use transfer_to_owner — do not attempt those things yourself.\n"
              : "";
          const homeGuidance = this.resolveHomeAssistantConfig()
            ? "- For the owner's home (locks, doors, lights, covers, climate), use check_home to read status" +
              (this.config.homeAssistant?.allowControl
                ? " and control_home to change it (get the entity_id from check_home first)"
                : "") +
              " — it responds in about a second.\n"
            : "";
          const calendarEnabled =
            this.config.calendar?.enabled &&
            (this.config.calendar.icsUrl || this.config.calendar.command);
          const calendarGuidance = calendarEnabled
            ? "- For ANY question about the owner's calendar or schedule (what's next, when is X, is a time free), use check_calendar — it answers in about a second. Never use ask_assistant for calendar lookups. " +
              `Today's date is ${new Date().toISOString().slice(0, 10)}. ` +
              "Never invent calendar details.\n"
            : "";
          const toolGuidancePrompt =
            "Call management tools:\n" +
            bridgeGuidance +
            homeGuidance +
            calendarGuidance +
            askOwnerGuidance +
            transferGuidance +
            "- If you reach an automated phone menu (IVR) asking you to press keys, use press_phone_keys with the right digits and keep listening.\n" +
            "- Closing sequence, in order: (1) speak the full confirmation of every agreed detail out loud and wait for the other party to acknowledge; " +
            "(2) use report_call_outcome exactly once with the goal status and every concrete fact gathered (times, prices, hours, names, confirmation numbers); " +
            "(3) immediately use end_call with final_message as your one and only goodbye — no spoken wrap-up before it.\n" +
            "- Never announce that you are about to confirm something and then hang up — say the details first, then end. " +
            "Anything you have not spoken aloud (or put in final_message) will never be heard. Never leave the line open after the conversation is over.\n" +
            "- Tool results, timeouts, and error messages are INTERNAL. Never read them aloud, and never say words like 'system', 'tool', 'lookup', 'timed out', or 'error' to the other party. If something fails, speak like a human colleague: \"I can't get to that right now — I'll text you the answer in a few minutes\" — and record it via report_call_outcome so it is followed up.\n" +
            "- Never say 'the owner' out loud — refer to the person you assist by name. Never repeat a status you already told them (say a follow-up is coming AT MOST once per call).\n" +
            "- When the conversation is over, do NOT speak a wrap-up or goodbye sentence yourself: go straight to end_call — final_message is your entire goodbye and the only one that will be heard.";

          // Merge base system prompt + device policy + call context + screening + tool guidance into updated instructions
          const promptParts = [
            this.config.streaming?.realtimeSystemPrompt,
            policyPrompt,
            callContextPrompt,
            inboundSecurityPrompt,
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
        if (event.type === "call.amd") {
          this.handleAmdResult(event.providerCallId ?? event.callId, event.answeredBy);
        }
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }
  }

  /**
   * Apply the configured answering-machine policy once Twilio's async AMD
   * reports what picked up. With DetectMessageEnd, machine_end_* arrives
   * right after the voicemail greeting finishes — i.e. at the beep.
   */
  private handleAmdResult(providerCallId: string, answeredBy: string): void {
    console.log(`[voice-call] AMD result for ${providerCallId}: ${answeredBy}`);
    const isMachine = answeredBy.startsWith("machine") || answeredBy === "fax";
    if (!isMachine) {
      return;
    }
    const policy = this.config.amd?.onMachine ?? "leave-message";
    const call = this.manager.getCallByProviderCallId(providerCallId);

    if (policy === "hangup") {
      if (call) {
        console.log(`[voice-call] AMD policy hangup: ending ${call.callId}`);
        void this.manager.endCall(call.callId).catch(() => {});
      }
      return;
    }
    if (policy === "continue") {
      return;
    }

    // leave-message: tell the realtime session it's talking to voicemail.
    const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
    const conv = streamSession?.conversationSession;
    if (!conv?.isConnected()) {
      console.warn(`[voice-call] AMD leave-message: no live conversation session for ${providerCallId}`);
      return;
    }
    conv.instruct(
      "An answering machine picked up — you are recording a voicemail now (the beep has " +
        "sounded). Leave ONE concise message: who you are, why you called, and how to reach " +
        "the owner back if appropriate. Do not ask questions or wait for replies. When the " +
        "message is complete, use end_call with a brief final_message sign-off.",
    );
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
        console.log(`[voice-call] AI response: ${this.loggableText(result.text)}`);
        await this.manager.speak(callId, result.text);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}
