import type {
  RealtimeConversationSession,
  RealtimeToolHandler,
  OpenAIRealtimeConversationProvider,
} from "./openai-realtime-conversation.js";
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
    | "realtime.closed";
  at: number;
  detail?: Record<string, unknown>;
};

export class ManagedRealtimeConversationSession {
  private session: RealtimeConversationSession;
  private state: ManagedRealtimeState = "idle";
  private connectedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private lifecycleListeners = new Set<(event: LifecycleEvent) => void>();
  private closedReason: string | null = null;

  constructor(
    provider: OpenAIRealtimeConversationProvider,
    private readonly policy: EffectiveRealtimePolicy,
  ) {
    this.session = provider.createSession();
    this.wrapCallbacks();
  }

  async connect(): Promise<void> {
    if (this.state === "active" || this.state === "connecting" || this.state === "closing") {
      return;
    }

    this.state = "connecting";
    this.emit({ type: "realtime.connect.start", at: Date.now() });

    try {
      await this.session.connect();
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
    this.noteActivity();
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

  onToolCall(handler: RealtimeToolHandler): void {
    this.session.onToolCall((name, args) => {
      this.noteActivity();
      return handler(name, args);
    });
  }

  onResponseDone(callback: () => void): void {
    this.session.onResponseDone(callback);
  }

  isResponseActive(): boolean {
    return this.session.isResponseActive();
  }

  setEndingMode(enabled: boolean): void {
    this.session.setEndingMode(enabled);
  }

  updateInstructions(instructions: string): void {
    this.noteActivity();
    this.session.updateInstructions(instructions);
  }

  onAudioDelta(callback: (chunk: Buffer) => void): void {
    this.session.onAudioDelta((chunk) => {
      this.noteActivity();
      callback(chunk);
    });
  }

  onSpeechStart(callback: () => void): void {
    this.session.onSpeechStart(() => {
      this.noteActivity();
      callback();
    });
  }

  onTranscriptDelta(callback: (partial: string) => void): void {
    this.session.onTranscriptDelta((partial) => {
      this.noteActivity();
      callback(partial);
    });
  }

  onTranscriptDone(callback: (text: string) => void): void {
    this.session.onTranscriptDone((text) => {
      this.noteActivity();
      callback(text);
    });
  }

  onResponseTranscriptDelta(callback: (partial: string) => void): void {
    this.session.onResponseTranscriptDelta((partial) => {
      this.noteActivity();
      callback(partial);
    });
  }

  onResponseTranscriptDone(callback: (text: string) => void): void {
    this.session.onResponseTranscriptDone((text) => {
      this.noteActivity();
      callback(text);
      if (this.policy.closeAfterAssistantDone) {
        this.close("assistant_done");
      }
    });
  }

  onLifecycleEvent(callback: (event: LifecycleEvent) => void): void {
    this.lifecycleListeners.add(callback);
  }

  private wrapCallbacks(): void {
    // placeholder for future lower-level close/error hooks if raw provider exposes them
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
  provider: OpenAIRealtimeConversationProvider;
  policy: EffectiveRealtimePolicy;
}): ManagedRealtimeConversationSession {
  return new ManagedRealtimeConversationSession(params.provider, params.policy);
}
