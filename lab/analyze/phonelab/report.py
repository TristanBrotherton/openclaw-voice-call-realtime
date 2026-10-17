"""Phone lab markdown report: one section per scenario class, optional
comparison against a baseline run (percentile deltas with bootstrap
intervals from the shared Voice PE report code)."""
from __future__ import annotations

from collections import OrderedDict
from typing import Dict, List, Optional

from .shared import bootstrap_delta, pct


def latest_rows(rows: List[dict]) -> List[dict]:
    """The store is append-only; a re-analysed call keeps its last row."""
    by: "OrderedDict[str, dict]" = OrderedDict()
    for r in rows:
        if r.get("schema", "").startswith("phonelab"):
            by[r.get("trial_id") or f"{r['run_id']}/{r['scenario']}"] = r
    return list(by.values())


def _f(v, unit: str = "", nd: int = 1) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "NO"
    if unit == "s_from_ms":
        return f"{v / 1000:.{nd}f}"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def _pp(vals: List[float]) -> str:
    if not vals:
        return "-"
    return f"{pct(vals, 0.5):.0f} / {pct(vals, 0.9):.0f}"


def _pooled(rows: List[dict], key: str = "turn_latencies_ms") -> List[float]:
    out: List[float] = []
    for r in rows:
        out += [v for v in (r["metrics"].get(key) or []) if isinstance(v, (int, float))]
    return out


def _vals(rows: List[dict], key: str) -> List[float]:
    return [r["metrics"][key] for r in rows if isinstance(r["metrics"].get(key), (int, float)) and not isinstance(r["metrics"].get(key), bool)]


def _heard(m: dict) -> str:
    if m.get("heard_word_recall") is None:
        return "-"
    bits = [f"{m['heard_word_recall']:.2f}"]
    for k, lab in (("heard_missing_lines", "miss"), ("heard_partial_lines", "part"), ("heard_clipped_start_lines", "clip"),
                   ("heard_extra_runs", "extra")):
        if m.get(k):
            bits.append(f"{m[k]} {lab}")
    return " ".join(bits)


def render(rows: List[dict], run: dict, baseline_rows: Optional[List[dict]] = None, baseline_id: Optional[str] = None,
           spent_today: Optional[float] = None) -> str:
    rows = latest_rows(rows)
    base = latest_rows(baseline_rows or [])
    base_by = {r["scenario"]: r for r in base}
    n_pass = sum(1 for r in rows if r["passed"])
    total = sum((r.get("cost") or {}).get("total_usd", 0) for r in rows)
    L = [f"# Phone lab report: {run.get('run_id')}", "",
         f"Arm `{run.get('arm', rows[0]['arm'] if rows else '?')}`, profile {run.get('profile', '?')}; "
         f"{n_pass}/{len(rows)} scenarios passed; cost ${total:.3f}"
         + (f"; spent today ${spent_today:.2f}" if spent_today is not None else "") + "."]
    if baseline_id:
        bp = sum(1 for r in base if r["passed"])
        L.append(f"Baseline `{baseline_id}` ({base[0]['arm'] if base else '?'}): {bp}/{len(base)} passed.")
    L.append("")
    L += ["Times in ms unless marked s. Turn latency: other side's speech end to bot audible. "
          "Heard: word recall of the bot's own transcript in what was heard (whisper), then missing / partial / "
          "clipped-start lines and extra heard runs. Judge: mean of six 1-5 scores (tracked, not gating).", ""]

    classes = sorted({r["class"] for r in rows})
    for cls in classes:
        rs = sorted([r for r in rows if r["class"] == cls], key=lambda r: r["scenario"])
        lat = _pooled(rs)
        L += [f"## {cls}", "",
              f"{sum(1 for r in rs if r['passed'])}/{len(rs)} passed; turn latency p50 / p90 {_pp(lat)} ms over {len(lat)} turns; "
              f"first bot audio p50 {_f(pct(_vals(rs, 'first_bot_audio_ms'), 0.5))} ms; "
              f"dead air total {sum(_vals(rs, 'dead_air_s')):.1f} s; talk-over total {sum(_vals(rs, 'talk_over_s')):.1f} s.", "",
              "| scenario | pass | ended | dur s | 1st audio | turn p50 / p90 | talk-over s | dead air s | over machine s | yield | voicemail | goodbye | heard | judge |"
              + (" baseline |" if base else ""),
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|" + ("---|" if base else "")]
        for r in rs:
            m = r["metrics"]
            vm = "-"
            if m.get("vm_message_start_ms") is not None or m.get("vm_bot_during_greeting_s") is not None:
                vm = (f"over greeting {m.get('vm_bot_during_greeting_s')} s, msg +{_f(m.get('vm_message_start_ms'))}, "
                      f"{'complete' if m.get('vm_message_complete') else 'INCOMPLETE'}")
            cells = [r["scenario"], "PASS" if r["passed"] else "**FAIL**", r.get("ended_by") or "-",
                     _f(m.get("duration_ms"), "s_from_ms"), _f(m.get("first_bot_audio_ms")),
                     _pp(m.get("turn_latencies_ms") or []), _f(m.get("talk_over_s")), _f(m.get("dead_air_s")),
                     _f(m.get("bot_over_machine_s")), _f(m.get("barge_in_yield_ms")), vm,
                     _f(m.get("goodbye_complete")), _heard(m), _f(m.get("judge_mean"), nd=1)]
            if base:
                b = base_by.get(r["scenario"])
                if not b:
                    cells.append("new")
                else:
                    bm = b["metrics"]
                    flip = "" if b["passed"] == r["passed"] else (" FIXED" if r["passed"] else " REGRESSED")
                    cells.append(f"{'PASS' if b['passed'] else 'FAIL'}{flip}; p50 {_pp(bm.get('turn_latencies_ms') or []).split(' / ')[0]}, "
                                 f"dead {_f(bm.get('dead_air_s'))}")
            L.append("| " + " | ".join(str(c) for c in cells) + " |")
        L.append("")
        fails = [r for r in rs if not r["passed"]]
        if fails:
            L.append("Failures:")
            for r in fails:
                L.append(f"- **{r['scenario']}**: " + "; ".join(r["reasons"]))
            L.append("")
        notes = [r for r in rs if r.get("judge_note")]
        if notes:
            L.append("Judge notes:")
            for r in notes:
                m = r["metrics"]
                sc = " ".join(f"{k[6:]}={m[k]}" for k in m if k.startswith("judge_") and k != "judge_mean")
                L.append(f"- {r['scenario']} ({sc}): {r['judge_note']}")
            L.append("")
        if base:
            bs = [b for b in base if b["class"] == cls]
            if bs:
                L += [f"vs baseline (current - baseline; 90 % bootstrap interval; negative = faster/less):", "",
                      "| metric | baseline | current | delta | interval |", "|---|---|---|---|---|"]
                for label, a, b in (("turn latency p50 (ms)", _pooled(bs), lat),
                                    ("first bot audio p50 (ms)", _vals(bs, "first_bot_audio_ms"), _vals(rs, "first_bot_audio_ms")),
                                    ("dead air per call p50 (s)", _vals(bs, "dead_air_s"), _vals(rs, "dead_air_s")),
                                    ("talk-over per call p50 (s)", _vals(bs, "talk_over_s"), _vals(rs, "talk_over_s")),
                                    ("judge mean p50", _vals(bs, "judge_mean"), _vals(rs, "judge_mean"))):
                    d = bootstrap_delta(a, b, 0.5)
                    if d:
                        L.append(f"| {label} | {pct(a, 0.5):.1f} | {pct(b, 0.5):.1f} | {d[0]:+.1f} | [{d[1]:+.1f}, {d[2]:+.1f}] |")
                d = bootstrap_delta(_pooled(bs), lat, 0.9)
                if d:
                    L.append(f"| turn latency p90 (ms) | {pct(_pooled(bs), 0.9):.0f} | {pct(lat, 0.9):.0f} | {d[0]:+.0f} | [{d[1]:+.0f}, {d[2]:+.0f}] |")
                L.append("")

    L += ["## Cost", "", "| scenario | model $ | tts $ | whisper $ | judge $ | total $ |", "|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: (r["class"], r["scenario"])):
        c = r.get("cost") or {}
        L.append(f"| {r['scenario']} | {c.get('model_usd', 0):.4f} | {c.get('tts_usd', 0):.4f} | {c.get('whisper_usd', 0):.4f} | "
                 f"{c.get('judge_usd', 0):.4f} | {c.get('total_usd', 0):.4f} |")
    L.append("")
    return "\n".join(L)
