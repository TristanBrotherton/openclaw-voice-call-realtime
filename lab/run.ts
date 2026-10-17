/**
 * T1 lab runner.
 *
 *   npx tsx lab/run.ts [--runtime realtime|live] [--model M] [--voice V]
 *       [--repeat N] [--cap USD] [--baseline RUN_ID] [--profile live|generic]
 *       [--no-analyze] [--no-judge] [--verbose] [--into RUN_ID] [scenario-glob ...]
 *
 * --into re-runs the selected scenarios inside an existing run (same arm),
 * replacing their call directories; the analyzer then re-analyses the run.
 *
 * Globs match scenario ids or file names under lab/scenarios (default: all).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOpenAiKey, STATE_DIR } from "./harness/boot.ts";
import { MODEL_USD_PER_MIN, runScenario } from "./harness/run-scenario.ts";
import { loadScenario, type Scenario } from "./harness/scenario.ts";

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(LAB_DIR, "scenarios");
export const LEDGER = path.join(STATE_DIR, "ledger.jsonl");
/** Whisper ($0.006/min) + judge, per scenario, rough. */
export const ANALYSIS_USD_PER_MIN = 0.006;
export const JUDGE_USD = 0.003;

type Args = {
  runtime: string;
  runtimeExplicit: boolean;
  model: string;
  voice: string;
  repeat: number;
  cap: number;
  baseline?: string;
  profile: "live" | "generic";
  analyze: boolean;
  judge: boolean;
  verbose: boolean;
  globs: string[];
  into?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runtime: "realtime",
    runtimeExplicit: false,
    model: "gpt-realtime-2.1",
    voice: "ballad",
    repeat: 1,
    cap: 5,
    profile: "live",
    analyze: true,
    judge: true,
    verbose: false,
    globs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === "--runtime") {
      a.runtime = next();
      a.runtimeExplicit = true;
    } else if (v === "--model") a.model = next();
    else if (v === "--voice") a.voice = next();
    else if (v === "--repeat") a.repeat = Math.max(1, parseInt(next(), 10));
    else if (v === "--cap") a.cap = parseFloat(next());
    else if (v === "--baseline") a.baseline = next();
    else if (v === "--profile") a.profile = next() as Args["profile"];
    else if (v === "--no-analyze") a.analyze = false;
    else if (v === "--into") a.into = next();
    else if (v === "--no-judge") a.judge = false;
    else if (v === "--verbose" || v === "-v") a.verbose = true;
    else if (v === "-h" || v === "--help") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else a.globs.push(v);
  }
  return a;
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export function selectScenarios(globs: string[]): Array<{ file: string; scenario: Scenario }> {
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const all = files.map((f) => ({ file: f, scenario: loadScenario(path.join(SCENARIO_DIR, f)) }));
  if (globs.length === 0) return all;
  const res = globs.map((g) => globToRegex(path.basename(g).replace(/\.ya?ml$/, "")));
  return all.filter(({ file, scenario }) => res.some((r) => r.test(scenario.id) || r.test(file.replace(/\.ya?ml$/, ""))));
}

export function today(): string {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
}

export function spentToday(ledger = LEDGER): number {
  if (!fs.existsSync(ledger)) return 0;
  const d = today();
  return fs
    .readFileSync(ledger, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.date === d)
    .reduce((s, r) => s + (r.usd || 0), 0);
}

export function addLedger(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ date: today(), at: new Date().toISOString(), ...row }) + "\n");
}

function estimateScenarioUsd(s: Scenario, runtime: string): number {
  const minutes = (s.limits?.max_duration_ms ?? 120000) / 60000;
  const rate = MODEL_USD_PER_MIN[runtime] ?? MODEL_USD_PER_MIN.realtime;
  // Calls usually end well before the limit; budget for 60 % of it.
  return minutes * 0.6 * (rate + ANALYSIS_USD_PER_MIN) + JUDGE_USD;
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `phone-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectScenarios(args.globs);
  if (selected.length === 0) throw new Error("no scenarios matched");
  const apiKey = readOpenAiKey();
  const runId = args.into ?? newRunId();
  const runDir = path.join(STATE_DIR, "runs", runId);
  const arm = `${args.runtime}:${args.model}:${args.voice}`;
  if (args.into) {
    const prev = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    if (prev.arm !== arm || prev.profile !== args.profile) throw new Error(`--into ${runId}: run arm is ${prev.arm}/${prev.profile}`);
    for (const { scenario } of selected) fs.rmSync(path.join(runDir, scenario.id), { recursive: true, force: true });
  }
  fs.mkdirSync(runDir, { recursive: true });
  if (!args.into) fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(
      { run_id: runId, arm, runtime: args.runtime, model: args.model, voice: args.voice, profile: args.profile, repeat: args.repeat, started_at: new Date().toISOString(), host: os.hostname(), scenarios: selected.map((s) => s.scenario.id) },
      null,
      2,
    ),
  );
  process.stdout.write(`run ${runId}  arm=${arm}  scenarios=${selected.length} x${args.repeat}\n`);

  const results = [];
  let stoppedForCap = false;
  for (let rep = 0; rep < args.repeat && !stoppedForCap; rep++) {
    for (const { scenario } of selected) {
      const est = estimateScenarioUsd(scenario, args.runtime);
      const spent = spentToday();
      if (spent + est > args.cap) {
        process.stdout.write(`spend cap: $${spent.toFixed(2)} spent today + ~$${est.toFixed(2)} > $${args.cap} — stopping\n`);
        stoppedForCap = true;
        break;
      }
      const dir = path.join(runDir, args.repeat > 1 ? `${scenario.id}-r${rep + 1}` : scenario.id);
      process.stdout.write(`▶ ${scenario.id} ... `);
      const t = Date.now();
      const r = await runScenario({
        scenario,
        dir,
        boot: { apiKey, model: args.model, voice: args.voice, profile: args.profile, ...(args.runtimeExplicit ? { runtime: args.runtime } : {}) },
        runtimeLabel: args.runtime,
        verbose: args.verbose,
        ttsCacheDir: path.join(STATE_DIR, "tts-cache"),
      });
      addLedger({ run_id: runId, scenario: scenario.id, kind: "model+tts", usd: +(r.modelUsd + r.ttsUsd).toFixed(4) });
      results.push(r);
      process.stdout.write(
        `${r.error ? "HARNESS ERROR" : "done"} ended_by=${r.endedBy} ${(r.durationMs / 1000).toFixed(1)}s ($${r.modelUsd.toFixed(3)}) [${((Date.now() - t) / 1000).toFixed(0)}s wall]\n`,
      );
      if (r.error) process.stdout.write(`   ${r.error.split("\n")[0]}\n`);
    }
  }

  if (args.analyze && results.length > 0) {
    // python3 -I: isolated mode (no PYTHONPATH, no user site); lab/analyze/run.py sets sys.path itself.
    const py = process.env.PYTHON || "python3";
    const analyzeArgs = [
      "-I",
      path.join(LAB_DIR, "analyze", "run.py"),
      "analyze",
      runDir,
      ...(args.baseline ? ["--baseline", args.baseline] : []),
      ...(args.judge ? [] : ["--no-judge"]),
    ];
    const res = spawnSync(py, analyzeArgs, {
      stdio: "inherit",
      env: { ...process.env, PHONELAB_STATE: STATE_DIR },
    });
    if (res.status !== 0) process.stdout.write(`analyzer exited with ${res.status}\n`);
  }
  process.stdout.write(`spent today: $${spentToday().toFixed(2)} (cap $${args.cap})\n`);
  if (!args.analyze) process.stdout.write(`no report (--no-analyze); call data: ${runDir}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
