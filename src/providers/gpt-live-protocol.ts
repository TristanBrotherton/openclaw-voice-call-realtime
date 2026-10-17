/**
 * GPT-Live wire protocol helpers (pure, no network).
 *
 * TypeScript port of the Voice PE add-on's live_protocol.py
 * (voicepe-realtime app/live_protocol.py): the session.start shape, context
 * appends with the 500-token cap, and the Responses-delegation ledger that
 * decides when `response.create` is due. Verified against the live endpoint on
 * 2026-10-16 (gpt-live-1, gpt-6-luna backend).
 */

export const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
/** WebSocket audio is fixed at 24 kHz PCM16 mono in both directions. */
export const LIVE_SAMPLE_RATE = 24000;
/** session.input accepts at most 128 items. */
export const MAX_INPUT_ITEMS = 128;
const MAX_INPUT_CHARS = 24000;
/** Each context append takes at most 500 tokens; chunk against a lower budget. */
const MAX_APPEND_TOKENS = 450;

export type LiveFunctionTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LiveSessionStartOptions = {
  model: string;
  instructions: string;
  backendModel: string;
  backendInstructions: string;
  tools: LiveFunctionTool[];
  voice?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  history?: LiveInputItem[];
};

export type LiveInputItem = {
  type: "message";
  role: "user" | "assistant" | "developer";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
};

let eventCounter = 0;
export function newEventId(prefix = "evt"): string {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${eventCounter.toString(36)}`;
}

export function buildSessionStart(opts: LiveSessionStartOptions): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    model: opts.backendModel,
    instructions: opts.backendInstructions,
    tools: opts.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
  if (opts.reasoningEffort) {
    responses.reasoning = { effort: opts.reasoningEffort };
  }
  if (opts.serviceTier) {
    responses.service_tier = opts.serviceTier;
  }
  const session: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.instructions,
    delegation: { type: "responses", responses },
  };
  if (opts.voice) {
    session.audio = { output: { voice: opts.voice } };
  }
  if (opts.history && opts.history.length > 0) {
    session.input = opts.history;
  }
  return { type: "session.start", event_id: newEventId("start"), session };
}

export type ContextKind = "instructions" | "thinking" | "commentary";

/** `session.{instructions,thinking,commentary}.append` events, chunked to the token cap. */
export function contextAppends(
  kind: ContextKind,
  content: string,
  delegationId: string | null = null,
): Array<Record<string, unknown>> {
  return chunkText(content).map((chunk) => ({
    type: `session.${kind}.append`,
    event_id: newEventId(kind),
    delegation_id: delegationId,
    content: chunk,
  }));
}

export function functionCallOutput(callId: string, output: string): Record<string, unknown> {
  return {
    type: "response.item.create",
    event_id: newEventId("result"),
    item: { type: "function_call_output", call_id: callId, output },
  };
}

export function responseCreate(): Record<string, unknown> {
  return { type: "response.create", event_id: newEventId("continue") };
}

/** Call history -> session.input items (newest win when the caps bite). */
export function historyToSessionInput(
  turns: Array<{ role: "user" | "assistant"; text: string }>,
): LiveInputItem[] {
  let items: LiveInputItem[] = turns
    .filter((t) => t.text.trim())
    .map((t) => ({
      type: "message" as const,
      role: t.role,
      content: [
        { type: t.role === "assistant" ? ("output_text" as const) : ("input_text" as const), text: t.text.trim() },
      ],
    }));
  items = items.slice(-MAX_INPUT_ITEMS);
  let total = items.reduce((n, i) => n + i.content[0]!.text.length, 0);
  while (items.length > 0 && total > MAX_INPUT_CHARS) {
    total -= items.shift()!.content[0]!.text.length;
  }
  return items;
}

/** ~4 ASCII chars per token; non-ASCII counted as a token each. */
export function estimatedTokens(text: string): number {
  let quarters = 0;
  for (const ch of text) {
    quarters += ch.charCodeAt(0) < 128 ? 1 : 4;
  }
  return Math.ceil(quarters / 4);
}

export function chunkText(text: string, tokenLimit = MAX_APPEND_TOKENS): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return [];
  }
  if (estimatedTokens(trimmed) <= tokenLimit) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let current = "";
  for (let piece of trimmed.split(/(?<=[.!?])\s+|\n+/)) {
    piece = piece.trim();
    while (estimatedTokens(piece) > tokenLimit) {
      const cut = tokenLimit * 4;
      const space = piece.lastIndexOf(" ", cut);
      const at = space > 0 ? space : cut;
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(piece.slice(0, at).trim());
      piece = piece.slice(at).trim();
    }
    if (!piece) {
      continue;
    }
    if (current && estimatedTokens(`${current} ${piece}`) > tokenLimit) {
      chunks.push(current);
      current = piece;
    } else {
      current = `${current} ${piece}`.trim();
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export type LiveFunctionCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  delegationId: string | null;
};

type PendingResponse = { callIds: Set<string>; hadCalls: boolean; finished: boolean };

const UNCORRELATED = "uncorrelated";

/**
 * Function-call collection for Responses delegation: collect completed
 * function_call items from nested response.output_item.done events, submit one
 * response.item.create per call, and send response.create only once every
 * result is in and the backend response has finished emitting items.
 */
export class DelegationLedger {
  private seenCalls = new Set<string>();
  private retired = new Set<string>();
  private pending = new Map<string, PendingResponse>();
  private open = new Map<string, string>(); // callId -> response key
  private active = new Map<string, string>(); // delegation -> response key

  private key(evt: Record<string, unknown>): string {
    const delegation = String(evt.delegation_id ?? UNCORRELATED);
    const inner = (evt.event ?? {}) as Record<string, unknown>;
    const responseId =
      (inner.response_id as string | undefined) ??
      ((inner.response as Record<string, unknown> | undefined)?.id as string | undefined);
    if (responseId) {
      return `${delegation}:${responseId}`;
    }
    return this.active.get(delegation) ?? delegation;
  }

  get busy(): boolean {
    if (this.open.size > 0) {
      return true;
    }
    for (const p of this.pending.values()) {
      if (!p.finished) {
        return true;
      }
    }
    return false;
  }

  /** Feed one `response.event` envelope: a call to run, and whether response.create is due now. */
  observe(evt: Record<string, unknown>): { call: LiveFunctionCall | null; continueNow: boolean } {
    const none = { call: null, continueNow: false };
    if (evt.type !== "response.event") {
      return none;
    }
    const key = this.key(evt);
    const inner = (evt.event ?? {}) as Record<string, unknown>;
    const kind = String(inner.type ?? "");
    if (this.retired.has(key)) {
      return none;
    }
    const delegation = String(evt.delegation_id ?? UNCORRELATED);
    if (kind === "response.created") {
      this.active.set(delegation, key);
      if (!this.pending.has(key)) {
        this.pending.set(key, { callIds: new Set(), hadCalls: false, finished: false });
      }
      return none;
    }
    if (kind === "response.output_item.done") {
      const item = (inner.item ?? {}) as Record<string, unknown>;
      if (item.type !== "function_call" || (item.status ?? "completed") !== "completed") {
        return none;
      }
      const callId = item.call_id as string | undefined;
      const name = item.name as string | undefined;
      if (!callId || !name || this.seenCalls.has(callId)) {
        return none;
      }
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse((item.arguments as string) || "{}") as unknown;
        args =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { value: parsed };
      } catch {
        args = { _invalid_arguments: item.arguments };
      }
      let p = this.pending.get(key);
      if (!p) {
        p = { callIds: new Set(), hadCalls: false, finished: false };
        this.pending.set(key, p);
      }
      this.seenCalls.add(callId);
      p.callIds.add(callId);
      p.hadCalls = true;
      this.open.set(callId, key);
      return {
        call: { callId, name, arguments: args, delegationId: (evt.delegation_id as string) ?? null },
        continueNow: false,
      };
    }
    if (kind === "response.completed" || kind === "response.incomplete" || kind === "response.failed") {
      const p = this.pending.get(key);
      if (!p) {
        return none;
      }
      p.finished = true;
      if (this.active.get(delegation) === key) {
        this.active.delete(delegation);
      }
      return { call: null, continueNow: this.ready(key) };
    }
    return none;
  }

  /** A result was submitted for callId; true when response.create is due. */
  complete(callId: string): boolean {
    const key = this.open.get(callId);
    if (key === undefined) {
      return false;
    }
    this.open.delete(callId);
    this.pending.get(key)?.callIds.delete(callId);
    return this.ready(key);
  }

  reset(): void {
    this.seenCalls.clear();
    this.retired.clear();
    this.pending.clear();
    this.open.clear();
    this.active.clear();
  }

  private ready(key: string): boolean {
    const p = this.pending.get(key);
    if (!p || !p.finished || !p.hadCalls || p.callIds.size > 0) {
      return false;
    }
    this.pending.delete(key);
    this.retired.add(key);
    return true;
  }
}
