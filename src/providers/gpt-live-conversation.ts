/**
 * GPT-Live conversation session for phone calls.
 *
 * Twilio mu-law 8 kHz <-> GPT-Live PCM16 24 kHz. GPT-Live listens and speaks;
 * the call tools run through Responses delegation (a backend model calls them,
 * this session answers with the results). Implements the same session
 * interface as the Realtime provider so the call flow does not care which
 * runtime is speaking.
 *
 * Differences from Realtime that shape this file:
 * - No VAD settings and no response lifecycle: "speaking" is derived from the
 *   output audio itself (audible frames, then quiet), and the bot transcript
 *   line is closed when the voice goes quiet.
 * - `session.start` must be the first message and fixes the prompt, so start is
 *   deferred until the call prompt is known (updateInstructions) and caller
 *   audio received before `session.started` is replayed (up to 5 s).
 * - Output streams at about real time, including silence; LiveOutputPacer
 *   keeps Twilio's buffer short and steady.
 */

import WebSocket from "ws";
import { LiveOutputPacer, PlayoutClock } from "../audio-pacing.js";
import {
  Downsampler24kTo8k,
  Upsampler8kTo24k,
  mulawToPcm,
  pcmPeak,
  pcmToMulaw,
} from "../telephony-audio.js";
import {
  DelegationLedger,
  LIVE_URL,
  buildSessionStart,
  contextAppends,
  functionCallOutput,
  historyToSessionInput,
  responseCreate,
  type ContextKind,
} from "./gpt-live-protocol.js";
import type {
  RealtimeConversationSession,
  RealtimeToolDefinition,
  RealtimeToolHandler,
  RealtimeToolResult,
} from "./openai-realtime-conversation.js";

export type GptLiveConfig = {
  apiKey: string;
  model: string;
  voice?: string;
  backendModel: string;
  reasoningEffort?: string;
  serviceTier?: string;
  systemPrompt?: string;
  tools?: RealtimeToolDefinition[];
  /** Test seam: WebSocket factory and clock. */
  connectWs?: (url: string, apiKey: string) => WebSocket;
  now?: () => number;
};

const CONNECT_TIMEOUT_MS = 10_000;
/** If the call prompt never arrives, start with the base prompt after this. */
const START_DEADLINE_MS = 2_000;
/** Caller audio kept for replay until session.started. */
const PRESTART_AUDIO_MAX_MS = 5_000;
/** Caller audio is sent in 40 ms batches (24 kHz PCM16). */
const INPUT_BATCH_BYTES = 24000 * 2 * 0.04;
/** Bot output 20 ms frame at 8 kHz PCM16. */
const OUTPUT_FRAME_BYTES = 320;
/** Output peak above this is audible speech. */
const AUDIBLE_PEAK = 400;
/** Bot is considered done speaking after this much played-out quiet. */
const SPEECH_QUIET_MS = 700;
/** A user turn closes after this long without transcript deltas. */
const USER_TURN_GAP_MS = 800;
/** After say()/instruct(), how long a reply is expected before giving up. */
const EXPECT_SPEECH_MS = 4_000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class GptLiveConversationSession implements RealtimeConversationSession {
  readonly runtime = "live" as const;

  private ws: WebSocket | null = null;
  private connected = false;
  private started = false;
  private closed = false;
  private reconnectAttempts = 0;
  private instructions: string | undefined;
  private startTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  private readonly upsampler = new Upsampler8kTo24k();
  private downsampler = new Downsampler24kTo8k();
  private inputBatch: Buffer[] = [];
  private inputBatchBytes = 0;
  private prestart: Buffer[] = [];
  private prestartBytes = 0;
  private outputRemainder = Buffer.alloc(0);
  private readonly clock: PlayoutClock;
  private readonly pacer: LiveOutputPacer;

  private ledger = new DelegationLedger();
  private endingMode = false;
  /** Played-out time (ms) at which the last audible bot frame ends. */
  private lastAudibleEnd = 0;
  private speaking = false;
  /** After an interruption: drop output until the voice goes quiet. */
  private mutedUntilQuiet = false;
  private expectSpeechUntil = 0;
  private quietTimer: NodeJS.Timeout | null = null;

  private botLine = "";
  private userLine = "";
  private userTurnTimer: NodeJS.Timeout | null = null;
  /** Conversation so far, replayed as session.input on reconnect. */
  private history: Array<{ role: "user" | "assistant"; text: string }> = [];

  private onAudioDeltaCallback: ((chunk: Buffer) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private onTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onTranscriptDoneCallback: ((text: string) => void) | null = null;
  private onResponseTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onResponseTranscriptDoneCallback: ((text: string) => void) | null = null;
  private onToolCallHandler: RealtimeToolHandler | null = null;
  private onResponseDoneCallbacks: Array<() => void> = [];
  private onFailureCallbacks: Array<(reason: string) => void> = [];

  constructor(private readonly config: GptLiveConfig) {
    this.now = config.now ?? Date.now;
    this.instructions = config.systemPrompt;
    this.clock = new PlayoutClock(this.now);
    this.pacer = new LiveOutputPacer(this.clock, (frame) => this.emitFrame(frame));
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.config.connectWs
        ? this.config.connectWs(LIVE_URL, this.config.apiKey)
        : new WebSocket(LIVE_URL, { headers: { Authorization: `Bearer ${this.config.apiKey}` } });
      this.ws = ws;
      this.started = false;
      const timeout = setTimeout(() => {
        if (!this.connected) {
          ws.terminate();
          reject(new Error("GPT-Live connection timeout"));
        }
      }, CONNECT_TIMEOUT_MS);
      timeout.unref?.();

      ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        // A reconnect knows its prompt already; a first connect waits briefly
        // for the call prompt so session.start carries the real instructions.
        if (this.history.length > 0 || this.instructions !== this.config.systemPrompt) {
          this.sendStart();
        } else {
          this.startTimer = setTimeout(() => this.sendStart(), START_DEADLINE_MS);
          this.startTimer.unref?.();
        }
        resolve();
      });
      ws.on("message", (data: Buffer) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        this.handleEvent(event);
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(err);
        } else {
          console.warn("[GptLive] WebSocket error:", err.message);
        }
      });
      ws.on("close", (code, reason) => {
        clearTimeout(timeout);
        const wasConnected = this.connected;
        this.connected = false;
        this.started = false;
        if (!this.closed && wasConnected) {
          console.warn(
            `[GptLive] session closed unexpectedly (code=${code} reason=${reason?.toString?.() ?? ""}); reconnecting`,
          );
          void this.reconnect();
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    while (!this.closed && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (this.reconnectAttempts - 1)));
      if (this.closed) {
        return;
      }
      try {
        this.flushUserLine();
        this.ledger.reset();
        this.downsampler = new Downsampler24kTo8k();
        this.outputRemainder = Buffer.alloc(0);
        await this.open();
        console.log(`[GptLive] reconnected (attempt ${this.reconnectAttempts}) with ${this.history.length} history items`);
        return;
      } catch (err) {
        console.warn(
          `[GptLive] reconnect attempt ${this.reconnectAttempts} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (!this.closed) {
      this.fail("reconnect_exhausted");
    }
  }

  private fail(reason: string): void {
    for (const cb of this.onFailureCallbacks) {
      try {
        cb(reason);
      } catch (err) {
        console.warn("[GptLive] failure callback error:", err);
      }
    }
  }

  private sendStart(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.started || !this.connected) {
      return;
    }
    const instructions = this.instructions ?? "";
    this.send(
      buildSessionStart({
        model: this.config.model,
        instructions: `${instructions}\n\n${LIVE_VOICE_DELEGATION}`,
        backendModel: this.config.backendModel,
        backendInstructions: buildBackendInstructions(instructions),
        tools: (this.config.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        voice: this.config.voice,
        reasoningEffort: this.config.reasoningEffort,
        serviceTier: this.config.serviceTier,
        history: historyToSessionInput(this.history),
      }),
    );
    this.started = true;
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
      case "session.started": {
        // Replay caller audio that arrived before the session was ready.
        const buffered = this.prestart;
        this.prestart = [];
        this.prestartBytes = 0;
        for (const chunk of buffered) {
          this.sendInput(chunk);
        }
        break;
      }
      case "session.output_audio.delta": {
        const b64 = (event.delta ?? event.audio) as string | undefined;
        if (b64) {
          this.handleOutputAudio(Buffer.from(b64, "base64"));
        }
        break;
      }
      case "session.output_transcript.delta": {
        const delta = event.delta as string | undefined;
        if (delta) {
          this.botLine += delta;
          this.onResponseTranscriptDeltaCallback?.(this.botLine);
        }
        break;
      }
      case "session.input_transcript.delta": {
        const delta = event.delta as string | undefined;
        if (!delta) {
          break;
        }
        if (!this.userLine) {
          this.handleUserTurnStart();
        }
        this.userLine += delta;
        this.onTranscriptDeltaCallback?.(this.userLine.trim());
        if (this.userTurnTimer) {
          clearTimeout(this.userTurnTimer);
        }
        this.userTurnTimer = setTimeout(() => this.flushUserLine(), USER_TURN_GAP_MS);
        this.userTurnTimer.unref?.();
        break;
      }
      case "response.event": {
        const { call, continueNow } = this.ledger.observe(event);
        if (call) {
          void this.runTool(call.callId, call.name, call.arguments);
        }
        if (continueNow) {
          this.send(responseCreate());
        }
        break;
      }
      case "session.usage.updated":
        break;
      case "session.closed":
        console.log(`[GptLive] session closed: ${String(event.reason ?? "")}`);
        break;
      case "error": {
        const err = (event.error ?? event) as Record<string, unknown>;
        console.error("[GptLive] API error:", JSON.stringify(err).slice(0, 500));
        break;
      }
    }
  }

  /** The caller started a new turn (first transcript words). */
  private handleUserTurnStart(): void {
    if (this.endingMode) {
      return;
    }
    // Barge-in: drop audio still queued at Twilio; GPT-Live decides itself
    // whether to stop talking.
    if (this.isSpeakingNow()) {
      this.pacer.reset();
      this.clock.clear();
    }
    this.onSpeechStartCallback?.();
  }

  private flushUserLine(): void {
    if (this.userTurnTimer) {
      clearTimeout(this.userTurnTimer);
      this.userTurnTimer = null;
    }
    const text = this.userLine.trim();
    this.userLine = "";
    if (text) {
      this.history.push({ role: "user", text });
      this.onTranscriptDoneCallback?.(text);
    }
  }

  private flushBotLine(): void {
    const text = this.botLine.trim();
    this.botLine = "";
    if (text) {
      this.history.push({ role: "assistant", text });
      this.onResponseTranscriptDoneCallback?.(text);
    }
  }

  private handleOutputAudio(pcm24k: Buffer): void {
    const pcm8k = this.downsampler.process(pcm24k);
    if (this.mutedUntilQuiet) {
      if (pcmPeak(pcm8k) > AUDIBLE_PEAK) {
        this.outputRemainder = Buffer.alloc(0);
        return; // the rest of the interrupted utterance
      }
      this.mutedUntilQuiet = false;
      this.checkQuiet();
    }
    let data = this.outputRemainder.length ? Buffer.concat([this.outputRemainder, pcm8k]) : pcm8k;
    let offset = 0;
    while (data.length - offset >= OUTPUT_FRAME_BYTES) {
      this.pacer.push(data.subarray(offset, offset + OUTPUT_FRAME_BYTES));
      offset += OUTPUT_FRAME_BYTES;
    }
    this.outputRemainder = Buffer.from(data.subarray(offset));
    data = Buffer.alloc(0);
  }

  /** A paced frame goes to Twilio now; it plays at clock.drainedAt(). */
  private emitFrame(frame: Buffer): void {
    if (pcmPeak(frame) > AUDIBLE_PEAK) {
      this.lastAudibleEnd = this.clock.drainedAt();
      this.expectSpeechUntil = 0;
      if (!this.speaking) {
        this.speaking = true;
      }
      this.armQuietTimer();
    }
    this.onAudioDeltaCallback?.(pcmToMulaw(frame));
  }

  private armQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    const due = Math.max(0, this.lastAudibleEnd + SPEECH_QUIET_MS - this.now());
    this.quietTimer = setTimeout(() => this.checkQuiet(), due);
    this.quietTimer.unref?.();
  }

  private checkQuiet(): void {
    this.quietTimer = null;
    if (!this.speaking) {
      return;
    }
    if (this.now() < this.lastAudibleEnd + SPEECH_QUIET_MS) {
      this.armQuietTimer();
      return;
    }
    this.speaking = false;
    this.flushBotLine();
    for (const cb of this.onResponseDoneCallbacks) {
      try {
        cb();
      } catch (err) {
        console.warn("[GptLive] response-done callback error:", err);
      }
    }
  }

  private isSpeakingNow(): boolean {
    return this.speaking || this.now() < this.lastAudibleEnd;
  }

  private async runTool(callId: string, name: string, args: Record<string, unknown>): Promise<void> {
    console.log(`[GptLive] Tool call: ${name} (${JSON.stringify(args).length} arg bytes)`);
    let result: RealtimeToolResult;
    try {
      result = this.onToolCallHandler
        ? await this.onToolCallHandler(name, args)
        : `Error: tool ${name} is not available`;
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const output = typeof result === "string" ? result : result.output;
    this.send(functionCallOutput(callId, output || "ok"));
    if (this.ledger.complete(callId)) {
      this.send(responseCreate());
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private sendInput(pcm24k: Buffer): void {
    this.send({ type: "session.input_audio.append", audio: pcm24k.toString("base64") });
  }

  sendAudio(muLawData: Buffer): void {
    const pcm24k = this.upsampler.process(mulawToPcm(muLawData));
    this.inputBatch.push(pcm24k);
    this.inputBatchBytes += pcm24k.length;
    if (this.inputBatchBytes < INPUT_BATCH_BYTES) {
      return;
    }
    const batch = Buffer.concat(this.inputBatch);
    this.inputBatch = [];
    this.inputBatchBytes = 0;
    if (this.connected && this.started && this.prestart.length === 0) {
      this.sendInput(batch);
      return;
    }
    // Not ready yet: keep the newest few seconds for replay.
    this.prestart.push(batch);
    this.prestartBytes += batch.length;
    const max = (24000 * 2 * PRESTART_AUDIO_MAX_MS) / 1000;
    while (this.prestartBytes > max && this.prestart.length > 1) {
      this.prestartBytes -= this.prestart.shift()!.length;
    }
  }

  appendContext(kind: ContextKind, text: string): void {
    for (const evt of contextAppends(kind, text)) {
      this.send(evt);
    }
  }

  onAudioDelta(callback: (chunk: Buffer) => void): void {
    this.onAudioDeltaCallback = callback;
  }
  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }
  onTranscriptDelta(callback: (partial: string) => void): void {
    this.onTranscriptDeltaCallback = callback;
  }
  onTranscriptDone(callback: (text: string) => void): void {
    this.onTranscriptDoneCallback = callback;
  }
  onResponseTranscriptDelta(callback: (partial: string) => void): void {
    this.onResponseTranscriptDeltaCallback = callback;
  }
  onResponseTranscriptDone(callback: (text: string) => void): void {
    this.onResponseTranscriptDoneCallback = callback;
  }
  onToolCall(handler: RealtimeToolHandler): void {
    this.onToolCallHandler = handler;
  }
  onResponseDone(callback: () => void): void {
    this.onResponseDoneCallbacks.push(callback);
  }
  onFailure(callback: (reason: string) => void): void {
    this.onFailureCallbacks.push(callback);
  }

  /** Speaking, about to speak (after say/instruct), or a delegated task is running. */
  isResponseActive(): boolean {
    return this.isSpeakingNow() || this.now() < this.expectSpeechUntil;
  }

  isBusy(): boolean {
    return this.ledger.busy;
  }

  setEndingMode(enabled: boolean): void {
    this.endingMode = enabled;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pacer.flush();
    this.flushUserLine();
    if (this.speaking) {
      this.flushBotLine();
    }
    for (const t of [this.startTimer, this.quietTimer, this.userTurnTimer]) {
      if (t) {
        clearTimeout(t);
      }
    }
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session.close" }));
      // Billing runs until the session closes; don't wait long for the ack.
      const t = setTimeout(() => ws.terminate(), 1500);
      t.unref?.();
      ws.on("close", () => clearTimeout(t));
    } else {
      ws?.terminate();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // GPT-Live speaks when it decides to; an instructions.append is only
  // context and was measured to leave it silent for 40 s+ (voicemail after
  // the beep). Commentary is what it says next, in its own words, so every
  // "speak now" request goes through commentary, framed as a note to act on.
  triggerGreeting(message?: string): void {
    this.appendContext(
      "commentary",
      message
        ? "Speak now (this note is for you, don't read it out): open the call with ONE short " +
            `greeting that identifies you and gives the purpose of this call in natural words: ${message}`
        : "Speak now (this note is for you, don't read it out): greet the other person briefly.",
    );
    this.expectSpeechUntil = this.now() + EXPECT_SPEECH_MS;
  }

  updateInstructions(instructions: string): void {
    this.instructions = instructions;
    if (!this.started) {
      this.sendStart();
      return;
    }
    this.appendContext("instructions", `Updated call instructions:\n${instructions}`);
  }

  say(message: string): void {
    this.appendContext("commentary", message);
    this.expectSpeechUntil = this.now() + EXPECT_SPEECH_MS;
  }

  instruct(instructions: string): void {
    this.appendContext(
      "commentary",
      `Act on this now, in your own words (this note is for you, don't read it out): ${instructions}`,
    );
    this.expectSpeechUntil = this.now() + EXPECT_SPEECH_MS;
  }

  /**
   * The caller started talking over the bot: drop what is queued, stop
   * forwarding the current utterance, and tell the voice (quietly) to yield.
   * GPT-Live otherwise keeps talking ~1.5 s into an interruption.
   */
  interrupt(): void {
    if (!this.isSpeakingNow() || this.endingMode) {
      return;
    }
    this.pacer.reset();
    this.clock.clear();
    this.mutedUntilQuiet = true;
    this.appendContext("thinking", "The other person just interrupted you. Stop talking and listen to them.");
    this.onSpeechStartCallback?.();
  }
}

/**
 * GPT-Live's voice cannot call tools; it decides when to hand work to the
 * backend. The call prompt names tools (written for Realtime), so tell the
 * voice plainly what to delegate and how to behave meanwhile.
 */
export const LIVE_VOICE_DELEGATION =
  "HOW ACTIONS WORK ON THIS CALL: you do the talking; a backend assistant does every action. " +
  "Whenever the instructions above say to use a tool, delegate that task to the backend instead " +
  "(describe what is needed in plain words). Always delegate: pressing phone keys for a menu; " +
  "saving the outcome of the call; ending the call; lookups and questions for the person you " +
  "work for; transfers; home and calendar checks. Ending the call: when the conversation is " +
  "over — or the other person says goodbye or wishes you a good day — answer with a warm " +
  "goodbye of your own (\"You too — goodbye!\"), then delegate 'save the outcome and end the " +
  "call' WITHOUT saying anything more: no \"just a moment\", no \"one second\" at the end of a " +
  "call. When your goal is done and confirmed, close in the same breath (\"Thanks so much " +
  "for your help — goodbye!\") instead of waiting for them to end it. Never leave the line " +
  "open after a goodbye. While delegated work runs, keep the " +
  "conversation natural and short; never " +
  "say an action is done or state a result before the backend's result arrives.";

/**
 * The delegated backend decides which call tool to use. It gets the full call
 * prompt (it has to know the goal, the trust tier and the tool rules) plus a
 * short brief about its role: GPT-Live speaks its final text to the caller.
 */
export function buildBackendInstructions(callPrompt: string): string {
  return (
    "You are the task backend for a live phone call. A voice model is talking to the " +
    "other party and delegates to you whenever a tool is needed (ending the call, " +
    "saving the outcome, pressing keypad keys, lookups, owner questions, transfers, " +
    "home and calendar). Use the tools as the call instructions below describe. Your " +
    "final text is spoken to the other party by the voice model: keep it to one or two " +
    "short spoken sentences of verified facts, no lists, no markdown, nothing internal. " +
    "Never claim an action succeeded unless its tool result says so.\n\n" +
    "CALL INSTRUCTIONS:\n" +
    callPrompt
  );
}
