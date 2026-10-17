"""Command line.

  python3 -I lab/analyze/run.py analyze RUN [--baseline RUN] [--no-judge] [--no-whisper] [--no-store]
  python3 -I lab/analyze/run.py report RUN [--baseline RUN]
  python3 -I lab/analyze/run.py call DIR_OR_WAV [--events F] [--log F] [--scenario F.json] [--transcript F.json]
                                              [--no-judge] [--no-whisper]

RUN is a run id (phone-YYYYMMDD-HHMMSS) under the state dir, or a run directory.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from .analyze import analyze_call, build_row
from .inputs import load_call
from .openai_api import read_key
from .report import latest_rows, render
from .shared import STATE_DIR, Store


def _run_dir(run: str) -> Path:
    p = Path(run).expanduser()
    if p.is_dir():
        return p
    p = STATE_DIR / "runs" / run
    if not p.is_dir():
        sys.exit(f"no run directory for {run}")
    return p


def _spent_today() -> float:
    led = STATE_DIR / "ledger.jsonl"
    if not led.exists():
        return 0.0
    today = dt.date.today().isoformat()
    tot = 0.0
    for line in led.read_text().splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("date") == today:
            tot += r.get("usd") or 0
    return tot


def _ledger(row: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    row = {"date": dt.date.today().isoformat(), "at": dt.datetime.now(dt.timezone.utc).isoformat(), **row}
    with open(STATE_DIR / "ledger.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")


def _call_dirs(run_dir: Path):
    return sorted(d for d in run_dir.iterdir() if d.is_dir() and (d / "recording.wav").exists())


def cmd_analyze(a) -> None:
    run_dir = _run_dir(a.run)
    run = json.loads((run_dir / "run.json").read_text()) if (run_dir / "run.json").exists() else {"run_id": run_dir.name}
    run_id = run.get("run_id") or run_dir.name
    arm = run.get("arm") or "?"
    key = read_key() if not (a.no_judge and a.no_whisper) else None
    store = Store(STATE_DIR)
    rows = []
    for d in _call_dirs(run_dir):
        call = load_call(d)
        had_cache = (d / "whisper.json").exists(), (d / "judge.json").exists()
        res = analyze_call(call, key, whisper=not a.no_whisper, use_judge=not a.no_judge)
        row = build_row(call, res, run_id, arm)
        new_usd = (0 if had_cache[0] else row["cost"]["whisper_usd"]) + (0 if had_cache[1] else row["cost"]["judge_usd"])
        if new_usd:
            _ledger({"run_id": run_id, "scenario": row["scenario"], "kind": "analysis", "usd": round(new_usd, 5)})
        rows.append(row)
        if not a.no_store:
            store.append(row)
        status = "PASS" if row["passed"] else "FAIL"
        m = row["metrics"]
        print(f"  {status} {row['scenario']:<28} turn p50 {m.get('turn_latency_p50_ms')} ms, dead air {m.get('dead_air_s')} s, "
              f"talk-over {m.get('talk_over_s')} s, judge {m.get('judge_mean', '-')}"
              + ("" if row["passed"] else f"  <- {'; '.join(row['reasons'])[:160]}"))
        for n in res["errors"]:
            print(f"    analysis warning: {n[:200]}")
    if not a.no_store:
        store.append_run({"schema": "phonelab.run/1", "run_id": run_id, "arm": arm, "trials": len(rows),
                          "passed": sum(1 for r in rows if r["passed"]),
                          "cost": {"total_usd": round(sum(r["cost"]["total_usd"] for r in rows), 4)},
                          "analyzed_at": dt.datetime.now(dt.timezone.utc).isoformat(), **{k: run.get(k) for k in ("runtime", "model", "voice", "profile")}})
    _write_report(run_dir, run, rows, a.baseline, store)


def _write_report(run_dir: Path, run: dict, rows, baseline, store) -> None:
    base_rows, base_id = None, None
    if baseline:
        base_id = baseline if not Path(baseline).is_dir() else Path(baseline).name
        base_rows = store.rows([base_id])
        if not base_rows:
            print(f"  baseline {base_id}: no rows in the store")
    md = render(rows, run, base_rows, base_id, _spent_today())
    out = run_dir / "report.md"
    out.write_text(md)
    print(f"report: {out}")


def cmd_report(a) -> None:
    run_dir = _run_dir(a.run)
    run = json.loads((run_dir / "run.json").read_text()) if (run_dir / "run.json").exists() else {"run_id": run_dir.name}
    store = Store(STATE_DIR)
    rows = latest_rows(store.rows([run.get("run_id") or run_dir.name]))
    if not rows:
        sys.exit("no rows in the store for this run; run `analyze` first")
    _write_report(run_dir, run, rows, a.baseline, store)


def cmd_call(a) -> None:
    call = load_call(a.path, events=a.events, log=a.log, scenario=a.scenario, transcript=a.transcript)
    key = read_key() if not (a.no_judge and a.no_whisper) else None
    res = analyze_call(call, key, whisper=not a.no_whisper, use_judge=not a.no_judge, cache=call.dir is not None)
    row = build_row(call, res, "adhoc", "real")
    out = {"passed": row["passed"], "reasons": row["reasons"], "metrics": row["metrics"], "judge": res["judge"],
           "alignment": {k: v for k, v in (res["alignment"] or {}).items() if k != "lines"}, "notes": row["notes"]}
    print(json.dumps(out, indent=1, default=str))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="phonelab")
    sub = p.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="analyze every call of a lab run, store rows, write report.md")
    an.add_argument("run")
    an.add_argument("--baseline")
    an.add_argument("--no-judge", action="store_true")
    an.add_argument("--no-whisper", action="store_true")
    an.add_argument("--no-store", action="store_true")
    an.set_defaults(fn=cmd_analyze)
    rp = sub.add_parser("report", help="re-render report.md from the store")
    rp.add_argument("run")
    rp.add_argument("--baseline")
    rp.set_defaults(fn=cmd_report)
    c = sub.add_parser("call", help="analyze one recording (lab call dir, or any stereo WAV: left party, right bot)")
    c.add_argument("path")
    c.add_argument("--events")
    c.add_argument("--log")
    c.add_argument("--scenario")
    c.add_argument("--transcript", help="JSON list of {speaker, text, t_ms}")
    c.add_argument("--no-judge", action="store_true")
    c.add_argument("--no-whisper", action="store_true")
    c.set_defaults(fn=cmd_call)
    a = p.parse_args(argv)
    a.fn(a)
