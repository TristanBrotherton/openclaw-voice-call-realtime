import type {
  RealtimeConversationSession,
  RealtimeToolHandler,
} from "./openai-realtime-conversation.js";
import type { ContextKind } from "./gpt-live-protocol.js";

/** Creates a fresh voice session (one per call, or one per fallback attempt). */
export type ConversationSessionFactory = {
  runtime: "realtime" | "live";
  createSession: () => RealtimeConversationSession;
};
import type { EffectiveRealtimePolicy } from "../device-policy.js";

type ManagedRealtimeState = "idle" | "connecting" | "active" | "closing" | "closed";

type LifecycleEvent = {
  type:
    | "realtime.connect.start"
    | "realtime.connect.ok"
    | "realtime.connect.fail"
    | "realtime.reconnect.scheduled"
    | "realtime.idle_timeout"
    | "realtime.max_session_reached"
    | "realtime.closed"
    | "realtime.fallback"
    | "realtime.failed";
  at: number;
  detail?: Record<string, unknown>;
};

export class ManagedRealtimeConversationSession {
  private session: RealtimeConversationSession;
  private factories: ConversationSessionFactory[];
  private state: ManagedRealtimeState = "idle";
  private connectedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private lifecycleListeners = new Set<(event: LifecycleEvent) => void>();
  private closedReason: string | null = null;

  /** Callbacks registered on this wrapper, re-attached to a fallback session. */
  private bindings: Array<(session: RealtimeConversationSession) => void> = [];
  private lastInstructions: string | undefined;

  constructor(
    factories: ConversationSessionFactory | ConversationSessionFactory[],
    private readonly policy: EffectiveRealtimePolicy,
  ) {
    this.factories = Array.isArray(factories) ? [...factories] : [factories];
    if (this.factories.length === 0) {
      throw new Error("at least one conversation session factory is required");
    }
    this.session = this.factories.shift()!.createSession();
    this.attachFailure(this.session);
  }

  /** The runtime currently speaking ("live" or "realtime"). */
  get runtime(): "realtime" | "live" {
    return this.session.runtime;
  }

  private bind(fn: (session: RealtimeConversationSession) => void): void {
    this.bindings.push(fn);
    fn(this.session);
  }

  private attachFailure(session: RealtimeConversationSession): void {
    session.onFailure((reason) => {
      if (session !== this.session || this.state === "closed" || this.state === "closing") {
        return;
      }
      this.emit({ type: "realtime.failed", at: Date.now(), detail: { reason, runtime: session.runtime } });
    });
  }

  /** Swap in the next runtime (e.g. Live could not connect -> Realtime). */
  private async fallBack(error: unknown): Promise<boolean> {
    const next = this.factories.shift();
    if (!next) {
      return false;
    }
    const from = this.session.runtime;
    try {
      this.session.close();
    } catch {
      // already gone
    }
    this.session = next.createSession();
    this.attachFailure(this.session);
    for (const fn of this.bindings) {
      fn(this.session);
    }
    if (this.lastInstructions) {
      this.session.updateInstructions(this.lastInstructions);
    }
    this.emit({
      type: "realtime.fallback",
      at: Date.now(),
      detail: {
        from,
        to: next.runtime,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return true;
  }

  async connect(): Promise<void> {
    if (this.state === "active" || this.state === "connecting" || this.state === "closing") {
      return;
    }

    this.state = "connecting";
    this.emit({ type: "realtime.connect.start", at: Date.now() });

    try {
      for (;;) {
        try {
          await this.session.connect();
          break;
        } catch (error) {
          if (!(await this.fallBack(error))) {
            throw error;
          }
        }
      }
      this.state = "active";
      this.connectedAt = Date.now();
      this.lastActivityAt = this.connectedAt;
      this.armTimers();
      this.emit({ type: "realtime.connect.ok", at: this.connectedAt });
    } catch (error) {
      this.state = "idle";
      this.emit({
        type: "realtime.connect.fail",
        at: Date.now(),
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  sendAudio(audio: Buffer): void {
    // Not activity: Twilio streams 20 ms frames continuously, silence included,
    // so counting frames would keep the idle timer from ever firing. Activity
    // is speech (transcripts, bot audio) and tool calls.
    this.session.sendAudio(audio);
  }

  close(reason = "manual_close"): void {
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    this.state = "closing";
    this.closedReason = reason;
    this.clearTimers();
    this.session.close();
    this.state = "closed";
    this.emit({ type: "realtime.closed", at: Date.now(), detail: { reason } });
  }

  isConnected(): boolean {
    return this.state === "active" && this.session.isConnected();
  }

  triggerGreeting(message?: string): void {
    this.noteActivity();
    this.session.triggerGreeting(message);
  }

  say(message: string): void {
    this.noteActivity();
    this.session.say(message);
  }

  instruct(instructions: string): void {
    this.noteActivity();
    this.session.instruct(instructions);
  }

  onToolCall(handler: RealtimeToolHandler): void {
    this.bind((s) =>
      s.onToolCall((name, args) => {
        this.noteActivity();
        return handler(name, args);
      }),
    );
  }

  onResponseDone(callback: () => void): void {
    this.bind((s) => s.onResponseDone(callback));
  }

  /** Live only: the caller talked over the bot; yield at once. No-op on Realtime (its VAD does this). */
  interrupt(): void {
    (this.session as RealtimeConversationSession & { interrupt?: () => void }).interrupt?.();
  }

  /** Live only: inject context (instructions/thinking/commentary). No-op on Realtime. */
  appendContext(kind: ContextKind, text: string): void {
    const s = this.session as RealtimeConversationSession & {
      appendContext?: (kind: ContextKind, text: string) => void;
    };
    s.appendContext?.(kind, text);
  }

  isResponseActive(): boolean {
    return this.session.isResponseActive();
  }

  setEndingMode(enabled: boolean): void {
    this.session.setEndingMode(enabled);
  }

  updateInstructions(instructions: string): void {
    this.lastInstructions = instructions;
    this.noteActivity();
    this.session.updateInstructions(instructions);
  }

  onAudioDelta(callback: (chunk: Buffer) => void): void {
    this.bind((s) =>
      s.onAudioDelta((chunk) => {
        this.noteActivity();
        callback(chunk);
      }),
    );
  }

  onSpeechStart(callback: () => void): void {
    this.bind((s) =>
      s.onSpeechStart(() => {
        this.noteActivity();
        callback();
      }),
    );
  }

  onTranscriptDelta(callback: (partial: string) => void): void {
    this.bind((s) =>
      s.onTranscriptDelta((partial) => {
        this.noteActivity();
        callback(partial);
      }),
    );
  }

  onTranscriptDone(callback: (text: string) => void): void {
    this.bind((s) =>
      s.onTranscriptDone((text) => {
        this.noteActivity();
        callback(text);
      }),
    );
  }

  onResponseTranscriptDelta(callback: (partial: string) => void): void {
    this.bind((s) =>
      s.onResponseTranscriptDelta((partial) => {
        this.noteActivity();
        callback(partial);
      }),
    );
  }

  onResponseTranscriptDone(callback: (text: string) => void): void {
    this.bind((s) =>
      s.onResponseTranscriptDone((text) => {
        this.noteActivity();
        callback(text);
        if (this.policy.closeAfterAssistantDone) {
          this.close("assistant_done");
        }
      }),
    );
  }

  onLifecycleEvent(callback: (event: LifecycleEvent) => void): void {
    this.lifecycleListeners.add(callback);
  }

  private noteActivity(): void {
    // Only record the timestamp; the idle timer re-checks lastActivityAt when
    // it fires and re-arms itself. Rearming here would churn a timer per
    // 20ms audio frame (~50 clearTimeout/setTimeout pairs per second).
    this.lastActivityAt = Date.now();
  }

  private armTimers(): void {
    this.rearmIdleTimer();
    if (this.policy.maxSessionMs > 0) {
      this.maxTimer = setTimeout(() => {
        this.emit({ type: "realtime.max_session_reached", at: Date.now() });
        this.close("max_session_reached");
      }, this.policy.maxSessionMs);
      this.maxTimer.unref?.();
    }
  }

  private rearmIdleTimer(): void {
    if (this.policy.idleTimeoutMs <= 0) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      const lastActivityAt = this.lastActivityAt ?? this.connectedAt ?? Date.now();
      const idleForMs = Date.now() - lastActivityAt;
      if (idleForMs < this.policy.idleTimeoutMs) {
        this.rearmIdleTimer();
        return;
      }
      this.emit({
        type: "realtime.idle_timeout",
        at: Date.now(),
        detail: { idleForMs },
      });
      this.close("idle_timeout");
    }, this.policy.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  private emit(event: LifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }
}

export function createManagedRealtimeConversationSession(params: {
  provider: ConversationSessionFactory | ConversationSessionFactory[];
  policy: EffectiveRealtimePolicy;
}): ManagedRealtimeConversationSession {
  return new ManagedRealtimeConversationSession(params.provider, params.policy);
}
