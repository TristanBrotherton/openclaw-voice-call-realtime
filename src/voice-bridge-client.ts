/**
 * Client for the Voice Bridge (the OpenClaw escalation service the Voice PE
 * add-on uses: voice-pe-bridge/bridge.mjs). The phone reuses its contract
 * instead of a second implementation:
 *
 *   {question, mode: "explain", session_key, request_id, budget_s, brief: "server",
 *    callback_url, callback_token}            -> {accepted, task_id, eta_s}
 *     the result is POSTed later to callback_url: {task_id, ok, spoken, text}
 *   {discuss: {action: "list" | "brief" | "stage", ...}}  -> open project items
 *   {recall: "words"}                                       -> {matches: [...]}
 *
 * Owner-only on the phone: the plugin offers these tools on verified calls
 * with the owner and nobody else.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type VoiceBridgeOptions = {
  /** Base URL, e.g. http://127.0.0.1:3338 */
  url: string;
  /** Secret ask path (or read from askPathFile). */
  askPath?: string;
  askPathFile?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Session keys the bridge accepts: ^voicepe-[A-Za-z0-9_-]{1,112}$ */
export function phoneSessionKey(kind: string, callId: string): string {
  const safe = `${kind}-${callId}`.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 100);
  return `voicepe-phone-${safe}`;
}

export type ExplainAccepted = { accepted: true; taskId: string; etaS: number } | { accepted: false; error: string };

export type TaskResult = { taskId: string; ok: boolean; spoken: string; text: string };

export class VoiceBridgeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: VoiceBridgeOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private askUrl(): string {
    let askPath = this.opts.askPath;
    if (!askPath && this.opts.askPathFile) {
      const file = this.opts.askPathFile.replace(/^~(?=$|\/)/, os.homedir());
      askPath = fs.readFileSync(path.resolve(file), "utf8").trim();
    }
    if (!askPath) {
      throw new Error("voice bridge ask path is not configured");
    }
    return `${this.opts.url.replace(/\/$/, "")}${askPath.startsWith("/") ? "" : "/"}${askPath}`;
  }

  private async post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.fetchImpl(this.askUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON error body
    }
    return { status: res.status, json };
  }

  async explain(params: {
    question: string;
    sessionKey: string;
    requestId: string;
    callbackUrl: string;
    callbackToken: string;
    budgetS?: number;
  }): Promise<ExplainAccepted> {
    const { status, json } = await this.post({
      question: params.question,
      mode: "explain",
      brief: "server",
      session_key: params.sessionKey,
      request_id: params.requestId,
      budget_s: params.budgetS ?? 600,
      callback_url: params.callbackUrl,
      callback_token: params.callbackToken,
    });
    if (status === 409) {
      return { accepted: false, error: "An explanation is already being researched." };
    }
    if (status !== 200 || json.accepted !== true) {
      return { accepted: false, error: String(json.error ?? json.answer ?? `bridge answered ${status}`) };
    }
    return { accepted: true, taskId: String(json.task_id ?? params.requestId), etaS: Number(json.eta_s ?? 180) };
  }

  /**
   * An ordinary question with the bridge's answer-only brief. Returns the
   * answer, or {background: true} when the bridge keeps working and will post
   * the result to the callback.
   */
  async ask(params: {
    question: string;
    sessionKey: string;
    requestId: string;
    callbackUrl: string;
    callbackToken: string;
  }): Promise<{ answer: string; background: boolean }> {
    const { status, json } = await this.post({
      question: params.question,
      answer_only: true,
      brief: "server",
      session_key: params.sessionKey,
      request_id: params.requestId,
      callback_url: params.callbackUrl,
      callback_token: params.callbackToken,
    });
    if (status !== 200) {
      throw new Error(`bridge answered ${status}`);
    }
    return { answer: String(json.answer ?? ""), background: json.background === true };
  }

  async discuss(action: "list" | "brief" | "stage", fields: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const { status, json } = await this.post({ discuss: { action, ...fields } });
    if (status === 403) {
      return { error: "Discussions are not switched on for this assistant." };
    }
    if (status !== 200) {
      return { error: "The project list could not be reached right now." };
    }
    return json;
  }

  async recall(query: string): Promise<string[]> {
    const { status, json } = await this.post({ recall: query });
    if (status !== 200 || !Array.isArray(json.matches)) {
      return [];
    }
    return (json.matches as unknown[]).map(String);
  }
}

/** Parse a callback body from the bridge. */
export function parseTaskResult(body: unknown): TaskResult | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const b = body as Record<string, unknown>;
  const taskId = typeof b.task_id === "string" ? b.task_id : "";
  if (!taskId) {
    return null;
  }
  return {
    taskId,
    ok: b.ok !== false,
    spoken: typeof b.spoken === "string" ? b.spoken : "",
    text: typeof b.text === "string" ? b.text : "",
  };
}
