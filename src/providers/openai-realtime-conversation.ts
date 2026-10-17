/**
 * OpenAI Realtime Conversation Provider
 *
 * Full conversation mode: Twilio audio -> OpenAI Realtime (STT + LLM + TTS) -> mu-law -> Twilio.
 *
 * Uses the GA Realtime API (the beta API shape was retired by OpenAI with
 * error code `beta_api_shape_disabled`). Event handlers accept both GA and
 * legacy beta event names for safety.
 */

import WebSocket from "ws";
import { PlayoutClock } from "../audio-pacing.js";

export interface RealtimeConversationConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  systemPrompt?: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
  turnDetection?: "server_vad" | "semantic_vad";
  vadEagerness?: "low" | "medium" | "high" | "auto";
  language?: string;
  tools?: RealtimeToolDefinition[];
}

/** Function tool exposed to the realtime model during a call. */
export interface RealtimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type RealtimeToolResult = string | { output: string; respond?: boolean };

export type RealtimeToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<RealtimeToolResult>;

export interface RealtimeConversationSession {
  /** Which voice runtime this session runs on. */
  readonly runtime: "realtime" | "live";
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  onAudioDelta(callback: (chunk: Buffer) => void): void;
  onSpeechStart(callback: () => void): void;
  onTranscriptDelta(callback: (partial: string) => void): void;
  onTranscriptDone(callback: (text: string) => void): void;
  onResponseTranscriptDelta(callback: (partial: string) => void): void;
  onResponseTranscriptDone(callback: (text: string) => void): void;
  close(): void;
  isConnected(): boolean;
  triggerGreeting(message?: string): void;
  /** Update the session instructions (system prompt) for the current call. */
  updateInstructions(instructions: string): void;
  /** Speak a verbatim message through the realtime voice (used by speak/continue tools). */
  say(message: string): void;
  /** Prompt the model to respond following ad-hoc instructions (not verbatim). */
  instruct(instructions: string): void;
  /** Register a handler invoked when the model calls a function tool. */
  onToolCall(handler: RealtimeToolHandler): void;
  /** Register a callback fired when a model response completes. */
  onResponseDone(callback: () => void): void;
  /** Whether a model response is currently in flight. */
  isResponseActive(): boolean;
  /**
   * Ending mode: once the call is wrapping up, incoming speech no longer
   * cancels responses or clears buffered audio (barge-in off), so the
   * goodbye cannot be flushed by the other party talking over it.
   */
  setEndingMode(enabled: boolean): void;
  /** Fired once when the session is lost for good (reconnects exhausted). */
  onFailure(callback: (reason: string) => void): void;
}

export class OpenAIRealtimeConversationProvider {
  readonly name = "openai-realtime-conversation";
  readonly runtime = "realtime" as const;
  private apiKey: string;
  private model: string;
  private voice: string;
  private systemPrompt: string | undefined;
  private silenceDurationMs: number;
  private vadThreshold: number;
  private tools: RealtimeToolDefinition[];
  private turnDetection: "server_vad" | "semantic_vad";
  private vadEagerness: "low" | "medium" | "high" | "auto";
  private language: string | undefined;

  constructor(config: RealtimeConversationConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime Conversation");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-realtime";
    this.voice = config.voice || "alloy";
    this.systemPrompt = config.systemPrompt;
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.5;
    this.tools = config.tools ?? [];
    this.turnDetection = config.turnDetection ?? "server_vad";
    this.vadEagerness = config.vadEagerness ?? "auto";
    this.language = config.language;
  }

  /** `tools` overrides the provider's tool list for this one session (per-call tools). */
  createSession(tools?: RealtimeToolDefinition[]): RealtimeConversationSession {
    return new OpenAIRealtimeConversationSession(
      this.apiKey,
      this.model,
      this.voice,
      this.systemPrompt,
      this.silenceDurationMs,
      this.vadThreshold,
      tools ?? this.tools,
      this.turnDetection,
      this.vadEagerness,
      this.language,
    );
  }
}

class OpenAIRealtimeConversationSession implements RealtimeConversationSession {
  readonly runtime = "realtime" as const;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  /** When the current socket opened; attempts reset only after a stable session. */
  private openedAt = 0;
  private static readonly STABLE_SESSION_MS = 30_000;
  /** Whether a model response is currently in flight (between response.created and response.done). */
  private responseActive = false;
  /** When true (call ending), barge-in is disabled so the goodbye plays out. */
  private endingMode = false;
  /**
   * Effective session instructions. Starts as the constructor system prompt and
   * is replaced by updateInstructions(); re-applied on every (re)connect so a
   * mid-call websocket reconnect does not silently drop call context.
   */
  private currentInstructions: string | undefined;

  private onAudioDeltaCallback: ((chunk: Buffer) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private onTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onTranscriptDoneCallback: ((text: string) => void) | null = null;
  private onResponseTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onResponseTranscriptDoneCallback: ((text: string) => void) | null = null;
  private onToolCallHandler: RealtimeToolHandler | null = null;
  private onResponseDoneCallbacks: Array<() => void> = [];
  private onFailureCallbacks: Array<(reason: string) => void> = [];
  /** Conversation so far, replayed into a fresh session after a reconnect. */
  private history: Array<{ role: "user" | "assistant"; text: string }> = [];
  /** What Twilio has buffered: every audio delta is forwarded as it arrives. */
  private readonly clock = new PlayoutClock();
  /** The assistant audio item currently streaming, and how much of it was sent (ms). */
  private currentAudioItem: { itemId: string; sentMs: number } | null = null;

  private pendingInputTranscript = "";
  private pendingResponseTranscript = "";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice: string,
    private readonly systemPrompt: string | undefined,
    private readonly silenceDurationMs: number,
    private readonly vadThreshold: number,
    private readonly tools: RealtimeToolDefinition[] = [],
    private readonly turnDetection: "server_vad" | "semantic_vad" = "server_vad",
    private readonly vadEagerness: "low" | "medium" | "high" | "auto" = "auto",
    private readonly language: string | undefined = undefined,
  ) {
    this.currentInstructions = systemPrompt;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private buildSessionUpdate(): Record<string, unknown> {
    const session: Record<string, unknown> = {
      type: "realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: {
            model: "gpt-4o-transcribe",
            ...(this.language ? { language: this.language } : {}),
          },
          turn_detection:
            this.turnDetection === "semantic_vad"
              ? { type: "semantic_vad", eagerness: this.vadEagerness }
              : {
                  type: "server_vad",
                  threshold: this.vadThreshold,
                  silence_duration_ms: this.silenceDurationMs,
                },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: this.voice,
        },
      },
    };
    if (this.currentInstructions) {
      session.instructions = this.currentInstructions;
    }
    if (this.tools.length > 0) {
      session.tools = this.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      session.tool_choice = "auto";
    }
    return session;
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;

      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          ws.terminate();
          reject(new Error("Realtime Conversation connection timeout"));
        }
      }, OpenAIRealtimeConversationSession.CONNECT_TIMEOUT_MS);
      connectTimeout.unref?.();

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        // Do not reset reconnectAttempts here: a socket that opens and drops
        // straight away would loop forever. It resets on close after a stable session.
        this.openedAt = Date.now();
        this.responseActive = false;

        this.sendEvent({ type: "session.update", session: this.buildSessionUpdate() });
        this.replayHistory();
        resolve();
      });

      ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleEvent(event);
        } catch (e) {
          console.error("[RealtimeConversation] Failed to parse event:", e);
        }
      });

      ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (!this.connected) {
          reject(error);
        } else {
          console.warn("[RealtimeConversation] WebSocket error:", error.message);
        }
      });

      ws.on("close", (code, reason) => {
        clearTimeout(connectTimeout);
        const wasOpen = this.connected;
        this.connected = false;
        this.responseActive = false;
        const upMs = wasOpen ? Date.now() - this.openedAt : 0;
        if (!this.closed) {
          if (upMs >= OpenAIRealtimeConversationSession.STABLE_SESSION_MS) {
            this.reconnectAttempts = 0;
          }
          console.warn(
            `[RealtimeConversation] WebSocket closed unexpectedly (code=${code} reason=${reason?.toString?.() ?? ""} up=${Math.round(upMs / 1000)}s attempts=${this.reconnectAttempts}); attempting reconnect`,
          );
          void this.attemptReconnect();
        }
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.reconnectAttempts >= OpenAIRealtimeConversationSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[RealtimeConversation] Giving up after ${this.reconnectAttempts} reconnect attempts`,
      );
      for (const cb of this.onFailureCallbacks) {
        try {
          cb("reconnect_exhausted");
        } catch (err) {
          console.warn("[RealtimeConversation] failure callback error:", err);
        }
      }
      return;
    }

    this.reconnectAttempts++;
    const delay =
      OpenAIRealtimeConversationSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log(
        `[RealtimeConversation] Reconnected (attempt ${this.reconnectAttempts}); session config re-applied`,
      );
    } catch (err) {
      console.warn(
        `[RealtimeConversation] Reconnect attempt ${this.reconnectAttempts} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      void this.attemptReconnect();
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
      case "input_audio_buffer.speech_started":
        // While ending, ignore barge-in entirely: cancelling or clearing the
        // Twilio buffer here would flush the goodbye mid-sentence.
        if (this.endingMode) {
          break;
        }
        // Barge-in: cancel any in-flight response so the model stops talking.
        if (this.responseActive) {
          this.sendEvent({ type: "response.cancel" });
        } else {
          // A partial bot line whose response already finished without a
          // transcript.done: keep what was said rather than dropping it.
          this.flushInterruptedResponseTranscript();
        }
        this.truncateUnheardAudio();
        this.onSpeechStartCallback?.();
        break;

      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        if ((event.response as { status?: string } | undefined)?.status === "cancelled") {
          this.flushInterruptedResponseTranscript();
        }
        for (const callback of this.onResponseDoneCallbacks) {
          try {
            callback();
          } catch (err) {
            console.warn("[RealtimeConversation] response-done callback error:", err);
          }
        }
        break;

      case "response.output_item.done": {
        const item = event.item as
          | { type?: string; name?: string; call_id?: string; arguments?: string }
          | undefined;
        if (item?.type === "function_call" && item.name && item.call_id) {
          this.handleFunctionCall(item.name, item.call_id, item.arguments ?? "{}");
        }
        break;
      }

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingInputTranscript += event.delta as string;
          this.onTranscriptDeltaCallback?.(this.pendingInputTranscript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.history.push({ role: "user", text: event.transcript as string });
          this.onTranscriptDoneCallback?.(event.transcript as string);
        }
        this.pendingInputTranscript = "";
        break;

      // GA name first, legacy beta name kept as alias.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (event.delta) {
          const chunk = Buffer.from(event.delta as string, "base64");
          const itemId = event.item_id as string | undefined;
          const ms = chunk.length / 8; // mu-law 8 kHz: 8 bytes per ms
          if (itemId) {
            if (this.currentAudioItem?.itemId !== itemId) {
              this.currentAudioItem = { itemId, sentMs: 0 };
            }
            this.currentAudioItem.sentMs += ms;
          }
          this.clock.push(ms);
          this.onAudioDeltaCallback?.(chunk);
        }
        break;

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (event.delta) {
          this.pendingResponseTranscript += event.delta as string;
          this.onResponseTranscriptDeltaCallback?.(this.pendingResponseTranscript);
        }
        break;

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (event.transcript) {
          this.history.push({ role: "assistant", text: event.transcript as string });
          this.onResponseTranscriptDoneCallback?.(event.transcript as string);
        }
        this.pendingResponseTranscript = "";
        break;

      case "error": {
        const err = event.error as Record<string, unknown> | undefined;
        const code = err?.code as string | undefined;
        // response.cancel with nothing active is benign; everything else matters.
        if (code !== "response_cancel_not_active") {
          console.error(
            "[RealtimeConversation] API error:",
            JSON.stringify(err ?? event).slice(0, 500),
          );
        }
        break;
      }
    }
  }

  /** Emit the partial bot transcript of a cancelled response as an interrupted line. */
  private flushInterruptedResponseTranscript(): void {
    const partial = this.pendingResponseTranscript.trim();
    this.pendingResponseTranscript = "";
    if (partial) {
      this.onResponseTranscriptDoneCallback?.(`${partial} [interrupted]`);
    }
  }

  /**
   * After a barge-in, cut the assistant item at what Twilio actually played,
   * so the model (and its transcript) does not assume the caller heard the
   * rest. Played = sent minus what was still buffered at Twilio.
   */
  private truncateUnheardAudio(): void {
    const item = this.currentAudioItem;
    if (!item) {
      return;
    }
    const unplayedMs = this.clock.leadMs();
    this.clock.clear();
    if (unplayedMs <= 0) {
      return;
    }
    const playedMs = Math.max(0, Math.floor(item.sentMs - unplayedMs));
    this.sendEvent({
      type: "conversation.item.truncate",
      item_id: item.itemId,
      content_index: 0,
      audio_end_ms: playedMs,
    });
    this.currentAudioItem = null;
  }

  /** Replay the transcript into a fresh session so a reconnect keeps the conversation. */
  private replayHistory(): void {
    if (this.history.length === 0) {
      return;
    }
    for (const turn of this.history.slice(-40)) {
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: turn.role,
          content: [{ type: turn.role === "assistant" ? "output_text" : "input_text", text: turn.text }],
        },
      });
    }
  }

  private handleFunctionCall(name: string, callId: string, rawArguments: string): void {
    if (!this.onToolCallHandler) {
      console.warn(`[RealtimeConversation] Tool call ${name} received but no handler registered`);
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      console.warn(`[RealtimeConversation] Tool call ${name} had unparseable arguments`);
    }
    // Log the tool name only — arguments can contain call content (outcome
    // details, goodbye lines, IVR digits), which is personal data.
    console.log(
      `[RealtimeConversation] Tool call: ${name} (${rawArguments.length} arg bytes)`,
    );
    void this.onToolCallHandler(name, args)
      .catch((err): RealtimeToolResult => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[RealtimeConversation] Tool ${name} failed:`, message);
        return `Error: ${message}`;
      })
      .then((result) => {
        const normalized =
          typeof result === "string" ? { output: result, respond: true } : result;
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: normalized.output || "ok",
          },
        });
        // Let the model continue with the tool result unless suppressed
        // (e.g. end_call, where further speech would be cut off by the hangup).
        if (normalized.respond !== false) {
          this.sendEvent({ type: "response.create" });
        }
      });
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) {
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: muLawData.toString("base64"),
    });
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

  isResponseActive(): boolean {
    return this.responseActive;
  }

  onFailure(callback: (reason: string) => void): void {
    this.onFailureCallbacks.push(callback);
  }

  setEndingMode(enabled: boolean): void {
    this.endingMode = enabled;
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.responseActive = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  triggerGreeting(message?: string): void {
    if (!this.connected) {
      return;
    }
    if (message) {
      this.sendEvent({
        type: "response.create",
        response: {
          instructions: this.withSessionInstructions(
            "Open the call with ONE complete greeting to the person who answered: " +
            "identify yourself according to your identity instructions, then deliver " +
            `the purpose of this message as natural spoken conversation: "${message}". ` +
            "Combine identity and purpose into a single opening — this is your only " +
            "introduction and you must not introduce yourself again later in the call. " +
            "If the message reads like an instruction, task description, or narration " +
            "(e.g. 'calling you now'), do not repeat it verbatim — extract the purpose " +
            "and speak it naturally. Never read instructions aloud or mention that you " +
            "were given instructions.",
          ),
        },
      });
      return;
    }
    this.sendEvent({ type: "response.create" });
  }

  updateInstructions(instructions: string): void {
    this.currentInstructions = instructions;
    if (!this.connected) {
      return;
    }
    this.sendEvent({
      type: "session.update",
      session: { type: "realtime", instructions },
    });
  }

  say(message: string): void {
    if (!this.connected) {
      return;
    }
    // Only one response can be in flight; cancel before speaking verbatim.
    if (this.responseActive) {
      this.sendEvent({ type: "response.cancel" });
    }
    this.sendEvent({
      type: "response.create",
      response: { instructions: this.withSessionInstructions(`Say exactly: "${message}"`) },
    });
  }

  instruct(instructions: string): void {
    if (!this.connected) {
      return;
    }
    if (this.responseActive) {
      this.sendEvent({ type: "response.cancel" });
    }
    this.sendEvent({
      type: "response.create",
      response: { instructions: this.withSessionInstructions(instructions) },
    });
  }

  /**
   * Response-level instructions REPLACE the session instructions for that
   * response, so persona, call context and rules must travel with them;
   * otherwise the model forgets who it is ("Hi, this is ChatGPT...").
   */
  private withSessionInstructions(extra: string): string {
    return this.currentInstructions ? `${this.currentInstructions}\n\nRIGHT NOW: ${extra}` : extra;
  }
}
