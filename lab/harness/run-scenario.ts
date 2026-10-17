/**
 * Run one scenario end to end against the in-process plugin (T1) and write
 * the run directory: recording.wav, events.jsonl, plugin.log, call.json,
 * scenario.json, meta.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { NormalizedEvent } from "../../src/types.js";
import { decodeMulaw, encodeMulaw, FRAME_MS, stereoWav } from "./audio.ts";
import { bootPlugin, ConsoleCapture, LAB_NUMBERS, type BootOptions } from "./boot.ts";
import { FakeTwilioStream } from "./fake-twilio.ts";
import { PartyEngine, type PartyEvent } from "./party.ts";
import { renderScenario } from "./render.ts";
import type { Scenario } from "./scenario.ts";

export const MODEL_USD_PER_MIN: Record<string, number> = { live: 0.05, realtime: 0.1 };

export type ScenarioResult = {
  scenario: string;
  dir: string;
  endedBy: string;
  durationMs: number;
  modelUsd: number;
  ttsUsd: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScenario(params: {
  scenario: Scenario;
  dir: string;
  boot: Omit<BootOptions, "storeDir" | "persona">;
  runtimeLabel: string;
  verbose?: boolean;
  ttsCacheDir: string;
}): Promise<ScenarioResult> {
  const { scenario, dir } = params;
  fs.mkdirSync(dir, { recursive: true });
  const events: PartyEvent[] = [];
  let t0 = 0;
  const now = () => (t0 ? Date.now() - t0 : 0);
  const log = (ev: PartyEvent) => events.push(ev);

  const rendered = await renderScenario(scenario, { apiKey: params.boot.apiKey, cacheDir: params.ttsCacheDir });

  const capture = new ConsoleCapture(!!params.verbose, [params.boot.apiKey]);
  capture.install();
  const rt = await bootPlugin({
    ...params.boot,
    persona: scenario.call.persona,
    storeDir: path.join(dir, "store"),
    stubs: scenario.stubs,
    realBridge: scenario.bridge === "real",
  }).catch((err) => {
    capture.restore();
    throw err;
  });

  let endedBy = "";
  let error: string | undefined;
  let botHungUp = false;
  let streamClosed = false;
  let callId = "";
  let providerCallId = "";
  const left: Int16Array[] = [];
  const right: Int16Array[] = [];
  let dropped = 0;
  let stream: FakeTwilioStream | undefined;

  try {
    for (const n of rt.notes) log({ t_ms: 0, type: "note", note: n });
    rt.provider.onHangup = () => {
      botHungUp = true;
      log({ t_ms: now(), type: "bot_hangup", buffered_ms: stream?.playout.bufferedMs ?? 0 });
    };

    // --- create the call record the way the Twilio webhooks would ---------
    const inject = (ev: Partial<NormalizedEvent> & { type: NormalizedEvent["type"] }) =>
      rt.webhookServer.injectProviderEvents([
        { id: `lab-${ev.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now(), callId, providerCallId, ...ev } as NormalizedEvent,
      ]);

    if (scenario.direction === "outbound") {
      const res = await rt.manager.initiateCall(LAB_NUMBERS.business, undefined, {
        message: scenario.call.message,
        talkingPoints: scenario.call.talking_points,
        callParty: scenario.call.call_party ?? "third-party",
        callerIdentity: scenario.call.caller_identity,
        mode: "conversation",
      });
      if (!res.success) throw new Error(`initiateCall failed: ${res.error}`);
      callId = res.callId;
      providerCallId = rt.manager.getCall(callId)?.providerCallId ?? "";
      inject({ type: "call.ringing" });
    } else {
      const caller = scenario.call.caller ?? "owner";
      const from = caller === "owner" ? LAB_NUMBERS.owner : caller === "trusted" ? LAB_NUMBERS.trusted : LAB_NUMBERS.unknown;
      providerCallId = `CA${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`;
      callId = providerCallId;
      inject({
        type: "call.initiated",
        direction: "inbound",
        from,
        to: LAB_NUMBERS.plugin,
        stirVerstat: caller === "unknown" ? "TN-Validation-Passed-C" : "TN-Validation-Passed-A",
      });
      callId = rt.manager.getCallByProviderCallId(providerCallId)?.callId ?? callId;
    }
    rt.setProviderCallId(providerCallId);

    // --- answer + stream start (t = 0) --------------------------------------
    t0 = Date.now();
    inject({ type: "call.answered", timestamp: t0 });
    log({ t_ms: 0, type: "answered", direction: scenario.direction });
    const s = new FakeTwilioStream({
      url: rt.streamUrl,
      callSid: providerCallId,
      streamSid: `MZ${providerCallId.slice(2)}`,
      onEvent: (ev) => log({ t_ms: now(), ...ev }),
      onClose: (code, reason) => {
        streamClosed = true;
        log({ t_ms: now(), type: "ws_closed", code, reason });
      },
    });
    stream = s;
    await s.connect();
    log({ t_ms: now(), type: "stream_start" });

    const amd = scenario.amd && scenario.amd.verdict !== "none" ? scenario.amd : null;
    let amdAt: number | null = amd?.at_ms ?? null;
    let amdSent = false;
    const party = new PartyEngine(scenario, rendered.steps, {
      onEvent: (ev) => {
        log(ev);
        if (amd?.after_step && ev.type === "step_end" && ev.step === amd.after_step && amdAt === null) {
          amdAt = ev.t_ms + (amd.offset_ms ?? 0);
        }
      },
    });

    const maxMs = scenario.limits?.max_duration_ms ?? 120000;
    const idleEnd = scenario.limits?.idle_end_ms ?? 12000;
    let partyDoneAt: number | null = null;
    const startPerf = performance.now();
    for (let k = 0; ; k++) {
      const due = startPerf + k * FRAME_MS;
      const wait = due - performance.now();
      if (wait > 1) await sleep(wait);
      const t = k * FRAME_MS;

      if (amd && !amdSent && amdAt !== null && t >= amdAt) {
        amdSent = true;
        log({ t_ms: t, type: "amd_injected", verdict: amd.verdict });
        inject({ type: "call.amd", answeredBy: amd.verdict });
      }

      const { frame } = s.playFrame();
      const botPcm = decodeMulaw(frame);
      const partyPcm = party.tick(t, botPcm);
      const partyMulaw = encodeMulaw(partyPcm);
      left.push(decodeMulaw(partyMulaw));
      right.push(botPcm);
      s.sendMedia(partyMulaw, t);

      if (party.done && partyDoneAt === null) partyDoneAt = t;
      if (botHungUp) endedBy = "bot";
      else if (party.hungUp) endedBy = "party";
      else if (streamClosed) endedBy = "stream_closed";
      else if (t >= maxMs) endedBy = "max_duration";
      else if (
        partyDoneAt !== null &&
        !party.botIsSpeaking &&
        s.playout.bufferedMs === 0 &&
        t - Math.max(partyDoneAt, party.botQuietSinceMs ?? 0) >= idleEnd
      )
        endedBy = "party_idle";
      if (endedBy) break;
    }

    // --- end of call ---------------------------------------------------------
    const tEnd = now();
    const stopRes = s.stop();
    // Only audible audio counts as "cut off"; trailing silence in the buffer is not.
    dropped = stopRes.droppedAudibleMs;
    log({ t_ms: tEnd, type: "stream_stop", ended_by: endedBy, dropped_ms: dropped });
    if (endedBy !== "bot") {
      inject({ type: "call.ended", reason: endedBy === "party" ? "hangup-user" : "completed" });
    }
    // Let the plugin finalize (summary, post-call report stub).
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !rt.stubLog.some((s) => s.kind === "post_call_report")) await sleep(250);
    await sleep(500);
    // Real-bridge research can outlive the call (the answer is then texted):
    // keep the plugin up until every bridge task reported back.
    if (scenario.bridge === "real") {
      const tasks = (rt.webhookServer as unknown as { bridgeTasks?: Map<string, unknown> }).bridgeTasks;
      const until = Date.now() + 600_000;
      while (tasks && tasks.size > 0 && Date.now() < until) await sleep(1000);
      await sleep(1500);
      log({ t_ms: now(), type: "bridge_tasks_done", pending: tasks?.size ?? 0 });
    }
  } catch (err) {
    error = err instanceof Error ? err.stack ?? err.message : String(err);
    log({ t_ms: now(), type: "harness_error", error });
  } finally {
    const record = callId ? await rt.manager.findCall(callId).catch(() => undefined) : undefined;
    await rt.stop().catch(() => {});
    await sleep(300); // late close logs from the voice session still belong to this call
    capture.restore();
    capture.write(path.join(dir, "plugin.log"), t0 || Date.now());
    const cat = (chunks: Int16Array[]) => {
      const out = new Int16Array(chunks.reduce((a, c) => a + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    };
    fs.writeFileSync(path.join(dir, "recording.wav"), stereoWav(cat(left), cat(right)));
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario, null, 2));
    fs.writeFileSync(
      path.join(dir, "call.json"),
      JSON.stringify(
        {
          record: record ?? null,
          stubs: rt.stubLog.map((s) => ({ ...s, t_ms: s.wall - t0 })),
          provider_ops: rt.provider.calls.map((c) => ({ ...c, t_ms: c.at - t0 })),
        },
        null,
        2,
      ),
    );
    const durationMs = left.length * FRAME_MS;
    const rate = MODEL_USD_PER_MIN[params.runtimeLabel] ?? MODEL_USD_PER_MIN.realtime;
    const modelUsd = +((durationMs / 60000) * rate).toFixed(4);
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          scenario: scenario.id,
          class: scenario.class,
          t0_epoch_ms: t0,
          ended_by: endedBy || (error ? "harness_error" : ""),
          duration_ms: durationMs,
          dropped_at_stop_ms: dropped,
          runtime: params.runtimeLabel,
          model: params.boot.model,
          voice: params.boot.voice,
          profile: params.boot.profile,
          cost: { model_usd: modelUsd, model_rate_usd_per_min: rate, tts_usd: +rendered.ttsUsd.toFixed(4) },
          tts: { rendered: rendered.rendered, cache_hits: rendered.cacheHits },
          error: error ?? null,
        },
        null,
        2,
      ),
    );
    return { scenario: scenario.id, dir, endedBy: endedBy || "error", durationMs, modelUsd, ttsUsd: rendered.ttsUsd, error };
  }
}
