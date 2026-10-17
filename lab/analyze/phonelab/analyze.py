"""Analyze one call and build its results-store row."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional

from . import SCHEMA
from .checks import goodbye, run_checks
from .heard import align, transcribe_bot
from .inputs import Call
from .judge import judge
from .metrics import compute

# Flat numeric metrics copied into the store row (lists go in alongside for pooling).
ROW_METRICS = ("duration_ms", "first_bot_audio_ms", "first_party_speech_ms", "bot_audio_before_party_speech_ms",
               "turn_latency_p50_ms", "turn_latency_p90_ms", "turn_latency_max_ms", "dead_air_s", "dead_air_events",
               "talk_over_s", "bot_over_machine_s", "barge_in_yield_ms", "vm_bot_during_greeting_s", "vm_message_start_ms",
               "vm_message_s", "vm_message_after_beep", "vm_message_complete", "goodbye_complete", "hangup_tail_ms",
               "dropped_at_stop_ms", "bot_speech_s", "dtmf_pressed", "lines_after_hangup")


def analyze_call(call: Call, key: Optional[str], whisper: bool = True, use_judge: bool = True,
                 cache: bool = True) -> Dict:
    m = compute(call)
    d = call.dir if cache else None
    heard = None
    alignment = None
    errors = []
    if whisper and key:
        try:
            heard = transcribe_bot(call, m["_segments"]["bot"], key, d / "whisper.json" if d else None)
        except Exception as e:  # analysis continues without it
            errors.append(f"whisper: {e}")
    if heard is not None and call.bot_lines:
        alignment = align(call.bot_lines, heard["words"])
    goodbye(call, m, alignment)
    checks = run_checks(call, m, heard, alignment)
    jr = None
    if use_judge and key:
        try:
            jr = judge(call, m, heard, key, d / "judge.json" if d else None)
        except Exception as e:
            errors.append(f"judge: {e}")
    segs = m.pop("_segments")
    result = {"metrics": m, "heard": heard, "alignment": alignment, "checks": checks, "judge": jr,
              "errors": errors, "segments": segs}
    if d:
        (d / "analysis.json").write_text(json.dumps(result, indent=1, default=str))
    return result


def build_row(call: Call, res: Dict, run_id: str, arm: str) -> Dict:
    m, c, al, jr = res["metrics"], res["checks"], res["alignment"] or {}, res["judge"]
    metrics = {k: m.get(k) for k in ROW_METRICS}
    metrics["turn_latencies_ms"] = m.get("turn_latencies_ms")
    for k in ("word_recall", "missing_lines", "partial_lines", "clipped_start_lines", "extra_runs"):
        metrics[f"heard_{k}"] = al.get(k)
    metrics["tools_called"] = call.tools_called()
    if jr:
        metrics["judge_mean"] = jr["mean"]
        for k, v in jr["scores"].items():
            metrics[f"judge_{k}"] = v
    meta_cost = call.meta.get("cost") or {}
    whisper_usd = (res["heard"] or {}).get("usd", 0) or 0
    judge_usd = (jr or {}).get("usd", 0) or 0
    model_usd = meta_cost.get("model_usd", 0) or 0
    tts_usd = meta_cost.get("tts_usd", 0) or 0
    cost = {"model_usd": model_usd, "voice_usd": model_usd, "tts_usd": tts_usd, "whisper_usd": whisper_usd,
            "judge_usd": judge_usd, "total_usd": round(model_usd + tts_usd + whisper_usd + judge_usd, 5)}
    sc = call.scenario or {}
    passed = c["passed"]
    if call.meta.get("error"):
        cls = {"class": "harness", "reason": str(call.meta["error"]).splitlines()[0][:200]}
    elif passed:
        cls = None
    elif res["errors"]:
        cls = {"class": "analysis", "reason": "; ".join(c["reasons"])[:300]}
    else:
        cls = {"class": "plugin", "reason": "; ".join(c["reasons"])[:300]}
    return {
        "schema": SCHEMA,
        "run_id": run_id,
        "trial_id": f"{run_id}/{call.id}",
        "entry": sc.get("id") or call.id,
        "arm": arm,
        "class": sc.get("class") or "real_call",
        "scenario": sc.get("id") or call.id,
        "call_dir": str(call.dir) if call.dir else None,
        "passed": passed,
        "reasons": c["reasons"],
        "notes": c["notes"] + res["errors"],
        "metrics": metrics,
        "cost": cost,
        "budget_breaches": c["budget_breaches"],
        "classification": cls,
        "judge_note": (jr or {}).get("note"),
        "ended_by": call.ended_by,
        "final": True,
    }
