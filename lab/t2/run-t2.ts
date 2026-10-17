/**
 * T2 runner: real-network calls. The lab instance of the plugin (this branch,
 * real Twilio provider) calls our OWN Twilio number; for the run the number's
 * voice URL points at the lab front door, which answers the lab's call with
 * the scripted party and redirects every other caller to the live assistant.
 *
 *   npx tsx lab/t2/run-t2.ts [--runtime live|realtime] [--voice vesper] [--model M]
 *       [--profile live|generic] [--cap USD] [--baseline RUN] [--no-analyze] [--no-judge]
 *       [--verbose] [--dry-run] scenario-glob ...
 *   npx tsx lab/t2/run-t2.ts --restore      put the number's saved routing back
 *
 * Outbound scenarios only (inbound ones are skipped).
 * --dry-run: tunnels, servers and plugin up; both tunnels checked; signed fake
 * POSTs to /front checked (redirect for a stranger, stream for an armed lab
 * call); the number's routing read (GET only) and printed masked; then shut
 * down. No routing change, no calls, no model.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalStates, type CallRecord } from "../../src/types.js";
import { ConsoleCapture, freePort, readOpenAiKey, STATE_DIR, type BootOptions } from "../harness/boot.ts";
import { renderScenario } from "../harness/render.ts";
import { MODEL_USD_PER_MIN } from "../harness/run-scenario.ts";
import type { Scenario } from "../harness/scenario.ts";
import { addLedger, ANALYSIS_USD_PER_MIN, JUDGE_USD, selectScenarios, spentToday } from "../run.ts";
import { bootReal, maskNumber, maskUrl, readLiveTwilio, type LiveTwilio, type RealRuntime } from "./boot-real.ts";
import { getRouting, restoreRouting, routeToLab } from "./number.ts";
import { PartyServer, type PartyResult } from "./party-server.ts";
import { startTunnel, waitServes, type Tunnel } from "./tunnel.ts";

const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Twilio voice, per leg per started minute (US), and async AMD per call. */
export const TWILIO_USD_PER_LEG_MIN = 0.014;
export const TWILIO_AMD_USD = 0.0075;

const out = (s: string) => process.stdout.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Args = {
  runtime: string;
  model: string;
  voice: string;
  profile: "live" | "generic";
  cap: number;
  baseline?: string;
  analyze: boolean;
  judge: boolean;
  verbose: boolean;
  dryRun: boolean;
  restore: boolean;
  globs: string[];
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runtime: "live",
    model: "gpt-realtime-2.1",
    voice: "vesper",
    profile: "live",
    cap: 5,
    analyze: true,
    judge: true,
    verbose: false,
    dryRun: false,
    restore: false,
    globs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === "--runtime") a.runtime = next();
    else if (v === "--model") a.model = next();
    else if (v === "--voice") a.voice = next();
    else if (v === "--profile") a.profile = next() as Args["profile"];
    else if (v === "--cap") a.cap = parseFloat(next());
    else if (v === "--baseline") a.baseline = next();
    else if (v === "--no-analyze") a.analyze = false;
    else if (v === "--no-judge") a.judge = false;
    else if (v === "--verbose" || v === "-v") a.verbose = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--restore") a.restore = true;
    else if (v === "-h" || v === "--help") {
      out(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else a.globs.push(v);
  }
  if (a.runtime !== "live" && a.runtime !== "realtime") throw new Error("--runtime must be live or realtime");
  return a;
}

export function twilioUsd(durationMs: number): number {
  const legMin = Math.max(1, Math.ceil(durationMs / 60000));
  return 2 * legMin * TWILIO_USD_PER_LEG_MIN + TWILIO_AMD_USD;
}

export function estimateT2Usd(s: Scenario, runtime: string): number {
  const ms = s.limits?.max_duration_ms ?? 120000;
  const rate = MODEL_USD_PER_MIN[runtime] ?? MODEL_USD_PER_MIN.realtime;
  return (ms / 60000) * 0.6 * (rate + ANALYSIS_USD_PER_MIN) + JUDGE_USD + twilioUsd(ms * 0.6);
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `t2-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Sign a fake Twilio POST (the same HMAC-SHA1 Twilio uses). */
function signTwilio(authToken: string, url: string, params: URLSearchParams): string {
  const data = url + [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + v).join("");
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

function maskRecord(r: CallRecord | undefined, tw: LiveTwilio): unknown {
  if (!r) return null;
  return JSON.parse(JSON.stringify(r).split(tw.fromNumber).join(maskNumber(tw.fromNumber)));
}

// --- cleanup: routing is ALWAYS restored ---------------------------------------------

let routed = false;
let cleanupFns: Array<() => Promise<unknown>> = [];
let creds: LiveTwilio | null = null;

async function cleanup(): Promise<void> {
  if (routed && creds) {
    try {
      const ok = await restoreRouting(creds);
      routed = false;
      out(ok ? "number routing restored" : "number routing: nothing saved to restore");
    } catch (err) {
      out(`!! RESTORE FAILED: ${err instanceof Error ? err.message : err} — run: npx tsx lab/t2/run-t2.ts --restore`);
    }
  }
  const fns = cleanupFns.reverse();
  cleanupFns = [];
  for (const f of fns) await f().catch(() => {});
}

function installSignalHandlers(): void {
  const bail = (why: string, code: number) => {
    out(`\n${why}: cleaning up`);
    cleanup().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => bail("SIGINT", 130));
  process.once("SIGTERM", () => bail("SIGTERM", 143));
  process.once("uncaughtException", (err) => {
    out(`uncaught: ${err instanceof Error ? err.stack : err}`);
    bail("uncaughtException", 1);
  });
  process.once("unhandledRejection", (err) => {
    out(`unhandled rejection: ${err instanceof Error ? err.stack : err}`);
    bail("unhandledRejection", 1);
  });
}

// --- per scenario ------------------------------------------------------------------------

async function runOne(p: {
  scenario: Scenario;
  dir: string;
  args: Args;
  apiKey: string;
  tw: LiveTwilio;
  party: PartyServer;
  pluginPort: number;
  tunnelA: Tunnel;
  capture: ConsoleCapture;
}): Promise<{ durationMs: number; endedBy: string; usd: number; error?: string }> {
  const { scenario, dir, args, tw, party } = p;
  fs.mkdirSync(dir, { recursive: true });
  const since = Date.now();
  const maxMs = scenario.limits?.max_duration_ms ?? 120000;
  const rendered = await renderScenario(scenario, { apiKey: p.apiKey, cacheDir: path.join(STATE_DIR, "tts-cache") });
  const boot: BootOptions = {
    runtime: args.runtime,
    model: args.model,
    voice: args.voice,
    profile: args.profile,
    persona: scenario.call.persona,
    storeDir: path.join(dir, "store"),
    apiKey: p.apiKey,
  };
  let rt: RealRuntime | null = null;
  let callId = "";
  let error: string | undefined;
  let partyResult: PartyResult | null = null;
  let record: CallRecord | undefined;
  try {
    rt = await bootReal({
      ...boot,
      port: p.pluginPort,
      publicBase: p.tunnelA.url,
      twilio: tw,
      stubs: scenario.stubs,
      maxDurationSeconds: Math.ceil(maxMs / 1000) + 30,
      // Owner scenarios: our own number plays the owner (it becomes toNumber,
      // so the call is first-party) and owner tools use the real Voice PE bridge.
      ...(scenario.bridge === "real"
        ? {
            allowDestination: tw.fromNumber,
            extraConfig: {
              voiceBridge: {
                enabled: true,
                url: "http://127.0.0.1:3338",
                askPathFile: path.join(os.homedir(), "development/voice-pe/voice-pe-bridge/.ask-path"),
              },
            },
          }
        : {}),
    });
    const partyDone = party.arm({ scenario, rendered: rendered.steps, dir }).then((r) => (partyResult = r));
    const res = await rt.runtime.manager.initiateCall(tw.fromNumber, undefined, {
      message: scenario.call.message,
      talkingPoints: scenario.call.talking_points,
      callParty: scenario.call.call_party ?? "third-party",
      callerIdentity: scenario.call.caller_identity,
      mode: "conversation",
    });
    if (!res.success) throw new Error(`initiateCall failed: ${res.error}`);
    callId = res.callId;
    rt.setProviderCallId(rt.runtime.manager.getCall(callId)?.providerCallId ?? "");

    const started = Date.now();
    const deadline = started + maxMs + 30000;
    const terminal = () => {
      const c = rt!.runtime.manager.getCall(callId);
      return !c || TerminalStates.has(c.state);
    };
    for (;;) {
      const done = terminal();
      // Done when the plugin leg is over and the party stream has closed
      // (or never opened: e.g. busy / failed, give it a few seconds).
      if (done && (partyResult || (!party.streamActive && Date.now() - started > 5000))) break;
      if (Date.now() > deadline) {
        error = `timeout: call still up after ${(maxMs + 30000) / 1000}s`;
        await rt.runtime.manager.endCall(callId).catch(() => {});
        break;
      }
      await sleep(250);
    }
    party.disarm();
    // Let the party stream close and the plugin finalize (post-call report stub).
    await Promise.race([partyDone, sleep(10000)]);
    const fin = Date.now() + 20000;
    while (Date.now() < fin && !rt.stubLog.some((s) => s.kind === "post_call_report")) await sleep(250);
    await sleep(500);
  } catch (err) {
    error = err instanceof Error ? err.stack ?? err.message : String(err);
  } finally {
    party.disarm();
    if (rt && callId) record = await rt.runtime.manager.findCall(callId).catch(() => undefined);
    await rt?.stop().catch(() => {});
    await sleep(300);
  }

  const pr = partyResult as PartyResult | null;
  const t0 = pr?.t0 || since;
  if (!pr && !error) error = "the party never answered (no stream from the front door)";
  p.capture.write(path.join(dir, "plugin.log"), t0, since);

  // ended_by: the party's own reason if it ended the call, else the bot if it hung up.
  const botHangup = rt?.hangups.find((h) => h.providerCallId === record?.providerCallId) ?? rt?.hangups[0];
  let endedBy = pr?.endedBy ?? "";
  if (!["party", "party_idle", "max_duration"].includes(endedBy)) {
    endedBy = botHangup ? "bot" : record?.endReason === "hangup-user" ? "party" : endedBy || "error";
  }
  if (pr) {
    const extra = [];
    if (botHangup) extra.push({ t_ms: botHangup.wall - t0, type: "bot_hangup", reason: botHangup.reason });
    const amd = record?.metadata?.answeredBy;
    if (typeof amd === "string") extra.push({ t_ms: null, type: "amd_twilio", verdict: amd });
    if (extra.length) fs.appendFileSync(path.join(dir, "events.jsonl"), extra.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario, null, 2));
  fs.writeFileSync(
    path.join(dir, "call.json"),
    JSON.stringify(
      {
        record: maskRecord(record, tw),
        stubs: (rt?.stubLog ?? []).map((s) => ({ ...s, t_ms: s.wall - t0 })),
        provider_ops: (rt?.hangups ?? []).map((h) => ({ op: "hangupCall", at: h.wall, t_ms: h.wall - t0, detail: h.reason })),
      },
      null,
      2,
    ),
  );
  const durationMs = pr?.durationMs ?? 0;
  const rate = MODEL_USD_PER_MIN[args.runtime] ?? MODEL_USD_PER_MIN.realtime;
  const modelUsd = +((durationMs / 60000) * rate).toFixed(4);
  const twUsd = callId ? +twilioUsd(durationMs).toFixed(4) : 0;
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        scenario: scenario.id,
        class: scenario.class,
        tier: "t2",
        t0_epoch_ms: t0,
        ended_by: endedBy,
        duration_ms: durationMs,
        dropped_at_stop_ms: 0,
        runtime: args.runtime,
        model: args.model,
        voice: args.voice,
        profile: args.profile,
        amd_twilio: record?.metadata?.answeredBy ?? null,
        cost: { model_usd: modelUsd, model_rate_usd_per_min: rate, tts_usd: +rendered.ttsUsd.toFixed(4), twilio_usd: twUsd },
        tts: { rendered: rendered.rendered, cache_hits: rendered.cacheHits },
        error: error ?? null,
      },
      null,
      2,
    ),
  );
  return { durationMs, endedBy, usd: modelUsd + rendered.ttsUsd + twUsd, error };
}

// --- main --------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  creds = readLiveTwilio();
  const tw = creds;
  if (args.restore) {
    const ok = await restoreRouting(tw);
    out(ok ? "number routing restored from the saved copy" : "nothing saved: routing was not changed by a lab run");
    if (ok) {
      const r = await getRouting(tw, tw.fromNumber);
      out(`now: voice ${maskUrl(r.voiceUrl)}  fallback ${maskUrl(r.voiceFallbackUrl)}`);
    }
    return;
  }

  let selected: Scenario[] = [];
  if (!args.dryRun) {
    const all = selectScenarios(args.globs).map((s) => s.scenario);
    for (const s of all.filter((s) => s.direction !== "outbound")) out(`skip ${s.id}: inbound scenarios are not run in T2`);
    selected = all.filter((s) => s.direction === "outbound");
    if (selected.length === 0) throw new Error("no outbound scenarios matched");
  }
  let apiKey = "";
  try {
    apiKey = readOpenAiKey();
  } catch (err) {
    if (!args.dryRun) throw err;
    apiKey = "sk-dry-run-placeholder";
  }

  installSignalHandlers();
  const capture = new ConsoleCapture(args.verbose, [apiKey, tw.authToken, tw.accountSid, tw.fromNumber]);
  capture.install();
  cleanupFns.push(async () => capture.restore());

  // Servers + tunnels.
  const party = new PartyServer({ creds: tw, ourNumber: tw.fromNumber, log: (m) => out(`[t2] ${m}`) });
  const partyPort = await party.listen(0);
  cleanupFns.push(() => party.close());
  const pluginPort = await freePort();
  out(`party server on :${partyPort}, plugin port :${pluginPort}; starting tunnels…`);
  const [tunnelA, tunnelB] = await Promise.all([
    startTunnel({ port: pluginPort, label: "A (plugin)" }),
    startTunnel({ port: partyPort, probePath: "/healthz", label: "B (party)" }),
  ]);
  cleanupFns.push(() => tunnelA.stop(), () => tunnelB.stop());
  party.setPublicBase(tunnelB.url);
  out(`tunnel A ${tunnelA.url}  ->  plugin`);
  out(`tunnel B ${tunnelB.url}  ->  party (front door ${tunnelB.url}/front)`);

  if (args.dryRun) {
    await dryRun({ args, apiKey, tw, party, pluginPort, tunnelA, tunnelB });
    return;
  }

  // Plugin must answer through tunnel A before Twilio is pointed anywhere.
  {
    const rt = await bootReal({
      runtime: args.runtime, model: args.model, voice: args.voice, profile: args.profile,
      storeDir: path.join(STATE_DIR, "t2-probe-store"), apiKey, port: pluginPort, publicBase: tunnelA.url, twilio: tw,
    });
    try {
      await waitServes(`${tunnelA.url}/voice/hold-music`, 60000, "A (plugin)");
    } finally {
      await rt.stop();
    }
  }

  const runId = newRunId();
  const runDir = path.join(STATE_DIR, "runs", runId);
  const arm = `t2-${args.runtime}-${args.voice}`;
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(
      { run_id: runId, arm, tier: "t2", runtime: args.runtime, model: args.model, voice: args.voice, profile: args.profile, repeat: 1, started_at: new Date().toISOString(), host: os.hostname(), scenarios: selected.map((s) => s.id) },
      null,
      2,
    ),
  );
  out(`run ${runId}  arm=${arm}  scenarios=${selected.length}`);

  let ran = 0;
  try {
    const original = await routeToLab(tw, tw.fromNumber, `${tunnelB.url}/front`);
    routed = true;
    party.setLiveUrl(original.voiceUrl);
    out(`number routed to the lab front door (live webhook ${maskUrl(original.voiceUrl)} kept as redirect target and fallback)`);

    for (const scenario of selected) {
      const est = estimateT2Usd(scenario, args.runtime);
      const spent = spentToday();
      if (spent + est > args.cap) {
        out(`spend cap: $${spent.toFixed(2)} spent today + ~$${est.toFixed(2)} > $${args.cap} — stopping`);
        break;
      }
      process.stdout.write(`▶ ${scenario.id} ... `);
      const t = Date.now();
      const r = await runOne({ scenario, dir: path.join(runDir, scenario.id), args, apiKey, tw, party, pluginPort, tunnelA, capture });
      addLedger({ run_id: runId, scenario: scenario.id, kind: "t2:model+tts+twilio", usd: +r.usd.toFixed(4) });
      ran++;
      out(`${r.error ? "ERROR" : "done"} ended_by=${r.endedBy} ${(r.durationMs / 1000).toFixed(1)}s ($${r.usd.toFixed(3)}) [${((Date.now() - t) / 1000).toFixed(0)}s wall]`);
      if (r.error) out(`   ${r.error.split("\n")[0]}`);
    }
  } finally {
    await cleanup();
  }

  if (args.analyze && ran > 0) {
    const py = process.env.PYTHON || "python3";
    const res = spawnSync(
      py,
      ["-I", path.join(LAB_DIR, "analyze", "run.py"), "analyze", runDir, ...(args.baseline ? ["--baseline", args.baseline] : []), ...(args.judge ? [] : ["--no-judge"])],
      { stdio: "inherit", env: { ...process.env, PHONELAB_STATE: STATE_DIR } },
    );
    if (res.status !== 0) out(`analyzer exited with ${res.status}`);
  }
  out(`spent today: $${spentToday().toFixed(2)} (cap $${args.cap})`);
  if (!args.analyze) out(`no report (--no-analyze); call data: ${runDir}`);
}

async function dryRun(p: {
  args: Args;
  apiKey: string;
  tw: LiveTwilio;
  party: PartyServer;
  pluginPort: number;
  tunnelA: Tunnel;
  tunnelB: Tunnel;
}): Promise<void> {
  const { tw, party, tunnelA, tunnelB } = p;
  const checks: Array<[string, boolean, string?]> = [];
  const rt = await bootReal({
    runtime: p.args.runtime, model: p.args.model, voice: p.args.voice, profile: p.args.profile,
    storeDir: path.join(STATE_DIR, "t2-probe-store"), apiKey: p.apiKey, port: p.pluginPort, publicBase: tunnelA.url, twilio: tw,
  });
  cleanupFns.push(() => rt.stop());
  out(`plugin up (twilio provider, inbound disabled, runtime=${p.args.runtime}, voice=${p.args.voice}); notes: ${rt.notes.join("; ") || "none"}`);

  const probe = async (name: string, url: string) => {
    try {
      await waitServes(url, 60000, name);
      checks.push([`${name} serves`, true]);
    } catch (err) {
      checks.push([`${name} serves`, false, err instanceof Error ? err.message : String(err)]);
    }
  };
  await probe("tunnel A /voice/hold-music", `${tunnelA.url}/voice/hold-music`);
  await probe("tunnel B /healthz", `${tunnelB.url}/healthz`);

  // Live URL for the redirect: read-only GET of the number's routing.
  let liveUrl: string | null = null;
  try {
    const r = await getRouting(tw, tw.fromNumber);
    liveUrl = r.voiceUrl;
    out(`number ${maskNumber(r.phoneNumber)} routing (read-only): voice ${r.voiceMethod} ${maskUrl(r.voiceUrl)}; fallback ${r.voiceFallbackMethod} ${maskUrl(r.voiceFallbackUrl)}`);
    checks.push(["read number routing (GET)", true]);
  } catch (err) {
    checks.push(["read number routing (GET)", false, err instanceof Error ? err.message : String(err)]);
    liveUrl = tw.publicUrl ?? null;
  }
  party.setLiveUrl(liveUrl);

  const post = async (from: string, signed = true) => {
    const params = new URLSearchParams({ CallSid: `CA${crypto.randomBytes(16).toString("hex")}`, From: from, To: tw.fromNumber, Direction: "inbound" });
    const sig = signed ? signTwilio(tw.authToken, party.frontUrl, params) : "invalid";
    const res = await fetch(party.frontUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: params.toString(),
    });
    return { status: res.status, body: await res.text() };
  };
  const stranger = "+15555550177";
  const a = await post(stranger);
  checks.push(["stranger -> <Redirect> to live", a.status === 200 && a.body.includes("<Redirect") && !!liveUrl && a.body.includes(liveUrl.replace(/&/g, "&amp;"))]);
  const b = await post(tw.fromNumber);
  checks.push(["our number, nothing armed -> redirect", b.status === 200 && b.body.includes("<Redirect")]);
  const fake: Scenario = { id: "dry-run", class: "test", direction: "outbound", call: {}, steps: [{ id: "s1", wait_silence: 100 }] };
  void party.arm({ scenario: fake, rendered: [], dir: path.join(STATE_DIR, "t2-dry-run") });
  const c = await post(tw.fromNumber);
  checks.push(["our number, armed -> <Connect><Stream>", c.status === 200 && c.body.includes("<Stream") && c.body.includes(`${tunnelB.url.replace("https:", "wss:")}/party`)]);
  const d = await post(tw.fromNumber);
  checks.push(["second call while armed (already used) -> redirect", d.status === 200 && d.body.includes("<Redirect")]);
  party.disarm();
  const e = await post(stranger, false);
  checks.push(["bad signature -> 403", e.status === 403]);

  out("dry-run checks:");
  for (const [name, ok, why] of checks) out(`  ${ok ? "OK  " : "FAIL"} ${name}${why ? ` (${why})` : ""}`);
  out("no routing change, no calls placed");
  await cleanup();
  if (checks.some((c) => !c[1])) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .catch(async (err) => {
      out(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await cleanup();
      process.exit(process.exitCode ?? 0);
    });
}
