import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import type { CallManagerContext } from "./manager/context.js";
import { processEvent as processManagerEvent } from "./manager/events.js";
import { getCallByProviderCallId as getCallByProviderCallIdFromMaps } from "./manager/lookup.js";
import {
  continueCall as continueCallWithContext,
  endCall as endCallWithContext,
  initiateCall as initiateCallWithContext,
  speak as speakWithContext,
  speakInitialMessage as speakInitialMessageWithContext,
} from "./manager/outbound.js";
import {
  findCallInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
} from "./manager/store.js";
import { persistCallRecord } from "./manager/store.js";
import {
  generateCallSummary,
  transcriptFilePath,
  writeTranscriptFile,
} from "./transcript.js";
import { startMaxDurationTimer } from "./manager/timers.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type NormalizedEvent,
  type OutboundCallOptions,
} from "./types.js";
import { resolveUserPath } from "./utils.js";

function resolveDefaultStoreBase(config: VoiceCallConfig, storePath?: string): string {
  const rawOverride = storePath?.trim() || config.store?.trim();
  if (rawOverride) {
    return resolveUserPath(rawOverride);
  }
  const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
  const candidates = [preferred].map((dir) => resolveUserPath(dir));
  const existing =
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
      } catch {
        return false;
      }
    }) ?? resolveUserPath(preferred);
  return existing;
}

/**
 * Manages voice calls: state ownership and delegation to manager helper modules.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>();
  private processedEventIds = new Set<string>();
  private rejectedProviderCallIds = new Set<string>();
  private provider: VoiceCallProvider | null = null;
  private config: VoiceCallConfig;
  private storePath: string;
  private webhookUrl: string | null = null;
  private activeTurnCalls = new Set<CallId>();
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();
  private postCallReporter:
    | ((report: import("./assistant-bridge.js").CallReport) => Promise<void>)
    | null = null;

  constructor(config: VoiceCallConfig, storePath?: string) {
    this.config = config;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers.
   */
  async initialize(provider: VoiceCallProvider, webhookUrl: string): Promise<void> {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });

    const persisted = loadActiveCallsFromStore(this.storePath);
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;

    const verified = await this.verifyRestoredCalls(provider, persisted.activeCalls);
    this.activeCalls = verified;

    // Rebuild providerCallIdMap from verified calls only
    this.providerCallIdMap = new Map();
    for (const [callId, call] of verified) {
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
    }

    // Restart max-duration timers for restored calls that are past the answered state
    for (const [callId, call] of verified) {
      if (call.answeredAt && !TerminalStates.has(call.state)) {
        const elapsed = Date.now() - call.answeredAt;
        const maxDurationMs = this.config.maxDurationSeconds * 1000;
        if (elapsed >= maxDurationMs) {
          // Already expired — remove instead of keeping
          verified.delete(callId);
          if (call.providerCallId) {
            this.providerCallIdMap.delete(call.providerCallId);
          }
          console.log(
            `[voice-call] Skipping restored call ${callId} (max duration already elapsed)`,
          );
          continue;
        }
        startMaxDurationTimer({
          ctx: this.getContext(),
          callId,
          onTimeout: async (id) => {
            await endCallWithContext(this.getContext(), id);
          },
        });
        console.log(`[voice-call] Restarted max-duration timer for restored call ${callId}`);
      }
    }

    if (verified.size > 0) {
      console.log(`[voice-call] Restored ${verified.size} active call(s) from store`);
    }
  }

  /**
   * Verify persisted calls with the provider before restoring.
   * Calls without providerCallId or older than maxDurationSeconds are skipped.
   * Transient provider errors keep the call (rely on timer fallback).
   */
  private async verifyRestoredCalls(
    provider: VoiceCallProvider,
    candidates: Map<CallId, CallRecord>,
  ): Promise<Map<CallId, CallRecord>> {
    if (candidates.size === 0) {
      return new Map();
    }

    const maxAgeMs = this.config.maxDurationSeconds * 1000;
    const now = Date.now();
    const verified = new Map<CallId, CallRecord>();
    const verifyTasks: Array<{ callId: CallId; call: CallRecord; promise: Promise<void> }> = [];

    for (const [callId, call] of candidates) {
      // Skip calls without a provider ID — can't verify
      if (!call.providerCallId) {
        console.log(`[voice-call] Skipping restored call ${callId} (no providerCallId)`);
        continue;
      }

      // Skip calls older than maxDurationSeconds (time-based fallback)
      if (now - call.startedAt > maxAgeMs) {
        console.log(
          `[voice-call] Skipping restored call ${callId} (older than maxDurationSeconds)`,
        );
        continue;
      }

      const task = {
        callId,
        call,
        promise: provider
          .getCallStatus({ providerCallId: call.providerCallId })
          .then((result) => {
            if (result.isTerminal) {
              console.log(
                `[voice-call] Skipping restored call ${callId} (provider status: ${result.status})`,
              );
            } else if (result.isUnknown) {
              console.log(
                `[voice-call] Keeping restored call ${callId} (provider status unknown, relying on timer)`,
              );
              verified.set(callId, call);
            } else {
              verified.set(callId, call);
            }
          })
          .catch(() => {
            // Verification failed entirely — keep the call, rely on timer
            console.log(
              `[voice-call] Keeping restored call ${callId} (verification failed, relying on timer)`,
            );
            verified.set(callId, call);
          }),
      };
      verifyTasks.push(task);
    }

    await Promise.allSettled(verifyTasks.map((t) => t.promise));
    return verified;
  }

  /**
   * Install a post-call reporter invoked once per finalized call.
   */
  setPostCallReporter(
    reporter: (report: import("./assistant-bridge.js").CallReport) => Promise<void>,
  ): void {
    this.postCallReporter = reporter;
  }

  /**
   * Get the current provider.
   */
  getProvider(): VoiceCallProvider | null {
    return this.provider;
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    sessionKey?: string,
    options?: OutboundCallOptions | string,
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    return initiateCallWithContext(this.getContext(), to, sessionKey, options);
  }

  /**
   * Speak to user in an active call.
   */
  async speak(callId: CallId, text: string): Promise<{ success: boolean; error?: string }> {
    return speakWithContext(this.getContext(), callId, text);
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    return speakInitialMessageWithContext(this.getContext(), providerCallId);
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return continueCallWithContext(this.getContext(), callId, prompt);
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    return endCallWithContext(this.getContext(), callId);
  }

  private getContext(): CallManagerContext {
    return {
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      rejectedProviderCallIds: this.rejectedProviderCallIds,
      provider: this.provider,
      config: this.config,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      activeTurnCalls: this.activeTurnCalls,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
      onCallAnswered: (call) => {
        this.maybeSpeakInitialMessageOnAnswered(call);
      },
      onCallEnded: (call) => {
        this.finalizeCall(call);
      },
    };
  }

  /**
   * Finalize an ended call: write the transcript file, generate a summary,
   * and persist both so they remain retrievable after the call is gone from
   * activeCalls (via get_transcript / findCallInStore).
   */
  private finalizeCall(call: CallRecord): void {
    if (call.metadata?.finalized) {
      return;
    }
    call.metadata = { ...(call.metadata ?? {}), finalized: true };
    persistCallRecord(this.storePath, call);

    void (async () => {
      try {
        const apiKey =
          this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY || undefined;
        let summary: string | null = null;
        if (apiKey && call.transcript.length > 0) {
          summary = await generateCallSummary({
            call,
            apiKey,
            model: this.config.summaryModel,
          });
        }

        const filePath = await writeTranscriptFile(this.storePath, call, summary ?? undefined);
        call.metadata = {
          ...(call.metadata ?? {}),
          ...(summary && { summary }),
          transcriptPath: filePath,
        };
        persistCallRecord(this.storePath, call);
        console.log(
          `[voice-call] Call ${call.callId} finalized (${call.transcript.length} transcript entries${summary ? ", summary generated" : ""})`,
        );

        // Only report calls that actually happened (answered or has speech).
        if (this.postCallReporter && (call.answeredAt || call.transcript.length > 0)) {
          const metadata = call.metadata ?? {};
          const report: import("./assistant-bridge.js").CallReport = {
            callId: call.callId,
            direction: call.direction,
            counterparty: call.direction === "inbound" ? call.from : call.to,
            ...(call.endedAt && call.answeredAt
              ? { durationSec: Math.round((call.endedAt - call.answeredAt) / 1000) }
              : {}),
            endReason: call.endReason ?? call.state,
            ...(typeof metadata.answeredBy === "string" ? { answeredBy: metadata.answeredBy } : {}),
            ...(metadata.outcome ? { outcome: metadata.outcome as { status: string; details: string } } : {}),
            ...(summary ? { summary } : {}),
            transcriptPath: filePath,
          };
          console.log(`[voice-call] Dispatching post-call report for ${call.callId}`);
          this.postCallReporter(report).catch((err) => {
            console.warn(
              `[voice-call] Post-call report failed for ${call.callId}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      } catch (err) {
        console.warn(
          `[voice-call] Failed to finalize call ${call.callId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }

  /**
   * Record a structured outcome reported by the voice AI during a call
   * (e.g. reservation confirmed, business hours collected).
   */
  recordCallOutcome(
    callIdOrProviderCallId: string,
    outcome: { status: string; details: string },
  ): boolean {
    const call =
      this.getCall(callIdOrProviderCallId) ??
      this.getCallByProviderCallId(callIdOrProviderCallId);
    if (!call) {
      return false;
    }
    call.metadata = { ...(call.metadata ?? {}), outcome };
    persistCallRecord(this.storePath, call);
    console.log(
      `[voice-call] Outcome recorded for ${call.callId}: ${outcome.status} — ${outcome.details.slice(0, 120)}`,
    );
    return true;
  }

  /**
   * Find a call by internal or provider ID, checking active calls first and
   * falling back to the persistent store (for ended calls).
   */
  async findCall(callIdOrProviderCallId: string): Promise<CallRecord | undefined> {
    return (
      this.getCall(callIdOrProviderCallId) ??
      this.getCallByProviderCallId(callIdOrProviderCallId) ??
      (await findCallInStore(this.storePath, callIdOrProviderCallId))
    );
  }

  /**
   * Get the transcript artifacts for a call (works after the call has ended).
   */
  async getTranscript(callIdOrProviderCallId: string): Promise<
    | {
        callId: string;
        state: string;
        summary?: string;
        outcome?: { status: string; details: string };
        transcript: CallRecord["transcript"];
        transcriptPath?: string;
      }
    | undefined
  > {
    const call = await this.findCall(callIdOrProviderCallId);
    if (!call) {
      return undefined;
    }
    const metadata = call.metadata ?? {};
    const storedPath = transcriptFilePath(this.storePath, call.callId);
    return {
      callId: call.callId,
      state: call.state,
      summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
      outcome: metadata.outcome as { status: string; details: string } | undefined,
      transcript: call.transcript,
      transcriptPath:
        typeof metadata.transcriptPath === "string" ? metadata.transcriptPath : storedPath,
    };
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void {
    processManagerEvent(this.getContext(), event);
  }

  private maybeSpeakInitialMessageOnAnswered(call: CallRecord): void {
    const initialMessage =
      typeof call.metadata?.initialMessage === "string" ? call.metadata.initialMessage.trim() : "";

    if (!initialMessage) {
      return;
    }

    // In streaming conversation mode, greeting is sent via realtime response.create
    // after media stream connect; skipping here avoids TwiML <Say> fallback.
    if (
      this.config.streaming?.enabled &&
      this.config.streaming.sttProvider === "openai-realtime-conversation"
    ) {
      return;
    }

    if (!this.provider || !call.providerCallId) {
      return;
    }

    void this.speakInitialMessage(call.providerCallId);
  }

  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Get an active call by provider call ID (e.g., Twilio CallSid).
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    return getCallByProviderCallIdFromMaps({
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      providerCallId,
    });
  }

  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Get call history (from persisted logs).
   */
  async getCallHistory(limit = 50): Promise<CallRecord[]> {
    return getCallHistoryFromStore(this.storePath, limit);
  }
}
