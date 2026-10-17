import crypto from "node:crypto";
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
import { buildFastRecallReply, searchLocalMemory } from "./fast-recall.js";
import {
  createManagedRealtimeConversationSession,
  type ConversationSessionFactory,
} from "./providers/managed-realtime-conversation.js";
import { GptLiveConversationSession } from "./providers/gpt-live-conversation.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";
import { CallRecorder, recordingFilePath } from "./call-recorder.js";
import { PickupGate, SilenceWatch, type PickupRelease } from "./call-flow.js";
import { SpeechDetector } from "./audio-pacing.js";
import { mulawToPcm } from "./telephony-audio.js";
import { chooseMenuKeys, looksLikeMenu } from "./menu-router.js";
import { VoiceBridgeClient, parseTaskResult, phoneSessionKey, type TaskResult } from "./voice-bridge-client.js";

/** 20 ms of mu-law silence: what the model hears while the pickup gate holds. */
const MULAW_SILENCE_FRAME = Buffer.alloc(160, 0xff);
/** Caller audio kept for replay while the pickup gate holds (5 s of 20 ms frames). */
const MAX_HELD_FRAMES = 250;
/** Longest voicemail message before the call is ended for it. */
const VOICEMAIL_MAX_MS = 60_000;

type CallFlowState = {
  providerCallId: string;
  direction: "inbound" | "outbound";
  detector: SpeechDetector;
  gate: PickupGate | null;
  held: Buffer[];
  silence: SilenceWatch;
  session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession | null;
  pendingRelease: PickupRelease | null;
  ticker: NodeJS.Timeout | null;
  ending: boolean;
  openingMessage?: string;
  voicemailTimer: NodeJS.Timeout | null;
  failed: boolean;
  wrapUpWarned?: boolean;
  onHoldSince?: number;
  /** The other party signalled the business is done ("you're all set"); closeNudged once acted on. */
  closingCueAt?: number;
  closeNudged?: boolean;
  /** When the other party said goodbye (cleared by anything else they say). */
  userGoodbyeAt?: number;
  /** Voicemail: when the message was requested, and when the bot last finished a line. */
  voicemailSince?: number;
  lastBotLineAt?: number;
  /** Last time the menu router pressed keys. */
  menuPressedAt?: number;
  /** A Live interruption was already sent for the current caller speech segment. */
  interruptSent?: boolean;
  /** When the bot last said goodbye (and nobody has spoken since). */
  goodbyeAt?: number;
};

/** The other party signals the business is done: "you're all set", "that's right", "anything else?". */
export function isClosingCue(text: string): boolean {
  return /\b(all set|you'?re set|that'?s (right|correct|it|all|everything)|you'?re welcome|anything else|no problem|sounds good|all done|see you then|we'?ll see you)\b/i.test(
    text,
  );
}

/** After a closing cue and the bot's reply, close once the line has been quiet this long. */
const CLOSE_AFTER_CUE_MS = 4_000;

/** "What's the latest on the dev system project", "how does our voice bridge work". */
export function looksLikeProjectQuestion(text: string): boolean {
  return (
    /\b(latest|status|update|progress|working on|state of|stand|how does|how do|how is|architecture|designed?|explain)\b/i.test(text) &&
    /\b(projects?|system|bridge|plugin|voice|pe|agent|repo|code|setup|app|lab|sweep|archive)\b/i.test(text)
  );
}

/** A closing line: "goodbye", "bye", "take care", "have a good …". */
export function isGoodbyeLine(text: string): boolean {
  return /\b(good-?bye|bye(?:-bye)?|take care|have a (?:good|great|nice|lovely) (?:day|evening|night|weekend|one)|talk (?:to you )?soon)\b[.!]*\s*$/i.test(
    text.trim(),
  );
}

/** After the voicemail message, hang up once the bot has been quiet this long. */
const VOICEMAIL_DONE_QUIET_MS = 2_500;

/** Caller speech over the bot this long interrupts GPT-Live (shorter = backchannel). */
const LIVE_INTERRUPT_AFTER_MS = 450;

/** After the bot's goodbye, hang up when the line stays quiet this long. */
const GOODBYE_HANGUP_MS = 4_000;

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
  /** Voice Bridge client (owner-only Voice PE tools), when configured */
  private voiceBridge: VoiceBridgeClient | null = null;
  /** Bearer token the bridge must present when it posts a task result back */
  private readonly taskToken = crypto.randomBytes(24).toString("hex");
  /** Background bridge tasks (explain) by task id */
  private bridgeTasks = new Map<
    string,
    { providerCallId: string; question: string; byText: boolean; session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession }
  >();
  /** Per-call conversation flow (pickup gate, silence watch), keyed by provider call id */
  private flows = new Map<string, CallFlowState>();
  /** Per-call grace timers to end phantom calls whose stream dropped without a terminal event */
  private disconnectGraceTimers = new Map<string, NodeJS.Timeout>();
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
    if (config.voiceBridge?.enabled) {
      this.voiceBridge = new VoiceBridgeClient({
        url: config.voiceBridge.url,
        askPath: config.voiceBridge.askPath,
        askPathFile: config.voiceBridge.askPathFile,
      });
    }

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
          ? "Outcome saved for the owner."
          : "Could not find the active call to save it against.";
      }

      case "verify_passphrase": {
        const expected = this.config.inboundSecurity?.passphrase;
        if (!expected) {
          return "Error: no passphrase is configured.";
        }
        // Spacing and punctuation don't matter: "open sesame now" matches
        // "opensesamenow" (a phrase is spoken, not typed).
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
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
        // Don't hold the line in silence for minutes: wait briefly, then let
        // the conversation carry on and pass the reply on if it comes in.
        const quick = await Promise.race([
          waitForAnswer.then((a) => ({ a })),
          new Promise<null>((r) => setTimeout(() => r(null), ASK_OWNER_FOREGROUND_MS).unref?.()),
        ]);
        if (quick === null) {
          void waitForAnswer.then((late) => {
            if (late !== null) {
              console.log(`[voice-call] ask_owner answered late on ${key} (${late.length} chars)`);
              void this.deliverLateAnswer(session, providerCallId, question, late);
            }
          });
          return (
            "Your message to them is sent and they haven't answered yet (internal). Say briefly that " +
            "you've sent them a quick message and will pass on the answer if it comes in while you " +
            "talk, otherwise they'll get back to them — then carry on the conversation. Do not accept " +
            "or decline anything on their behalf, and don't wait in silence."
          );
        }
        const answer = quick.a;
        if (answer === null) {
          return (
            "The owner has not replied yet. Do not accept or decline anything on their behalf. " +
            "For a booking detail (a slightly different time or table) you may hold it " +
            "tentatively and say it will be confirmed; for an invitation, a favour or any " +
            "personal decision, say warmly that you'll check with them and they'll get back " +
            "to them. Save what happened via report_call_outcome."
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
        // The voice/backend doesn't always pick explain mode for "what's the
        // latest on <project>"; on the owner's calls, project-status and
        // how-does-it-work questions are explain by rule.
        if (args.mode === "explain" || (party === "first-party" && this.voiceBridge && looksLikeProjectQuestion(question))) {
          return this.startExplain(session, providerCallId, question, party);
        }
        // The owner's own calls use the shared Voice Bridge (same answer-only
        // brief, session reuse and background report-back as the Voice PE).
        if (this.voiceBridge && party === "first-party") {
          return this.askViaBridge(session, providerCallId, question);
        }
        // Fast path: bounded local memory grep before the full agent turn.
        // Verified callers only — this is a judgment-free path into the
        // owner's memory (same invariant as the Home Assistant tools).
        // Misses fall through to the full bridge below; irrelevant hits come
        // back via escalate:true, which skips this block.
        const fastRecall = this.config.assistantBridge?.fastRecall;
        const fastEligible =
          fastRecall?.enabled &&
          args.escalate !== true &&
          (party === "first-party" || party === "trusted-contact");
        if (fastEligible && fastRecall) {
          try {
            const lines = searchLocalMemory(question, fastRecall);
            if (lines.length > 0) {
              console.log(
                `[voice-call] ask_assistant fast recall hit (${lines.length} lines) for ${providerCallId}`,
              );
              return buildFastRecallReply(question, lines);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[voice-call] fast recall failed, using full bridge: ${message}`);
          }
        }
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
          // Slow lookups become background tasks: after a few seconds the
          // conversation continues ("I'm still finding out") and the answer is
          // spoken when it arrives, instead of holding the line in silence.
          const pending = this.assistantBridge(question, context || "no additional context");
          const first = await Promise.race([
            pending.then((answer) => ({ answer })),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), ASK_ASSISTANT_FOREGROUND_MS).unref?.()),
          ]);
          if (first) {
            console.log(
              `[voice-call] ask_assistant answered (${first.answer.length} chars) for ${providerCallId}`,
            );
            return first.answer;
          }
          console.log(`[voice-call] ask_assistant still running for ${providerCallId}; continuing in background`);
          void pending.then(
            (answer) => this.deliverLateAnswer(session, providerCallId, question, answer),
            (err) =>
              this.deliverLateAnswer(
                session,
                providerCallId,
                question,
                null,
                err instanceof Error ? err.message : String(err),
              ),
          );
          return (
            "Still working on it (internal — do not read this aloud). Tell them briefly and " +
            "naturally that you're still finding out and will tell them in a moment, then carry " +
            "on the conversation. Do not call ask_assistant again for this question; the answer " +
            "will be given to you when it arrives."
          );
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
            "Do not repeat this. Save the open item with report_call_outcome so it is " +
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

      case "deliver_by_text": {
        let marked = 0;
        for (const task of this.bridgeTasks.values()) {
          if (task.providerCallId === providerCallId) {
            task.byText = true;
            marked++;
          }
        }
        return marked > 0
          ? "Noted: the answer will be sent by text message instead of being read out."
          : "There is no research in progress on this call to send by text.";
      }

      case "list_open_discussions":
      case "open_discussion":
      case "propose_decision": {
        const dCall = this.manager.getCallByProviderCallId(providerCallId);
        if (!this.voiceBridge || this.resolvePartyForCall(dCall) !== "first-party") {
          return "Error: discussions are not available on this call.";
        }
        try {
          const out =
            name === "list_open_discussions"
              ? await this.voiceBridge.discuss("list")
              : name === "open_discussion"
                ? await this.voiceBridge.discuss("brief", { query: String(args.query ?? "") })
                : await this.voiceBridge.discuss("stage", {
                    item: String(args.item_id ?? ""),
                    decision: String(args.decision ?? ""),
                  });
          console.log(
            `[voice-call] ${name}: ` +
              ["count", "found", "staged"].filter((k) => k in out).map((k) => `${k}=${String(out[k])}`).join(", "),
          );
          return JSON.stringify(out);
        } catch (err) {
          console.warn(`[voice-call] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
          return "The project list could not be reached right now (internal). Say so briefly.";
        }
      }

      case "set_on_hold": {
        const flow = this.flows.get(providerCallId);
        const onHold = args.on_hold === true;
        if (flow) {
          if (onHold) {
            flow.onHoldSince = Date.now();
            flow.silence.suspend(Date.now() + 30 * 60_000);
          } else {
            flow.onHoldSince = undefined;
            flow.silence.resume(Date.now());
          }
        }
        console.log(`[voice-call] ${onHold ? "On hold" : "Off hold"}: ${providerCallId}`);
        return {
          output: onHold
            ? "Noted: on hold. Stay completely silent until a live person speaks to you."
            : "Noted: a person is back. Continue the conversation.",
          respond: !onHold,
        };
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
        // Research for the owner is still running and they haven't said
        // goodbye: don't drop the line on them.
        const researching = [...this.bridgeTasks.values()].some(
          (t) => t.providerCallId === providerCallId && !t.byText,
        );
        const lastUser = this.manager
          .getCallByProviderCallId(providerCallId)
          ?.transcript.filter((t) => t.speaker === "user")
          .at(-1)?.text;
        if (researching && !(lastUser && /\b(bye|goodbye|hang up|that's all|gotta go|have to go)\b/i.test(lastUser))) {
          return (
            "Not ending: the research they asked for is still running and they haven't said goodbye " +
            "(internal). Stay on the line; if they want to go, offer to text the answer (deliver_by_text)."
          );
        }
        const reason = typeof args.reason === "string" ? args.reason : "conversation complete";
        const byeFlow = this.flows.get(providerCallId);
        // GPT-Live says its own goodbye before delegating end_call; don't say a second one.
        const alreadySaidGoodbye =
          session.runtime === "live" && !!byeFlow?.goodbyeAt && Date.now() - byeFlow.goodbyeAt < 15_000;
        const finalMessage = alreadySaidGoodbye ? undefined : resolveFinalMessage(args.final_message);
        if (alreadySaidGoodbye) {
          // Anything GPT-Live starts after its goodbye ("just a moment" while it
          // hands off the hang-up) would be the last thing they hear: drop it.
          session.interrupt();
        }
        if (byeFlow) {
          byeFlow.ending = true;
        }
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
        // (GPT-Live speaks the backend's final text: ask it for none, the
        // goodbye is spoken from final_message.)
        return {
          output:
            session.runtime === "live"
              ? "The goodbye is being spoken now and the call will end. Reply with nothing further."
              : "Call will end after your goodbye finishes playing.",
          respond: false,
        };
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  }

  /**
   * GPT-Live talked to phone menus instead of delegating keypresses; when the
   * other side sounds like a menu, pick and press the key ourselves.
   */
  private maybeRouteMenu(providerCallId: string, transcript: string): void {
    const flow = this.flows.get(providerCallId);
    const session = flow?.session;
    if (!flow || !session || session.runtime !== "live" || flow.ending || !looksLikeMenu(transcript)) {
      return;
    }
    if (flow.menuPressedAt && Date.now() - flow.menuPressedAt < 8000) {
      return;
    }
    const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;
    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (!apiKey || !call) {
      return;
    }
    const goal =
      [
        typeof flow.openingMessage === "string" ? flow.openingMessage : undefined,
        Array.isArray(call.metadata?.talkingPoints) ? (call.metadata.talkingPoints as string[]).join("; ") : undefined,
      ]
        .filter(Boolean)
        .join(" — ") || "reach a person who can help";
    flow.menuPressedAt = Date.now();
    // Stop talking over the menu at once, and keep quiet while it plays.
    session.interrupt();
    session.appendContext(
      "thinking",
      "An automated phone menu is speaking. Stay silent; the right key is pressed for you.",
    );
    void chooseMenuKeys({ apiKey, menuText: transcript, goal })
      .then((decision) => {
        if (!decision.digits || flow.ending) {
          flow.menuPressedAt = undefined;
          return;
        }
        const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
        if (!streamSession) {
          return;
        }
        this.mediaStreamHandler?.sendRawAudio(streamSession.streamSid, generateDtmfMulaw(decision.digits));
        console.log(`[voice-call] Menu router pressed ${this.loggableText(decision.digits)} on ${providerCallId}`);
        session.appendContext(
          "thinking",
          `You pressed ${decision.digits} on the phone menu (${decision.reason}). Stay quiet and listen for what comes next.`,
        );
      })
      .catch((err) => {
        flow.menuPressedAt = undefined;
        console.warn(`[voice-call] Menu router failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /**
   * Explain mode (as on the Voice PE): a research question about the owner's
   * own projects, run by the Voice Bridge in the background. The result comes
   * back to /voice/task-result and is spoken on the call if it is still up,
   * otherwise (or on request) sent by text.
   */
  private async startExplain(
    session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession,
    providerCallId: string,
    question: string,
    party: string,
  ): Promise<string> {
    if (!this.voiceBridge || party !== "first-party") {
      return "Explain mode is not available on this call; answer normally instead.";
    }
    const call = this.manager.getCallByProviderCallId(providerCallId);
    const requestId = `phone-explain-${crypto.randomUUID()}`;
    try {
      const accepted = await this.voiceBridge.explain({
        question,
        sessionKey: phoneSessionKey("explain", call?.callId ?? providerCallId),
        requestId,
        callbackUrl: `http://127.0.0.1:${this.config.serve.port}/voice/task-result`,
        callbackToken: this.taskToken,
      });
      if (!accepted.accepted) {
        return `${accepted.error} (internal). Tell them briefly; offer to look into it later.`;
      }
      this.bridgeTasks.set(accepted.taskId, { providerCallId, question, byText: false, session });
      console.log(`[voice-call] explain started (${accepted.taskId}) on ${providerCallId}`);
      return (
        "Research started (internal — do not read this aloud). Tell them in one short sentence " +
        "that you're looking into it, it takes a few minutes, and you'll tell them on this call " +
        "or send a text if you've hung up by then; offer the text option. Then carry on."
      );
    } catch (err) {
      console.warn(`[voice-call] explain failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return "The research could not be started right now (internal). Say so briefly.";
    }
  }

  private async askViaBridge(
    session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession,
    providerCallId: string,
    question: string,
  ): Promise<string> {
    const call = this.manager.getCallByProviderCallId(providerCallId);
    const requestId = `phone-ask-${crypto.randomUUID()}`;
    try {
      const res = await this.voiceBridge!.ask({
        question,
        sessionKey: phoneSessionKey("ask", call?.callId ?? providerCallId),
        requestId,
        callbackUrl: `http://127.0.0.1:${this.config.serve.port}/voice/task-result`,
        callbackToken: this.taskToken,
      });
      if (res.background) {
        this.bridgeTasks.set(requestId, { providerCallId, question, byText: false, session });
        console.log(`[voice-call] bridge ask continuing in background (${requestId}) on ${providerCallId}`);
        return (
          "Still working on it (internal — do not read this aloud). Tell them briefly you're still " +
          "finding out and will tell them in a moment; carry on. Don't ask again; the answer will be " +
          "given to you when it arrives."
        );
      }
      console.log(`[voice-call] bridge ask answered (${res.answer.length} chars) on ${providerCallId}`);
      return res.answer;
    } catch (err) {
      console.warn(`[voice-call] bridge ask failed: ${err instanceof Error ? err.message : String(err)}`);
      return (
        "The answer is not available right now (internal — do not read this aloud). Tell them " +
        "naturally, once, that you can't get to it this moment and you'll text them shortly."
      );
    }
  }

  /** A Voice Bridge task finished: speak it on the call, or text it. */
  private async deliverBridgeTask(result: TaskResult): Promise<void> {
    const task = this.bridgeTasks.get(result.taskId);
    if (!task) {
      console.warn(`[voice-call] task result for unknown task ${result.taskId}`);
      return;
    }
    this.bridgeTasks.delete(result.taskId);
    const call = this.manager.getCallByProviderCallId(task.providerCallId);
    const live = !!call && task.session.isConnected() && !this.flows.get(task.providerCallId)?.ending;
    const textBody = result.text || result.spoken;
    if (!live || task.byText) {
      if (this.ownerMessenger && result.ok && textBody) {
        await this.ownerMessenger(`${task.question.slice(0, 120)}\n\n${textBody}`).catch((err) =>
          console.warn(`[voice-call] explain text failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      console.log(`[voice-call] explain ${result.taskId} delivered by text (${live ? "requested" : "call ended"})`);
      if (live && task.byText) {
        task.session.instruct(
          "The research you were doing has finished and was sent to them by text. Mention that briefly at a natural moment.",
        );
      }
      return;
    }
    await this.deliverLateAnswer(
      task.session,
      task.providerCallId,
      task.question,
      result.ok ? result.spoken : null,
      result.ok ? undefined : "research failed",
    );
    console.log(`[voice-call] explain ${result.taskId} spoken on the call`);
  }

  /**
   * A background ask_assistant answer arrived: speak it if the call is still
   * up (after any current speech), else keep it on the call record for the
   * post-call report.
   */
  private async deliverLateAnswer(
    session: import("./providers/managed-realtime-conversation.js").ManagedRealtimeConversationSession,
    providerCallId: string,
    question: string,
    answer: string | null,
    error?: string,
  ): Promise<void> {
    const call = this.manager.getCallByProviderCallId(providerCallId);
    const flow = this.flows.get(providerCallId);
    if (!call || !session.isConnected() || flow?.ending) {
      const ended = call ?? this.manager.getRecentCallByProviderCallId?.(providerCallId);
      if (ended) {
        const late = Array.isArray(ended.metadata?.lateAnswers) ? (ended.metadata!.lateAnswers as unknown[]) : [];
        ended.metadata = {
          ...(ended.metadata ?? {}),
          lateAnswers: [...late, { question, answer, error, at: Date.now() }],
        };
      }
      console.log(`[voice-call] Late ask_assistant answer for ${providerCallId} arrived after the call`);
      return;
    }
    const deadline = Date.now() + 20_000;
    while (session.isResponseActive() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`[voice-call] Delivering late ask_assistant answer on ${providerCallId}`);
    session.instruct(
      answer
        ? `The answer to the earlier question ("${question}") just came back: ${answer}\n` +
            "Tell them now, briefly and in your own words, then continue the conversation."
        : `The earlier question ("${question}") could not be answered right now (internal). ` +
            "Tell them naturally, once, that you couldn't get it just now and it will be followed up, " +
            "and save the open item with report_call_outcome.",
    );
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

    const callBeforeGoodbye = this.manager.getCallByProviderCallId(providerCallId);
    const botTranscriptCountBefore =
      callBeforeGoodbye?.transcript.filter((entry) => entry.speaker === "bot").length ?? 0;
    let responseCycle: "completed" | "not-started" | "timed-out" = "not-started";
    let fallbackUsed = false;

    // Then speak the closing line and prove that a response actually started
    // and finished. Previously, a failed/empty response fell through to a
    // Twilio mark on an empty buffer, which looked "drained" and caused an
    // abrupt hangup with no goodbye.
    if (opts?.finalMessage) {
      session.say(opts.finalMessage);
      responseCycle = await waitForRealtimeResponseCycle(session);
      if (responseCycle === "not-started") {
        console.warn(
          `[voice-call] Goodbye response did not start on ${providerCallId}; retrying once`,
        );
        session.say(opts.finalMessage);
        responseCycle = await waitForRealtimeResponseCycle(session);
      }
    }

    const callAfterRealtime = this.manager.getCallByProviderCallId(providerCallId);
    const transcriptDeadline = Date.now() + 2000;
    while (
      opts?.finalMessage &&
      responseCycle === "completed" &&
      callAfterRealtime &&
      callAfterRealtime.transcript.filter((entry) => entry.speaker === "bot").length <=
        botTranscriptCountBefore &&
      Date.now() < transcriptDeadline
    ) {
      await sleep(100);
    }
    let goodbyeCaptured =
      !!opts?.finalMessage &&
      !!callAfterRealtime &&
      callAfterRealtime.transcript.filter((entry) => entry.speaker === "bot").length >
        botTranscriptCountBefore;

    // If Realtime did not produce a complete, captured closing response, stop
    // that session and synthesize the exact closing line directly into the
    // existing Twilio media stream. This avoids both an abrupt hangup and a
    // competing late Realtime response.
    if (opts?.finalMessage && (responseCycle !== "completed" || !goodbyeCaptured)) {
      session.close("goodbye_fallback");
      const fallbackPlayed = await this.provider
        .playTtsFallback?.({
          callId: callAfterRealtime?.callId ?? providerCallId,
          providerCallId,
          text: opts.finalMessage,
        })
        .catch((err) => {
          console.warn(
            `[voice-call] Closing-message TTS fallback failed on ${providerCallId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return false;
        });
      if (fallbackPlayed && callAfterRealtime) {
        fallbackUsed = true;
        this.manager.processEvent({
          id: `closing-fallback-${Date.now()}`,
          type: "call.speaking",
          callId: callAfterRealtime.callId,
          providerCallId,
          timestamp: Date.now(),
          text: opts.finalMessage,
        });
        goodbyeCaptured = true;
      }
    }

    // Then wait for the audio already sent to Twilio to actually play out.
    const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
    let playoutDrained = false;
    if (streamSession && this.mediaStreamHandler) {
      playoutDrained = await this.mediaStreamHandler.waitForPlayoutDrained(
        streamSession.streamSid,
        10000,
      );
    }

    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (call) {
      const verified =
        !!opts?.finalMessage &&
        (responseCycle === "completed" || fallbackUsed) &&
        goodbyeCaptured &&
        playoutDrained;
      call.metadata = {
        ...(call.metadata ?? {}),
        finalMessageDelivery: {
          verified,
          responseCycle,
          transcriptCaptured: goodbyeCaptured,
          playoutDrained,
          fallbackUsed,
        },
      };
      if (!verified) {
        console.warn(
          `[voice-call] Goodbye delivery was not verified on ${providerCallId} ` +
            `(response=${responseCycle}, transcript=${goodbyeCaptured}, playout=${playoutDrained})`,
        );
      }
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
      filterInboundAudio: (callId: string, mulaw: Buffer) => this.routeInboundAudio(callId, mulaw),
      createRecorder: (callId: string) => {
        if (!this.config.recording?.enabled) {
          return null;
        }
        const call = this.manager.getCallByProviderCallId(callId);
        const file = recordingFilePath(this.manager.getStorePath(), call?.callId ?? callId);
        console.log(`[voice-call] Recording call ${call?.callId ?? callId}`);
        return new CallRecorder(file);
      },
      onRecordingSaved: (callId: string, saving) => {
        const done = saving.then((result) => {
          if (!result) {
            return;
          }
          const call =
            this.manager.getCallByProviderCallId(callId) ??
            this.manager.getRecentCallByProviderCallId?.(callId);
          if (call) {
            call.metadata = {
              ...(call.metadata ?? {}),
              recordingPath: result.path,
              recordingDurationMs: result.durationMs,
            };
          }
          console.log(`[voice-call] Recording saved: ${result.path} (${Math.round(result.durationMs / 1000)}s)`);
        });
        this.manager.addFinalizeBarrier?.(callId, done);
      },
      onConversationFailed: (callId: string, _streamSid: string, reason: string) => {
        void this.failCall(callId, reason);
      },
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
      onTranscript: (providerCallId: string, transcript: string, spokenAt?: number) => {
        console.log(
          `[voice-call] Transcript for ${providerCallId}: ${this.loggableText(transcript)}`,
        );

        // STT mode only: clear queued TTS on barge-in.
        if (!isConversationMode && this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        if (isConversationMode) {
          this.maybeRouteMenu(providerCallId, transcript);
        }

        // The other party said something after our goodbye (other than their
        // own goodbye): the conversation is not over.
        const userFlow = this.flows.get(providerCallId);
        if (userFlow) {
          userFlow.closingCueAt = isClosingCue(transcript) ? Date.now() : undefined;
          userFlow.userGoodbyeAt = isGoodbyeLine(transcript) || /^\W*(bye|goodbye)\b/i.test(transcript.trim()) ? Date.now() : undefined;
        }
        if (userFlow?.goodbyeAt && !isGoodbyeLine(transcript) && !/^(thanks?|thank you|you too|ok(ay)?|cheers)\b/i.test(transcript.trim())) {
          userFlow.goodbyeAt = undefined;
        }

        // Recently-ended calls still take lines still being transcribed at hangup.
        const activeCall = this.manager.getCallByProviderCallId(providerCallId);
        const call = activeCall ?? this.manager.getRecentCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }

        const event: NormalizedEvent = {
          id: `stream-transcript-${crypto.randomUUID()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: spokenAt ?? Date.now(),
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
        if (!isConversationMode && activeCall) {
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
      onResponseTranscript: (providerCallId: string, transcript: string, spokenAt?: number) => {
        const call =
          this.manager.getCallByProviderCallId(providerCallId) ??
          this.manager.getRecentCallByProviderCallId(providerCallId);
        if (!call) {
          return;
        }
        const byeFlow = this.flows.get(providerCallId);
        if (byeFlow) {
          byeFlow.lastBotLineAt = Date.now();
          byeFlow.goodbyeAt = isGoodbyeLine(transcript) ? Date.now() : undefined;
          byeFlow.silence.activity(Date.now(), "bot");
        }
        const event: NormalizedEvent = {
          id: `stream-ai-transcript-${crypto.randomUUID()}`,
          type: "call.speaking",
          callId: call.callId,
          providerCallId,
          timestamp: spokenAt ?? Date.now(),
          text: transcript,
        };
        this.manager.processEvent(event);
      },
      onConnect: (callId: string, streamSid: string) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        const pendingGrace = this.disconnectGraceTimers.get(callId);
        if (pendingGrace) {
          clearTimeout(pendingGrace);
          this.disconnectGraceTimers.delete(callId);
        }
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }
        this.manager.onMediaStreamStarted(callId);

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
        this.disposeFlow(callId);
        this.rejectPendingOwnerQuestion(callId);
        const disconnectedCall = this.manager.getCallByProviderCallId(callId);
        this.manager.onMediaStreamStopped(callId);
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId);
        }
        const graceMs = this.config.streaming?.disconnectGraceMs ?? 45000;
        if (disconnectedCall && graceMs > 0) {
          const existing = this.disconnectGraceTimers.get(callId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            this.disconnectGraceTimers.delete(callId);
            const call = this.manager.getCallByProviderCallId(callId);
            if (!call) return; // already ended (terminal webhook handled it)
            console.log(
              `[voice-call] Stream did not recover in ${graceMs}ms; ending call ${call.callId} to prevent a phantom`,
            );
            void this.manager.endCall(call.callId).catch(() => {});
          }, graceMs);
          timer.unref?.();
          this.disconnectGraceTimers.set(callId, timer);
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
            "Save the outcome of this call for the owner. Call this once, before " +
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
                  "you need a moment BEFORE calling this. On verified calls a simple " +
                  "recall question may instead return an instant quick-memory result; " +
                  "follow the instructions that come with it. One request at a time.",
                parameters: {
                  type: "object",
                  properties: {
                    question: {
                      type: "string",
                      description:
                        "The specific question, with any needed context, e.g. " +
                        "'Is Wednesday July 15 free between 2 and 4pm?'",
                    },
                    escalate: {
                      type: "boolean",
                      description:
                        "Set true ONLY when a previous quick-memory result for this " +
                        "same question did not answer it — forces the full assistant.",
                    },
                    ...(this.voiceBridge
                      ? {
                          mode: {
                            type: "string",
                            enum: ["answer", "explain"],
                            description:
                              "OWNER CALLS ONLY. \"explain\" for a question about how the owner's own " +
                              "software, projects, systems or code work, are designed, or stand " +
                              "(status, architecture, 'how does our X do Y', 'what's the state of " +
                              "project Z', 'what's the latest on X', 'what is X working on'): the assistant reads the code and documents, takes a few " +
                              "minutes, and the explanation is spoken later on this call or texted. " +
                              "A follow-up to an earlier explanation is also \"explain\"; put the " +
                              "earlier topic in the question so it stands on its own. Otherwise " +
                              "\"answer\" (the default).",
                          },
                        }
                      : {}),
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
        ...(this.voiceBridge
          ? [
              {
                name: "deliver_by_text",
                description:
                  "OWNER CALLS ONLY. The owner wants the answer to research still in progress " +
                  "(an explanation they were told would take a few minutes) sent as a text " +
                  "message instead of spoken: 'text would be great', 'send it by text'. Call it " +
                  "only for that; it changes nothing else.",
                parameters: { type: "object", properties: {} },
              },
              ...(this.config.voiceBridge?.discussions !== false
                ? [
                    {
                      name: "list_open_discussions",
                      description:
                        "OWNER CALLS ONLY. The open items the owner's projects are waiting on: " +
                        "questions, decisions and blockers, newest first. Use for 'what needs me?', " +
                        "'what did my projects send me?'. Say only each item's spoken name, topic and " +
                        "question, briefly; never read anything else aloud from the list.",
                      parameters: { type: "object", properties: {} },
                    },
                    {
                      name: "open_discussion",
                      description:
                        "OWNER CALLS ONLY. Load one open item to talk it through, by its spoken name " +
                        "(for example 'Project 4') or a few words of its topic. Say the topic and the " +
                        "question, then discuss it with the owner. The options are fine to say. Read " +
                        "the 'details' (recommendation and context) aloud ONLY when the owner asks for " +
                        "them; call this again to get them back.",
                      parameters: {
                        type: "object",
                        properties: { query: { type: "string", description: "Spoken name or topic words" } },
                        required: ["query"],
                      },
                    },
                    {
                      name: "propose_decision",
                      description:
                        "OWNER CALLS ONLY. Save the owner's decision on an open item, as a PROPOSAL " +
                        "only. Call it ONLY after you have read the decision back in one sentence " +
                        "('So the decision is …; shall I note that down?') and the owner clearly said yes. " +
                        "Never call it for anyone else's words or on a guess. It is not final: tell the " +
                        "owner a text is coming and the decision counts once they confirm it there.",
                      parameters: {
                        type: "object",
                        properties: {
                          item_id: { type: "string", description: "The item's id from open_discussion" },
                          decision: { type: "string", description: "The decision, one or two plain sentences" },
                        },
                        required: ["item_id", "decision"],
                      },
                    },
                  ]
                : []),
            ]
          : []),
        {
          name: "set_on_hold",
          description:
            "Tell the system you have been put on hold (hold music or a 'please hold' " +
            "message) or that a live person is back. While on hold, stay silent and wait; " +
            "call this with on_hold=false as soon as a person speaks to you again.",
          parameters: {
            type: "object",
            properties: {
              on_hold: { type: "boolean", description: "true = now on hold; false = a person is back." },
            },
            required: ["on_hold"],
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
      const live = this.config.streaming?.live;
      // Per-call tools: the owner-only tools (and ask_assistant's explain
      // mode) are sent to the model only on calls with the verified owner; on
      // any other call the model never sees them.
      const toolsForCall = (providerCallId: string): RealtimeToolDefinition[] => {
        const call = this.manager.getCallByProviderCallId(providerCallId);
        return toolsForParty(callTools, this.resolvePartyForCall(call));
      };
      const sessionFactoriesFor = (tools: RealtimeToolDefinition[]): ConversationSessionFactory[] => {
        const liveFactory: ConversationSessionFactory = {
          runtime: "live",
          createSession: () =>
            new GptLiveConversationSession({
              apiKey,
              model: live?.model ?? "gpt-live-1",
              voice: live?.voice,
              backendModel: live?.backendModel ?? "gpt-6-luna",
              reasoningEffort: live?.reasoningEffort,
              serviceTier: live?.serviceTier,
              systemPrompt: this.config.streaming?.realtimeSystemPrompt,
              tools,
            }),
        };
        const realtimeFactory: ConversationSessionFactory = {
          runtime: "realtime",
          createSession: () => baseConversationProvider.createSession(tools),
        };
        return this.config.streaming?.runtime === "live"
          ? live?.fallbackToRealtime === false
            ? [liveFactory]
            : [liveFactory, realtimeFactory]
          : [realtimeFactory];
      };
      const conversationProvider = {
        createSession: (providerCallId: string) => {
          const policy = resolveDevicePolicy(this.config).realtime;
          const tools = toolsForCall(providerCallId);
          const managed = createManagedRealtimeConversationSession({
            provider: sessionFactoriesFor(tools),
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
            if (event.type === "realtime.failed") {
              void this.failCall(providerCallId, String(event.detail?.reason ?? "session_failed"));
              return;
            }
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

          const haControlAvailable = !!(
            this.resolveHomeAssistantConfig() && this.config.homeAssistant?.allowControl
          );
          const bridgeGuidance = this.assistantBridge
            ? "- For non-calendar things mid-call — facts, preferences, and (on a verified owner/trusted call) ACTIONS like " +
              (haControlAvailable
                ? "reminders or messages"
                : "controlling the home, reminders, or messages") +
              " — FIRST tell the other party this may take up to a minute, then use ask_assistant. If it asks you to confirm a sensitive action, get the caller's explicit spoken 'confirm' and relay it back. " +
              (haControlAvailable
                ? "Never route home control through ask_assistant — check_home/control_home do it instantly. "
                : "") +
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
              " — it responds in about a second, so no need to announce a wait. " +
              "A 'Done' result means the action succeeded — report it as done; " +
              "do not second-guess it or call it a failure.\n"
            : "";
          const calendarEnabled =
            this.config.calendar?.enabled &&
            (this.config.calendar.icsUrl || this.config.calendar.command);
          const calendarGuidance = calendarEnabled
            ? "- For ANY question about the owner's calendar or schedule (what's next, when is X, is a time free), use check_calendar — it answers in about a second. Never use ask_assistant for calendar lookups. " +
              `Today's date is ${new Date().toISOString().slice(0, 10)}. ` +
              "Never invent calendar details.\n"
            : "";
          const ownerToolsGuidance =
            this.voiceBridge && this.resolvePartyForCall(call) === "first-party"
              ? "- You are talking to the owner. As on their home voice assistant, you can: research how " +
                "their own projects and systems work (ask_assistant with mode \"explain\": takes minutes, " +
                "say so and carry on; offer to text it with deliver_by_text), and go through what their " +
                "projects are waiting on (list_open_discussions, open_discussion, propose_decision after a " +
                "read-back and their clear yes).\n"
              : "";
          const toolGuidancePrompt =
            "Call management tools:\n" +
            ownerToolsGuidance +
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
            "- Tool results, timeouts, and error messages are INTERNAL. Never read them aloud, and never say words like 'system', 'tool', 'lookup', 'timed out', or 'error' to the other party. If something fails, speak like a human colleague: \"I can't get to that right now — I'll text you the answer in a few minutes\" — and save it via report_call_outcome so it is followed up.\n" +
            "- Never say 'the owner' out loud — refer to the person you assist by name. Never repeat a status you already told them (say a follow-up is coming AT MOST once per call).\n" +
            "- Never narrate your own thinking or announce what you are about to say. No meta-preambles like 'Let me think of a suggestion', 'Let me confirm what we've got', or 'Let me see' followed by the actual reply — just say the reply itself. Announcing a short wait is ONLY for the slow tools that explicitly call for it (ask_assistant, ask_owner); an ordinary answer needs no warm-up sentence.\n" +
            "- Speak ONE conversational turn at a time and keep it short. Do not stack a greeting plus a long pitch in one breath — greet, pause for a response, then continue.\n" +
            "- When the conversation is over, do NOT speak a wrap-up or goodbye sentence yourself: go straight to end_call — final_message is your entire goodbye and the only one that will be heard.";

          const openingPurpose =
            call?.direction === "outbound" && typeof call.metadata?.initialMessage === "string"
              ? call.metadata.initialMessage
              : undefined;
          const openingPrompt =
            call?.direction === "outbound"
              ? "OPENING: Wait for the other side to speak first. When they answer, reply to what they " +
                "actually said in ONE short, natural opening that identifies you" +
                (openingPurpose
                  ? ` and gives the purpose of the call in your own words: ${openingPurpose}.`
                  : ".") +
                " Do not read instructions aloud and do not introduce yourself again later in the call."
              : undefined;
          const situationsPrompt =
            "HANDLING THE UNEXPECTED:\n" +
            "- Hold music or an automated 'please hold' message: use set_on_hold (on_hold=true) and stay silent; when a live person speaks again, use set_on_hold (on_hold=false) and continue.\n" +
            "- An automated menu: let the prompt finish, then press the right keys with press_phone_keys; do not talk to the menu.\n" +
            "- A call-screening assistant asks who is calling: say your name, who you are calling for and why, in one sentence, then wait.\n" +
            "- The wrong person answers: say who you were trying to reach, ask politely whether they can help or pass a message, and never share private details with them.\n" +
            "- They speak another language: switch to that language if you can.\n" +
            "- A bad line (you can't make out what they said): say so briefly and ask them to repeat; don't guess.\n" +
            "- They interrupt you: stop, listen, and answer what they said; don't restart your previous sentence.\n" +
            "- When they say goodbye, say a brief goodbye back and end the call; don't start re-confirming details then.\n" +
            "- Invitations, favours or anything that needs the person you work for to decide (\"would they like to have dinner?\"): never accept or decline yourself. Check with them (ask_owner) if you can; otherwise say you'll check and they'll get back to them.\n" +
            "- Ask only for what the task says. Never invent preferences, requests or details (seating, dietary needs, names, numbers) that you were not given; if they ask about something you don't know, say you'll check.";
          // Merge base system prompt + device policy + call context + screening + tool guidance into updated instructions
          const promptParts = [
            this.config.streaming?.realtimeSystemPrompt,
            policyPrompt,
            callContextPrompt,
            inboundSecurityPrompt,
            screeningPrompt,
            openingPrompt,
            situationsPrompt,
            toolGuidancePrompt,
          ].filter(Boolean);
          if (promptParts.length > 0) {
            session.updateInstructions(promptParts.join("\n\n"));
          }

          const initialMessage = call?.metadata?.initialMessage as string | undefined;
          if (call?.metadata?.initialMessage) {
            delete call.metadata.initialMessage;
          }
          const flow = this.ensureFlow(callId);
          if (flow) {
            flow.session = session;
            if (flow.gate) {
              // Outbound: the opening waits for the pickup gate (the other side's
              // first words, or the AMD verdict). Keep the purpose for then.
              flow.openingMessage = initialMessage;
              if (flow.pendingRelease) {
                this.applyRelease(flow, flow.pendingRelease);
              }
              return;
            }
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
              `Another voice-call runtime already owns this port — either a second plugin ` +
              `registration in this gateway process that is not sharing the runtime slot, ` +
              `or another process (check: lsof -nP -iTCP:${port} -sTCP:LISTEN).`,
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

    if (url.pathname === "/voice/task-result") {
      return this.handleTaskResult(req);
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

  /** The Voice Bridge posts background task results here (loopback, bearer token). */
  private async handleTaskResult(req: http.IncomingMessage): Promise<WebhookResponsePayload> {
    if (req.method !== "POST" || !this.voiceBridge) {
      return { statusCode: 404, body: "Not Found" };
    }
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const authorized = req.headers.authorization === `Bearer ${this.taskToken}`;
    if (!loopback || !authorized) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    let body: unknown;
    try {
      body = JSON.parse(await this.readBody(req, 64 * 1024, 10_000));
    } catch {
      return { statusCode: 400, body: "Bad Request" };
    }
    const result = parseTaskResult(body);
    if (!result) {
      return { statusCode: 400, body: "Bad Request" };
    }
    void this.deliverBridgeTask(result);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: '{"ok":true}' };
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
   * Feed already-normalized provider events (status, AMD) through the same
   * path as verified webhooks. Used by the real-audio lab to simulate Twilio
   * callbacks without HTTP signatures.
   */
  injectProviderEvents(events: NormalizedEvent[]): void {
    this.processParsedEvents(events);
  }

  /**
   * Apply the configured answering-machine policy once Twilio's async AMD
   * reports what picked up. With DetectMessageEnd, machine_end_* arrives
   * right after the voicemail greeting finishes — i.e. at the beep.
   */
  private handleAmdResult(providerCallId: string, answeredBy: string): void {
    console.log(`[voice-call] AMD result for ${providerCallId}: ${answeredBy}`);
    const gateFlow = this.flows.get(providerCallId);
    if (gateFlow?.gate && !gateFlow.gate.isReleased) {
      const policy = this.config.amd?.onMachine ?? "leave-message";
      const isEndOfGreeting = answeredBy.startsWith("machine_end") || answeredBy === "fax";
      if (isEndOfGreeting && policy === "hangup") {
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (call) {
          console.log(`[voice-call] AMD policy hangup: ending ${call.callId}`);
          void this.manager.endCall(call.callId).catch(() => {});
        }
        return;
      }
      const release =
        isEndOfGreeting && policy === "continue"
          ? gateFlow.gate.onAmd("human")
          : gateFlow.gate.onAmd(answeredBy);
      if (release) {
        this.applyRelease(gateFlow, release);
      }
      return;
    }
    const isMachine =
      (answeredBy.startsWith("machine_end") && answeredBy !== "machine_end_other") || answeredBy === "fax";
    if (!isMachine) {
      return;
    }
    const policy = this.config.amd?.onMachine ?? "leave-message";
    const call = this.manager.getCallByProviderCallId(providerCallId);
    const flow = this.flows.get(providerCallId);

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
    if (flow) {
      flow.voicemailSince = Date.now();
    }
    conv.instruct(VOICEMAIL_INSTRUCTION);
    this.armVoicemailCap(providerCallId);
  }

  // ---------------------------------------------------------------------------
  // Call flow: pickup gate, silence watch, failures
  // ---------------------------------------------------------------------------

  private ensureFlow(providerCallId: string): CallFlowState | null {
    const existing = this.flows.get(providerCallId);
    if (existing) {
      return existing;
    }
    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (!call) {
      return null;
    }
    const now = Date.now();
    const flow: CallFlowState = {
      providerCallId,
      direction: call.direction,
      detector: new SpeechDetector(),
      gate:
        call.direction === "outbound" && call.metadata?.mode !== "notify"
          ? new PickupGate(now, { amdEnabled: this.config.amd?.enabled ?? false })
          : null,
      held: [],
      silence: new SilenceWatch(now),
      session: null,
      pendingRelease: null,
      ticker: null,
      ending: false,
      voicemailTimer: null,
      failed: false,
    };
    flow.ticker = setInterval(() => this.tickFlow(flow), 250);
    flow.ticker.unref?.();
    this.flows.set(providerCallId, flow);
    return flow;
  }

  private disposeFlow(providerCallId: string): void {
    const flow = this.flows.get(providerCallId);
    if (!flow) {
      return;
    }
    if (flow.ticker) clearInterval(flow.ticker);
    if (flow.voicemailTimer) clearTimeout(flow.voicemailTimer);
    this.flows.delete(providerCallId);
  }

  /** Caller audio on its way to the model: held (silence sent) until pickup is decided. */
  private routeInboundAudio(providerCallId: string, mulaw: Buffer): Buffer[] {
    const flow = this.ensureFlow(providerCallId);
    if (!flow) {
      return [mulaw];
    }
    const now = Date.now();
    const event = flow.detector.push(mulawToPcm(mulaw), now);
    if (event || flow.detector.isActive()) {
      flow.silence.activity(now);
    }
    if (!flow.detector.isActive()) {
      flow.interruptSent = false;
    } else if (
      !flow.interruptSent &&
      flow.session?.runtime === "live" &&
      flow.detector.activeForMs(now) >= LIVE_INTERRUPT_AFTER_MS &&
      flow.session.isResponseActive()
    ) {
      // Talking over the bot for a moment (not a short "mm-hm"): yield now.
      flow.interruptSent = true;
      flow.session.interrupt();
    }
    if (!flow.gate || flow.gate.isReleased) {
      if (flow.held.length > 0) {
        const backlog = flow.held;
        flow.held = [];
        return [...backlog, mulaw];
      }
      return [mulaw];
    }
    flow.held.push(mulaw);
    if (flow.held.length > MAX_HELD_FRAMES) {
      flow.held.shift();
    }
    if (event) {
      const release = flow.gate.onSpeech(event, flow.detector.isActive());
      if (release) {
        this.applyRelease(flow, release);
        if (release.replay) {
          const backlog = flow.held;
          flow.held = [];
          return backlog;
        }
        flow.held = [];
        return [mulaw];
      }
    }
    return [MULAW_SILENCE_FRAME];
  }

  private tickFlow(flow: CallFlowState): void {
    const now = Date.now();
    if (flow.gate && !flow.gate.isReleased) {
      const release = flow.gate.tick(now, flow.detector.hasSpoken(), flow.detector.isActive());
      if (release) {
        if (!release.replay) {
          flow.held = [];
        }
        this.applyRelease(flow, release);
      }
      return;
    }
    const session = flow.session;
    if (!session || flow.ending || flow.failed) {
      return;
    }
    const callRec = this.manager.getCallByProviderCallId(flow.providerCallId);
    const since = callRec?.answeredAt ?? callRec?.startedAt;
    const maxMs = this.config.maxDurationSeconds * 1000;
    if (!flow.wrapUpWarned && since && maxMs > 120_000 && now - since >= maxMs - 60_000) {
      flow.wrapUpWarned = true;
      console.log(`[voice-call] One minute left on ${flow.providerCallId}`);
      session.instruct(
        "The call must end in about one minute. At the next natural pause, wrap up: confirm " +
          "anything agreed, save the outcome, and end the call politely.",
      );
    }
    // Voicemail: the message has been left (a bot line finished after the
    // beep) and nothing more is coming: hang up, whether or not the model
    // remembered end_call.
    if (
      flow.voicemailSince &&
      flow.lastBotLineAt &&
      flow.lastBotLineAt > flow.voicemailSince &&
      !session.isResponseActive() &&
      now - flow.lastBotLineAt >= VOICEMAIL_DONE_QUIET_MS
    ) {
      flow.goodbyeAt = flow.lastBotLineAt - GOODBYE_HANGUP_MS; // reuse the hang-up path below
    }
    // The other party signalled the business is done, the bot has answered,
    // and nobody is saying anything: close the call instead of waiting for a
    // silence check-in ("are you still there?" after "you're all set").
    if (
      flow.closingCueAt &&
      !flow.closeNudged &&
      !flow.goodbyeAt &&
      flow.lastBotLineAt &&
      flow.lastBotLineAt > flow.closingCueAt &&
      !session.isResponseActive() &&
      !flow.detector.isActive() &&
      now - Math.max(flow.lastBotLineAt, flow.detector.lastSpeech()) >= CLOSE_AFTER_CUE_MS &&
      ![...this.bridgeTasks.values()].some((t) => t.providerCallId === flow.providerCallId)
    ) {
      flow.closeNudged = true;
      console.log(`[voice-call] Closing ${flow.providerCallId}: business done, line quiet`);
      session.instruct(
        "The conversation is complete. Thank them briefly and say goodbye now, in one short sentence.",
      );
      return;
    }
    // The other party said goodbye, the bot has answered, and the line is
    // quiet: the conversation is over even if the model didn't end it.
    if (
      flow.userGoodbyeAt &&
      flow.lastBotLineAt &&
      flow.lastBotLineAt > flow.userGoodbyeAt &&
      !flow.goodbyeAt
    ) {
      flow.goodbyeAt = flow.lastBotLineAt;
    }
    // Safety net: the bot said goodbye and the line went quiet, but nothing
    // ended the call (the model never used end_call). Hang up.
    if (
      flow.goodbyeAt &&
      now - flow.goodbyeAt >= GOODBYE_HANGUP_MS &&
      !session.isResponseActive() &&
      !flow.detector.isActive() &&
      now - flow.detector.lastSpeech() >= 1500
    ) {
      flow.ending = true;
      console.log(`[voice-call] Hanging up ${flow.providerCallId}: goodbye said, line quiet`);
      const endCallRec = this.manager.getCallByProviderCallId(flow.providerCallId);
      const streamSession = this.mediaStreamHandler?.getSessionByCallId(flow.providerCallId);
      void (async () => {
        if (streamSession && this.mediaStreamHandler) {
          await this.mediaStreamHandler.waitForPlayoutDrained(streamSession.streamSid, 5000);
        }
        if (endCallRec) {
          await this.manager.endCall(endCallRec.callId).catch(() => {});
        }
      })();
      return;
    }
    const researching = [...this.bridgeTasks.values()].some((t) => t.providerCallId === flow.providerCallId);
    const busy =
      researching ||
      session.isResponseActive() ||
      (session as unknown as { isBusy?: () => boolean }).isBusy?.() === true ||
      this.pendingOwnerQuestions.has(this.manager.getCallByProviderCallId(flow.providerCallId)?.callId ?? "");
    if (busy) {
      flow.silence.activity(now, "bot");
      return;
    }
    const action = flow.silence.tick(now);
    if (action === "check-in") {
      console.log(`[voice-call] Silence check-in on ${flow.providerCallId}`);
      session.instruct(
        "Nobody has said anything for a while. Briefly and naturally check whether the other " +
          "person is still there (one short question). If you are on hold, say nothing.",
      );
    } else if (action === "end") {
      console.log(`[voice-call] Ending ${flow.providerCallId} after prolonged silence`);
      flow.ending = true;
      session.setEndingMode(true);
      void this.gracefulEndCall(session, flow.providerCallId, {
        finalMessage: "It sounds like we've lost each other, so I'll let you go. Goodbye.",
      }).catch(() => {});
    }
  }

  /** The pickup gate decided who answered: let the model speak accordingly. */
  private applyRelease(flow: CallFlowState, release: PickupRelease): void {
    const session = flow.session;
    if (!session?.isConnected()) {
      flow.pendingRelease = release; // applied once the session connects
      return;
    }
    flow.pendingRelease = null;
    if (!release.replay) {
      // What the gate held (e.g. a voicemail greeting) must never reach the
      // model now: replayed speech would cut off the reply we are about to ask for.
      flow.held = [];
    }
    flow.silence.activity(Date.now());
    console.log(`[voice-call] Pickup on ${flow.providerCallId}: ${release.reason}`);
    const call = this.manager.getCallByProviderCallId(flow.providerCallId);
    if (call) {
      call.metadata = { ...(call.metadata ?? {}), pickup: release.reason };
    }
    if (release.reason === "voicemail") {
      const policy = this.config.amd?.onMachine ?? "leave-message";
      if (policy === "hangup") {
        if (call) void this.manager.endCall(call.callId).catch(() => {});
        return;
      }
      // Leaving a message: the line is silent by design, so no check-ins,
      // and the machine's own noises must not cancel the message.
      flow.silence.suspend(Date.now() + VOICEMAIL_MAX_MS + 30_000);
      session.setEndingMode(true);
      flow.voicemailSince = Date.now();
      session.instruct(
        VOICEMAIL_INSTRUCTION +
          (flow.openingMessage ? ` The purpose of the call: ${flow.openingMessage}.` : ""),
      );
      this.armVoicemailCap(flow.providerCallId);
      return;
    }
    if (release.reason === "machine") {
      session.instruct(
        "An automated system answered (what it said is coming through now). If it is a phone " +
          "menu, wait for the options and press the right keys with press_phone_keys; if it asks " +
          "you to leave a message after a tone, leave ONE concise message and then use end_call; " +
          "if a live person speaks, talk to them normally." +
          (flow.openingMessage ? ` The purpose of the call: ${flow.openingMessage}.` : ""),
      );
      return;
    }
    if (release.reason === "silent-pickup") {
      // Nobody said anything: open with a greeting ourselves.
      session.triggerGreeting(flow.openingMessage);
      return;
    }
    // A person (or screener) spoke: their words are replayed to the model,
    // which answers them following the OPENING instructions. Realtime needs an
    // explicit nudge only if its VAD misses the replayed audio.
    const replayed = Date.now();
    setTimeout(() => {
      if (!session.isConnected() || session.isResponseActive() || flow.ending) {
        return;
      }
      const last = this.manager.getCallByProviderCallId(flow.providerCallId)?.transcript.at(-1);
      if (last?.speaker === "bot" && last.timestamp >= replayed) {
        return;
      }
      session.triggerGreeting(flow.openingMessage);
    }, 2500).unref?.();
  }

  private armVoicemailCap(providerCallId: string): void {
    const flow = this.flows.get(providerCallId);
    if (!flow || flow.voicemailTimer) {
      return;
    }
    flow.voicemailTimer = setTimeout(() => {
      const call = this.manager.getCallByProviderCallId(providerCallId);
      if (call && !flow.ending) {
        console.log(`[voice-call] Voicemail cap reached on ${call.callId}; hanging up`);
        flow.ending = true;
        void this.manager.endCall(call.callId).catch(() => {});
      }
    }, VOICEMAIL_MAX_MS);
    flow.voicemailTimer.unref?.();
  }

  /**
   * No voice session (connect failed on every runtime, or the session was
   * lost for good): never leave the caller in dead air. Apologise with the
   * telephony voice, then hang up.
   */
  private async failCall(providerCallId: string, reason: string): Promise<void> {
    const flow = this.flows.get(providerCallId);
    if (flow?.failed) {
      return;
    }
    if (flow) {
      flow.failed = true;
    }
    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (!call) {
      return;
    }
    console.warn(`[voice-call] Voice session failed on ${call.callId} (${reason}); apologising and ending`);
    call.metadata = { ...(call.metadata ?? {}), sessionFailure: reason };
    try {
      await this.provider.playTtsFallback?.({
        callId: call.callId,
        providerCallId,
        text: "I'm sorry, I'm having trouble on my end and need to go. I'll be in touch shortly. Goodbye.",
      });
      const streamSession = this.mediaStreamHandler?.getSessionByCallId(providerCallId);
      if (streamSession && this.mediaStreamHandler) {
        await this.mediaStreamHandler.waitForPlayoutDrained(streamSession.streamSid, 10000);
      }
    } catch (err) {
      console.warn(
        "[voice-call] Failure apology could not be played:",
        err instanceof Error ? err.message : String(err),
      );
    }
    await this.manager.endCall(call.callId).catch(() => {});
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

/** Tools the model is given only on calls with the verified owner. */
const OWNER_ONLY_TOOLS = new Set(["deliver_by_text", "list_open_discussions", "open_discussion", "propose_decision"]);

/** The tool list for a call: owner-only tools and explain mode only for the owner. */
export function toolsForParty(tools: RealtimeToolDefinition[], party: string): RealtimeToolDefinition[] {
  if (party === "first-party") {
    return tools;
  }
  return tools
    .filter((t) => !OWNER_ONLY_TOOLS.has(t.name))
    .map((t) => {
      if (t.name !== "ask_assistant") {
        return t;
      }
      const params = t.parameters as { properties?: Record<string, unknown> };
      const { mode: _mode, ...rest } = params.properties ?? {};
      return { ...t, parameters: { ...t.parameters, properties: rest } };
    });
}

/** ask_owner waits this long for a reply before the conversation carries on. */
const ASK_OWNER_FOREGROUND_MS = 15_000;

/** ask_assistant waits this long in the foreground before continuing in the background. */
const ASK_ASSISTANT_FOREGROUND_MS = 8_000;

const VOICEMAIL_INSTRUCTION =
  "You have reached voicemail and the beep has sounded. Leave ONE " +
  "concise message now: who you are, who you are calling for, why you called, and how to get " +
  "back to you if appropriate. Do not ask questions or wait for replies. When the message is " +
  "complete, use end_call with a brief final_message sign-off.";

export function resolveFinalMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "Thank you. Goodbye.";
}
export async function waitForRealtimeResponseCycle(
  session: { isResponseActive(): boolean },
  opts: { startTimeoutMs?: number; finishTimeoutMs?: number; pollMs?: number } = {},
): Promise<"completed" | "not-started" | "timed-out"> {
  const startTimeoutMs = opts.startTimeoutMs ?? 3000;
  const finishTimeoutMs = opts.finishTimeoutMs ?? 15000;
  const pollMs = opts.pollMs ?? 100;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const startDeadline = Date.now() + startTimeoutMs;
  while (!session.isResponseActive() && Date.now() < startDeadline) {
    await sleep(pollMs);
  }
  if (!session.isResponseActive()) {
    return "not-started";
  }

  const finishDeadline = Date.now() + finishTimeoutMs;
  while (session.isResponseActive() && Date.now() < finishDeadline) {
    await sleep(pollMs);
  }
  return session.isResponseActive() ? "timed-out" : "completed";
}
