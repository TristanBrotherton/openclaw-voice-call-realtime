import crypto from "node:crypto";
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
  loadLatestCallRecords,
} from "./manager/store.js";
import { persistCallRecord } from "./manager/store.js";
import { addTranscriptEntry, transitionState } from "./manager/state.js";
import { mapProviderStatusToEndReason } from "./providers/shared/call-status.js";
import {
  buildTranscriptText,
  generateCallSummary,
  transcribeRecording,
  transcriptFilePath,
  writeTranscriptFile,
  type RecordingTranscriptSection,
} from "./transcript.js";
import { startMaxDurationTimer } from "./manager/timers.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type EndReason,
  type NormalizedEvent,
  type OutboundCallOptions,
} from "./types.js";
import { resolveUserPath } from "./utils.js";
import { recordingFilePath } from "./call-recorder.js";

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

/** How long finalize waits after the end so in-flight transcriptions can land. */
const DEFAULT_FINALIZE_SETTLE_MS = 2500;
/** Longest finalize waits for barriers (e.g. the recording being written). */
const DEFAULT_FINALIZE_BARRIER_TIMEOUT_MS = 10_000;
/** After an inbound stream stops, ask the provider for the call status at these delays. */
const DEFAULT_STREAM_STOP_STATUS_DELAYS_MS = [1500, 3000, 6000];
/** Ended calls stay addressable for late transcript lines this long. */
const RECENT_CALL_TTL_MS = 60_000;
/** Bound on the transcript text inlined into a post-call report. */
const REPORT_TRANSCRIPT_MAX_CHARS = 12_000;
/** Calls finalized at startup are only reported when they ended this recently. */
const RESTORE_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How many of the latest stored calls the startup sweep checks for a missing transcript. */
const SWEEP_MAX_CALLS = 200;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms).unref?.();
  });

/** Best guess at when a call whose end we missed actually ended. */
function lastActivityAt(call: CallRecord): number {
  const lastLine = call.transcript.reduce((max, e) => Math.max(max, e.timestamp), 0);
  const streamStoppedAt =
    typeof call.metadata?.streamStoppedAt === "number" ? call.metadata.streamStoppedAt : 0;
  return Math.max(lastLine, streamStoppedAt, call.answeredAt ?? 0, call.startedAt);
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
  /** Recently-ended calls (by callId and providerCallId) so late transcript lines still land. */
  private recentCalls = new Map<string, { call: CallRecord; timer: NodeJS.Timeout }>();
  /** Work finalize must wait for (e.g. the recording being saved), by provider call id. */
  private finalizeBarriers = new Map<string, { addedAt: number; promises: Promise<unknown>[] }>();
  private finalizeSettleMs = DEFAULT_FINALIZE_SETTLE_MS;
  private finalizeBarrierTimeoutMs = DEFAULT_FINALIZE_BARRIER_TIMEOUT_MS;
  private streamStopStatusDelaysMs = DEFAULT_STREAM_STOP_STATUS_DELAYS_MS;

  constructor(config: VoiceCallConfig, storePath?: string) {
    this.config = config;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers. Calls that
   * ended while the gateway was down are finalized (transcript + report), and
   * any ended call still missing its transcript file gets one.
   */
  async initialize(provider: VoiceCallProvider, webhookUrl: string): Promise<void> {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });

    await this.sweepMissingTranscripts();

    const persisted = loadActiveCallsFromStore(this.storePath);
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;

    const { verified, ended } = await this.verifyRestoredCalls(provider, persisted.activeCalls);
    this.activeCalls = verified;

    // Rebuild providerCallIdMap from verified calls only
    this.providerCallIdMap = new Map();
    for (const [callId, call] of verified) {
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
    }

    // Restored calls that are over (or that we cannot track) are ended and
    // finalized so they get a transcript and are not re-read on every start.
    for (const { call, reason, endedAt } of ended) {
      this.endRestoredCall(call, reason, endedAt);
    }

    // Restart max-duration timers for restored calls that are past the answered state
    const expired: CallId[] = [];
    for (const [callId, call] of verified) {
      if (call.answeredAt && !TerminalStates.has(call.state)) {
        const elapsed = Date.now() - call.answeredAt;
        const maxDurationMs = this.config.maxDurationSeconds * 1000;
        if (elapsed >= maxDurationMs) {
          call.endReason = "timeout";
          expired.push(callId);
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
    for (const callId of expired) {
      console.log(`[voice-call] Ending restored call ${callId} (max duration already elapsed)`);
      await endCallWithContext(this.getContext(), callId);
    }

    if (verified.size > 0) {
      console.log(`[voice-call] Restored ${verified.size} active call(s) from store`);
    }
  }

  /**
   * Verify persisted calls with the provider before restoring.
   * Calls the provider reports ended, calls older than maxDurationSeconds and
   * calls without a providerCallId are returned as `ended` (with the best known
   * reason) so they can be finalized. Transient provider errors keep the call
   * (rely on timer fallback).
   */
  private async verifyRestoredCalls(
    provider: VoiceCallProvider,
    candidates: Map<CallId, CallRecord>,
  ): Promise<{
    verified: Map<CallId, CallRecord>;
    ended: Array<{ call: CallRecord; reason: EndReason; endedAt: number }>;
  }> {
    const verified = new Map<CallId, CallRecord>();
    const ended: Array<{ call: CallRecord; reason: EndReason; endedAt: number }> = [];
    if (candidates.size === 0) {
      return { verified, ended };
    }

    const maxAgeMs = this.config.maxDurationSeconds * 1000;
    const now = Date.now();
    const verifyTasks: Promise<void>[] = [];

    const endFromStatus = (call: CallRecord, status: { status: string; endedAt?: number }) => {
      let reason = mapProviderStatusToEndReason(status.status) ?? "completed";
      if (reason === "completed" && call.direction === "inbound") {
        // A bot hangup would have been recorded; the caller hung up.
        reason = "hangup-user";
      }
      ended.push({ call, reason, endedAt: status.endedAt ?? lastActivityAt(call) });
    };

    for (const [callId, call] of candidates) {
      if (!call.providerCallId) {
        console.log(`[voice-call] Ending restored call ${callId} (no providerCallId)`);
        ended.push({ call, reason: "failed", endedAt: lastActivityAt(call) });
        continue;
      }

      const tooOld = now - call.startedAt > maxAgeMs;
      verifyTasks.push(
        provider
          .getCallStatus({ providerCallId: call.providerCallId })
          .then((result) => {
            if (result.isTerminal) {
              console.log(
                `[voice-call] Finalizing restored call ${callId} (provider status: ${result.status})`,
              );
              endFromStatus(call, result);
            } else if (tooOld) {
              console.log(
                `[voice-call] Ending restored call ${callId} (older than maxDurationSeconds)`,
              );
              ended.push({ call, reason: "timeout", endedAt: lastActivityAt(call) });
            } else {
              if (result.isUnknown) {
                console.log(
                  `[voice-call] Keeping restored call ${callId} (provider status unknown, relying on timer)`,
                );
              }
              verified.set(callId, call);
            }
          })
          .catch(() => {
            if (tooOld) {
              ended.push({ call, reason: "timeout", endedAt: lastActivityAt(call) });
              return;
            }
            // Verification failed entirely — keep the call, rely on timer
            console.log(
              `[voice-call] Keeping restored call ${callId} (verification failed, relying on timer)`,
            );
            verified.set(callId, call);
          }),
      );
    }

    await Promise.allSettled(verifyTasks);
    return { verified, ended };
  }

  /** Mark a restored call ended (it is not in activeCalls) and finalize it. */
  private endRestoredCall(call: CallRecord, reason: EndReason, endedAt: number): void {
    call.endedAt = endedAt;
    call.endReason = reason;
    call.state = reason;
    call.metadata = { ...(call.metadata ?? {}), endedOnRestore: true };
    persistCallRecord(this.storePath, call);
    this.finalizeCall(call, { report: Date.now() - endedAt < RESTORE_REPORT_MAX_AGE_MS });
  }

  /**
   * Write the transcript .md for ended calls in the store that never got one
   * (e.g. the gateway stopped between the end and finalize). No summary or
   * report: this only guarantees the transcript exists.
   */
  private async sweepMissingTranscripts(): Promise<void> {
    let records: CallRecord[];
    try {
      records = loadLatestCallRecords(this.storePath).slice(-SWEEP_MAX_CALLS);
    } catch {
      return;
    }
    for (const call of records) {
      if (!TerminalStates.has(call.state)) {
        continue;
      }
      if (fs.existsSync(transcriptFilePath(this.storePath, call.callId))) {
        continue;
      }
      try {
        const summary =
          call.metadata?.summarySource === "transcript-only-v2" &&
          typeof call.metadata.summary === "string"
            ? call.metadata.summary
            : undefined;
        const filePath = await writeTranscriptFile(this.storePath, call, summary);
        call.metadata = { ...(call.metadata ?? {}), finalized: true, transcriptPath: filePath };
        persistCallRecord(this.storePath, call);
        console.log(`[voice-call] Wrote missing transcript for ended call ${call.callId}`);
      } catch (err) {
        console.warn(
          `[voice-call] Could not write missing transcript for ${call.callId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Tune finalize timing (tests, lab). settleMs: wait after the end for
   * in-flight transcript lines; barrierTimeoutMs: cap on waiting for barriers;
   * streamStopStatusDelaysMs: when to poll the provider after an inbound stream stops.
   */
  setFinalizeTiming(timing: {
    settleMs?: number;
    barrierTimeoutMs?: number;
    streamStopStatusDelaysMs?: number[];
  }): void {
    if (timing.settleMs !== undefined) this.finalizeSettleMs = timing.settleMs;
    if (timing.barrierTimeoutMs !== undefined) this.finalizeBarrierTimeoutMs = timing.barrierTimeoutMs;
    if (timing.streamStopStatusDelaysMs) this.streamStopStatusDelaysMs = timing.streamStopStatusDelaysMs;
  }

  /** The directory holding calls.jsonl, transcripts/ and recordings/. */
  getStorePath(): string {
    return this.storePath;
  }

  /**
   * Make finalize of this call wait (max ~10 s) for `p` before writing the
   * transcript and report, e.g. while the call recording is being saved.
   */
  addFinalizeBarrier(providerCallId: string, p: Promise<unknown>): void {
    p.catch(() => {});
    const now = Date.now();
    for (const [key, entry] of this.finalizeBarriers) {
      if (now - entry.addedAt > 5 * 60_000) {
        this.finalizeBarriers.delete(key);
      }
    }
    const entry = this.finalizeBarriers.get(providerCallId) ?? { addedAt: now, promises: [] };
    entry.promises.push(p);
    this.finalizeBarriers.set(providerCallId, entry);
  }

  private async awaitFinalizeBarriers(call: CallRecord): Promise<void> {
    const keys = [call.providerCallId, call.callId].filter((k): k is string => !!k);
    const deadline = Date.now() + this.finalizeBarrierTimeoutMs;
    const seen = new Set<Promise<unknown>>();
    for (;;) {
      const pending = keys
        .flatMap((k) => this.finalizeBarriers.get(k)?.promises ?? [])
        .filter((p) => !seen.has(p));
      if (pending.length === 0) {
        break;
      }
      for (const p of pending) seen.add(p);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn(`[voice-call] Finalize barrier timed out for ${call.callId}`);
        break;
      }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled(pending).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        console.warn(`[voice-call] Finalize barrier timed out for ${call.callId}`);
        break;
      }
    }
    for (const k of keys) this.finalizeBarriers.delete(k);
  }

  /** Keep an ended call addressable (by id or provider id) for late transcript lines. */
  private rememberEndedCall(call: CallRecord): void {
    const keys = [call.callId, call.providerCallId].filter((k): k is string => !!k);
    for (const key of keys) {
      const existing = this.recentCalls.get(key);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        if (this.recentCalls.get(key)?.call === call) this.recentCalls.delete(key);
      }, RECENT_CALL_TTL_MS);
      timer.unref?.();
      this.recentCalls.set(key, { call, timer });
    }
  }

  /** A call that ended in the last ~60 s, by provider call id (or internal id). */
  getRecentCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    return this.recentCalls.get(providerCallId)?.call;
  }

  /**
   * The media stream for a call started. Inbound calls never get an
   * "answered" status callback, so the stream start is their answer time.
   */
  onMediaStreamStarted(providerCallId: string): void {
    const call = this.getCallByProviderCallId(providerCallId);
    if (!call) {
      return;
    }
    if (call.metadata && "streamStoppedAt" in call.metadata) {
      delete call.metadata.streamStoppedAt;
    }
    if (call.direction === "inbound" && !call.answeredAt) {
      call.answeredAt = Date.now();
      transitionState(call, "active");
    }
    persistCallRecord(this.storePath, call);
  }

  /**
   * The media stream for a call stopped. Inbound calls get no end-of-call
   * status callback, so ask the provider whether (and how) the call ended and
   * end it with the real reason and time. The webhook's disconnect grace timer
   * stays as the last resort; endCall then dates the end at the stream stop.
   */
  onMediaStreamStopped(providerCallId: string): void {
    const call = this.getCallByProviderCallId(providerCallId);
    if (!call || TerminalStates.has(call.state)) {
      return;
    }
    const stoppedAt = Date.now();
    call.metadata = { ...(call.metadata ?? {}), streamStoppedAt: stoppedAt };
    persistCallRecord(this.storePath, call);
    if (call.direction !== "inbound" || !this.provider) {
      return;
    }
    void this.resolveEndAfterStreamStop(call.callId, stoppedAt).catch((err) => {
      console.warn(
        `[voice-call] Could not resolve end of ${call.callId} after stream stop:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private async resolveEndAfterStreamStop(callId: CallId, stoppedAt: number): Promise<void> {
    let waited = 0;
    for (const delay of this.streamStopStatusDelaysMs) {
      await sleep(delay - waited);
      waited = delay;
      const call = this.activeCalls.get(callId);
      if (!call || TerminalStates.has(call.state)) {
        return; // ended by a webhook, the bot, or the grace timer
      }
      if (call.metadata?.streamStoppedAt !== stoppedAt) {
        return; // the stream came back
      }
      if (!this.provider || !call.providerCallId) {
        return;
      }
      const status = await this.provider
        .getCallStatus({ providerCallId: call.providerCallId })
        .catch(() => undefined);
      if (!status?.isTerminal) {
        continue;
      }
      let reason = mapProviderStatusToEndReason(status.status) ?? "completed";
      if (reason === "completed") {
        // We did not hang up (that path ends the call before the stream
        // stops), so the caller did.
        reason = "hangup-user";
      }
      console.log(
        `[voice-call] Inbound call ${callId} ended (provider status ${status.status}) after stream stop`,
      );
      this.processEvent({
        id: `stream-stop-end-${crypto.randomUUID()}`,
        type: "call.ended",
        callId,
        providerCallId: call.providerCallId,
        timestamp: status.endedAt ?? stoppedAt,
        reason,
      });
      return;
    }
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
        this.rememberEndedCall(call);
        this.finalizeCall(call);
      },
    };
  }

  /**
   * Finalize an ended call: wait briefly for late transcript lines and for
   * barriers (the recording being saved), transcribe the recording when there
   * is one, write the transcript file, generate a summary, persist both so they
   * remain retrievable after the call is gone from activeCalls (via
   * get_transcript / findCallInStore), and send the post-call report.
   * The transcript file is always written, whatever else fails.
   */
  private finalizeCall(call: CallRecord, options: { report?: boolean } = {}): void {
    if (call.metadata?.finalized) {
      return;
    }
    call.metadata = { ...(call.metadata ?? {}), finalized: true };
    persistCallRecord(this.storePath, call);

    void (async () => {
      let written = false;
      try {
        await sleep(this.finalizeSettleMs);
        await this.awaitFinalizeBarriers(call);

        const apiKey =
          this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY || undefined;

        let recording: RecordingTranscriptSection | undefined;
        // The recorder names files by call id; fall back to that path when the
        // metadata update lost a race with the end of the call.
        const conventionalRecording = recordingFilePath(this.storePath, call.callId);
        const recordingPath =
          typeof call.metadata?.recordingPath === "string"
            ? call.metadata.recordingPath
            : fs.existsSync(conventionalRecording)
              ? conventionalRecording
              : undefined;
        if (recordingPath && call.metadata?.recordingPath !== recordingPath) {
          call.metadata = { ...(call.metadata ?? {}), recordingPath };
        }
        if (recordingPath) {
          if (!fs.existsSync(recordingPath)) {
            recording = { error: "the recording file is missing" };
          } else if (!apiKey) {
            recording = { error: "no OpenAI API key configured to transcribe it" };
          } else {
            try {
              const result = await transcribeRecording(recordingPath, apiKey, {
                language: this.config.streaming?.language,
              });
              recording = result.text.trim()
                ? { text: result.text }
                : { error: "no speech found in the recording" };
            } catch (err) {
              recording = {
                error: `transcription failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
        }

        let summary: string | null = null;
        if (apiKey && (call.transcript.length > 0 || recording?.text)) {
          summary = await generateCallSummary({
            call,
            apiKey,
            model: this.config.summaryModel,
            ...(recording?.text ? { transcriptText: recording.text } : {}),
          }).catch(() => null);
        }

        call.metadata = {
          ...(call.metadata ?? {}),
          ...(summary && { summary }),
          ...(summary && { summarySource: "transcript-only-v2" }),
          ...(recording?.text ? { recordingTranscript: recording.text } : {}),
          ...(recording?.error ? { recordingTranscriptError: recording.error } : {}),
        };
        const filePath = await writeTranscriptFile(
          this.storePath,
          call,
          summary ?? undefined,
          recording,
        );
        written = true;
        call.metadata = { ...(call.metadata ?? {}), transcriptPath: filePath };
        persistCallRecord(this.storePath, call);
        console.log(
          `[voice-call] Call ${call.callId} finalized (${call.transcript.length} transcript entries${recording?.text ? ", recording transcribed" : ""}${summary ? ", summary generated" : ""})`,
        );

        this.dispatchReport(call, filePath, summary ?? undefined, recording?.text, options);
      } catch (err) {
        console.warn(
          `[voice-call] Failed to finalize call ${call.callId}:`,
          err instanceof Error ? err.message : String(err),
        );
        if (!written) {
          // Last resort: the live captions must always land on disk.
          try {
            const filePath = await writeTranscriptFile(this.storePath, call, undefined, undefined);
            call.metadata = { ...(call.metadata ?? {}), transcriptPath: filePath };
            persistCallRecord(this.storePath, call);
          } catch (writeErr) {
            console.error(
              `[voice-call] Could not write transcript for ${call.callId}:`,
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            );
          }
        }
      }
    })();
  }

  private dispatchReport(
    call: CallRecord,
    filePath: string,
    summary: string | undefined,
    recordingTranscript: string | undefined,
    options: { report?: boolean },
  ): void {
    if (!this.postCallReporter || options.report === false) {
      return;
    }
    const answered = !!call.answeredAt || call.transcript.length > 0;
    // Outbound calls are always reported (the agent is told not to poll), even
    // when nobody answered; inbound calls only when something happened.
    if (!answered && call.direction !== "outbound") {
      return;
    }
    const metadata = call.metadata ?? {};
    const fullText = recordingTranscript?.trim() ? recordingTranscript : buildTranscriptText(call);
    const transcriptText =
      fullText.length > REPORT_TRANSCRIPT_MAX_CHARS
        ? fullText.slice(0, REPORT_TRANSCRIPT_MAX_CHARS)
        : fullText;
    const recordingPath =
      typeof metadata.recordingPath === "string" && fs.existsSync(metadata.recordingPath)
        ? metadata.recordingPath
        : undefined;
    const report: import("./assistant-bridge.js").CallReport = {
      callId: call.callId,
      direction: call.direction,
      counterparty: call.direction === "inbound" ? call.from : call.to,
      answered,
      ...(call.endedAt && call.answeredAt
        ? { durationSec: Math.round((call.endedAt - call.answeredAt) / 1000) }
        : {}),
      endReason: call.endReason ?? call.state,
      ...(typeof metadata.answeredBy === "string" ? { answeredBy: metadata.answeredBy } : {}),
      ...(summary ? { summary } : {}),
      ...(metadata.finalMessageDelivery
        ? {
            finalMessageDelivery: metadata.finalMessageDelivery as {
              verified: boolean;
              responseCycle?: string;
              transcriptCaptured?: boolean;
              playoutDrained?: boolean;
              fallbackUsed?: boolean;
            },
          }
        : {}),
      ...(transcriptText.trim()
        ? {
            transcriptText,
            transcriptSource: recordingTranscript?.trim() ? "recording" : "live-captions",
            transcriptTruncated: fullText.length > transcriptText.length,
          }
        : {}),
      transcriptPath: filePath,
      ...(recordingPath ? { recordingPath } : {}),
    };
    console.log(`[voice-call] Dispatching post-call report for ${call.callId}`);
    this.postCallReporter(report).catch((err) => {
      console.warn(
        `[voice-call] Post-call report failed for ${call.callId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  /** Append a transcript line that arrived after the call ended. */
  private appendLateLine(call: CallRecord, event: NormalizedEvent): void {
    const key = event.dedupeKey || event.id;
    if (call.processedEventIds.includes(key)) {
      return;
    }
    call.processedEventIds.push(key);
    if (event.type === "call.speech") {
      addTranscriptEntry(call, "user", event.transcript, event.timestamp);
    } else if (event.type === "call.speaking") {
      addTranscriptEntry(call, "bot", event.text, event.timestamp);
    } else {
      return;
    }
    console.log(`[voice-call] Late transcript line added to ended call ${call.callId}`);
    persistCallRecord(this.storePath, call);
    // Finalize already wrote the file: rewrite it with the late line.
    if (typeof call.metadata?.transcriptPath === "string") {
      const metadata = call.metadata;
      const recording: RecordingTranscriptSection | undefined =
        typeof metadata.recordingTranscript === "string"
          ? { text: metadata.recordingTranscript }
          : typeof metadata.recordingTranscriptError === "string"
            ? { error: metadata.recordingTranscriptError }
            : undefined;
      void writeTranscriptFile(
        this.storePath,
        call,
        typeof metadata.summary === "string" ? metadata.summary : undefined,
        recording,
      ).catch(() => {});
    }
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
      this.getRecentCallByProviderCallId(callIdOrProviderCallId) ??
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
        reportedOutcome?: {
          status: string;
          details: string;
          unverified: true;
          note: string;
        };
        transcript: CallRecord["transcript"];
        transcriptPath?: string;
        recordingPath?: string;
        recordingTranscript?: string;
      }
    | undefined
  > {
    const call = await this.findCall(callIdOrProviderCallId);
    if (!call) {
      return undefined;
    }
    const metadata = call.metadata ?? {};
    const candidatePath =
      typeof metadata.transcriptPath === "string"
        ? metadata.transcriptPath
        : transcriptFilePath(this.storePath, call.callId);
    // Only point at files that exist (finalize may not have written it yet).
    const transcriptPath = fs.existsSync(candidatePath) ? candidatePath : undefined;
    const recordingPath =
      typeof metadata.recordingPath === "string" && fs.existsSync(metadata.recordingPath)
        ? metadata.recordingPath
        : undefined;
    return {
      callId: call.callId,
      state: call.state,
      // Summaries created before transcript-only-v2 were allowed to ingest the
      // model's self-reported outcome and may therefore contain unspoken facts.
      summary:
        metadata.summarySource === "transcript-only-v2" && typeof metadata.summary === "string"
          ? metadata.summary
          : undefined,
      reportedOutcome: metadata.outcome
        ? {
            ...(metadata.outcome as { status: string; details: string }),
            unverified: true,
            note: "Model-reported metadata; not part of the captured transcript.",
          }
        : undefined,
      transcript: call.transcript,
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(recordingPath ? { recordingPath } : {}),
      ...(typeof metadata.recordingTranscript === "string"
        ? { recordingTranscript: metadata.recordingTranscript }
        : {}),
    };
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void {
    // Transcript lines that arrive just after the end (in-flight transcription
    // at hangup) go to the recently-ended call instead of being dropped.
    if (
      (event.type === "call.speaking" || (event.type === "call.speech" && event.isFinal)) &&
      !this.getCall(event.callId) &&
      !(event.providerCallId && this.getCallByProviderCallId(event.providerCallId))
    ) {
      const recent =
        this.getRecentCallByProviderCallId(event.callId) ??
        (event.providerCallId ? this.getRecentCallByProviderCallId(event.providerCallId) : undefined);
      if (recent) {
        this.appendLateLine(recent, event);
        return;
      }
    }
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
      // Notify mode: the provider plays the message from the call's TwiML
      // <Say>, so nothing else records it — record it as the bot's line.
      if (
        call.metadata?.mode === "notify" &&
        call.metadata.notifyViaTwiml === true &&
        !call.metadata.notifyMessageRecorded
      ) {
        addTranscriptEntry(call, "bot", initialMessage, call.answeredAt);
        call.metadata = { ...call.metadata, notifyMessageRecorded: true };
        persistCallRecord(this.storePath, call);
      }
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
