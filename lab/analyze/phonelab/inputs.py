"""Load one call: recording + whatever sidecars exist.

A lab call directory holds recording.wav, events.jsonl, plugin.log,
scenario.json, meta.json and call.json. For a real call only the WAV is
required; every other input is optional and the metrics degrade gracefully.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from .audio import Stereo, read_stereo_wav


@dataclass
class LogLine:
    t_ms: Optional[int]
    level: str
    msg: str


@dataclass
class Call:
    dir: Optional[Path]
    audio: Stereo
    events: List[dict] = field(default_factory=list)
    log: List[LogLine] = field(default_factory=list)
    scenario: Optional[dict] = None
    meta: dict = field(default_factory=dict)
    record: Optional[dict] = None
    stubs: List[dict] = field(default_factory=list)
    # [(t_ms, text)] lines the plugin generated for the bot (its own transcript)
    bot_lines: List[tuple] = field(default_factory=list)

    @property
    def id(self) -> str:
        if self.scenario and self.scenario.get("id"):
            return self.dir.name if self.dir else self.scenario["id"]
        return self.dir.name if self.dir else "call"

    @property
    def duration_ms(self) -> int:
        return int(self.meta.get("duration_ms") or self.audio.duration_ms)

    @property
    def ended_by(self) -> str:
        return self.meta.get("ended_by") or ""

    def tools_called(self) -> List[str]:
        names = []
        for l in self.log:
            m = re.search(r"Tool call: ([A-Za-z_]+)", l.msg)
            if m:
                names.append(m.group(1))
            elif re.search(r"Menu router pressed", l.msg):
                # The app pressed the keys itself (GPT-Live menu router): same effect as the tool.
                names.append("press_phone_keys")
        return names

    def plugin_errors(self) -> List[str]:
        return [l.msg[:200] for l in self.log if l.level == "ERROR"]


_LOG_RE = re.compile(r"^\s*(-?\d+\.\d+)\s+\S+\s+(LOG|INFO|WARN|ERROR|DEBUG)\s+(.*)$")


def parse_plugin_log(text: str) -> List[LogLine]:
    out = []
    for line in text.splitlines():
        m = _LOG_RE.match(line)
        if m:
            out.append(LogLine(int(round(float(m.group(1)) * 1000)), m.group(2), m.group(3)))
        elif line.strip():
            lvl = "ERROR" if re.search(r"\b(ERROR|Error:)", line) else "LOG"
            out.append(LogLine(None, lvl, line.strip()))
    return out


def _read_json(p: Path):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def load_call(dir_or_wav, events=None, log=None, scenario=None, meta=None, transcript=None) -> Call:
    """dir_or_wav: a call directory, or a stereo WAV with optional sidecar paths."""
    p = Path(dir_or_wav).expanduser()
    d = p if p.is_dir() else None
    wav = d / "recording.wav" if d else p
    pick = lambda given, name: Path(given).expanduser() if given else (d / name if d else None)
    call = Call(dir=d, audio=read_stereo_wav(wav))
    ep = pick(events, "events.jsonl")
    if ep and ep.exists():
        call.events = [json.loads(l) for l in ep.read_text().splitlines() if l.strip()]
    lp = pick(log, "plugin.log")
    if lp and lp.exists():
        call.log = parse_plugin_log(lp.read_text(errors="replace"))
    sp = pick(scenario, "scenario.json")
    if sp and sp.exists():
        if sp.suffix in (".yaml", ".yml"):
            raise ValueError("pass the scenario as JSON (the lab writes scenario.json next to each call)")
        call.scenario = _read_json(sp)
    mp = pick(meta, "meta.json")
    if mp and mp.exists():
        call.meta = _read_json(mp) or {}
    cp = d / "call.json" if d else None
    t0 = call.meta.get("t0_epoch_ms")
    if cp and cp.exists():
        cj = _read_json(cp) or {}
        call.record = cj.get("record")
        call.stubs = cj.get("stubs") or []
        for e in (call.record or {}).get("transcript") or []:
            if e.get("speaker") == "bot" and e.get("text"):
                ts = e.get("timestamp")
                call.bot_lines.append((int(ts - t0) if (t0 and ts) else None, e["text"]))
    if transcript:
        # Generic form: JSON list of {"speaker": "bot"|"user", "text", "t_ms"?}
        for e in _read_json(Path(transcript).expanduser()) or []:
            if e.get("speaker") in ("bot", "assistant") and e.get("text"):
                call.bot_lines.append((e.get("t_ms"), e["text"]))
    return call


def steps_timeline(call: Call) -> List[Dict]:
    """One dict per scenario step that started: spec + start/end/next_start + speech extent."""
    if not call.scenario:
        return []
    starts = {e["index"]: e for e in call.events if e.get("type") == "step_start"}
    ends = {e["index"]: e["t_ms"] for e in call.events if e.get("type") == "step_end"}
    out = []
    specs = call.scenario.get("steps") or []
    for i, spec in enumerate(specs):
        if i not in starts:
            continue
        st = starts[i]
        kind = st.get("kind") or next((k for k in ("say", "play", "wait", "hangup") if k in spec), "say")
        nxt = next((starts[j]["t_ms"] for j in range(i + 1, len(specs)) if j in starts), call.duration_ms)
        end = ends.get(i, st["t_ms"] if kind == "hangup" else min(call.duration_ms, st["t_ms"] + int(st.get("duration_ms") or 0)))
        gate = spec.get("gate") or {}
        out.append({
            "index": i,
            "id": spec.get("id") or f"s{i + 1}",
            "spec": spec,
            "kind": kind,
            "gate": next(iter(gate), "after_step"),
            "start": st["t_ms"],
            "end": end,
            "next_start": nxt,
            "speech_start": st.get("speech_start_ms"),
            "speech_end": st.get("speech_end_ms"),
            "machine": bool(spec.get("machine")),
            "reply": spec.get("reply", kind == "say") is not False and kind == "say",
            "is_beep": kind == "play" and isinstance(spec.get("play"), dict) and "beep" in spec["play"],
            "expect": spec.get("expect") or {},
        })
    return out
