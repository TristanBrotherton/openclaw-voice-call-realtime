"""Unit tests for the phone lab analyzer on synthetic recordings (no network).

  python3 -I -m unittest discover -s lab/analyze/tests -t lab/analyze
"""
import atexit
import json
import os
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
_TMP_STATE = tempfile.mkdtemp(prefix="phonelab-test-state-")
os.environ["PHONELAB_STATE"] = _TMP_STATE
atexit.register(shutil.rmtree, _TMP_STATE, True)

import numpy as np  # noqa: E402

from phonelab import audio, checks, heard, inputs, metrics, report  # noqa: E402
from phonelab.analyze import analyze_call, build_row  # noqa: E402
from phonelab.cli import main as cli_main  # noqa: E402

RATE = 8000


def speechlike(ms, db=-20, seed=1):
    """Band-limited noise with a syllable-rate envelope; RMS around `db` dBFS."""
    rng = np.random.default_rng(seed)
    n = RATE * ms // 1000
    x = rng.standard_normal(n)
    x = np.convolve(x, np.ones(4) / 4, mode="same")
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 4 * np.arange(n) / RATE) ** 2
    x = x * env
    x = x / np.sqrt(np.mean(x * x)) * (10 ** (db / 20)) * 32768
    return np.clip(x, -32768, 32767).astype(np.int16)


def tone(freqs, ms, amp=0.3):
    n = RATE * ms // 1000
    t = np.arange(n) / RATE
    v = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    return (v * amp * 32767).astype(np.int16)


class Track:
    def __init__(self, ms):
        self.x = np.zeros(RATE * ms // 1000, dtype=np.int16)

    def put(self, at_ms, clip):
        i = RATE * at_ms // 1000
        self.x[i:i + len(clip)] = clip[: len(self.x) - i]
        return self


def write_call(d: Path, party: Track, bot: Track, scenario=None, events=(), meta=None, log="", transcript=()):
    d.mkdir(parents=True, exist_ok=True)
    st = np.stack([party.x, bot.x], axis=1).astype("<i2")
    with wave.open(str(d / "recording.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(st.tobytes())
    if scenario is not None:
        (d / "scenario.json").write_text(json.dumps(scenario))
    (d / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    meta = {"t0_epoch_ms": 1_000_000, "duration_ms": len(party.x) * 1000 // RATE, "ended_by": "bot",
            "dropped_at_stop_ms": 0, "cost": {"model_usd": 0.01, "tts_usd": 0.0}, **(meta or {})}
    (d / "meta.json").write_text(json.dumps(meta))
    (d / "plugin.log").write_text(log)
    rec = {"transcript": [{"speaker": "bot", "text": t, "timestamp": 1_000_000 + ts} for ts, t in transcript]}
    (d / "call.json").write_text(json.dumps({"record": rec, "stubs": [], "provider_ops": []}))
    return d


def step_events(*steps):
    """steps: (index, id, kind, start, end) -> step_start/step_end events."""
    ev = []
    for i, sid, kind, s, e in steps:
        ev.append({"t_ms": s, "type": "step_start", "step": sid, "index": i, "kind": kind, "duration_ms": e - s})
        ev.append({"t_ms": e, "type": "step_end", "step": sid, "index": i})
    return ev


class VadTest(unittest.TestCase):
    def test_segments_match_bursts(self):
        t = Track(6000).put(500, speechlike(1000)).put(3000, speechlike(800, seed=2))
        segs = audio.vad_segments(t.x, RATE)
        self.assertEqual(len(segs), 2)
        self.assertAlmostEqual(segs[0][0], 500, delta=40)
        self.assertAlmostEqual(segs[0][1], 1500, delta=40)
        self.assertAlmostEqual(segs[1][0], 3000, delta=40)

    def test_adapts_to_line_noise(self):
        rng = np.random.default_rng(5)
        noise = (rng.standard_normal(RATE * 5) * 10 ** (-38 / 20) * 32768).astype(np.int16)
        t = Track(5000)
        t.x = noise.copy()
        clip = speechlike(1000, db=-18)
        i = RATE * 2
        t.x[i:i + len(clip)] = np.clip(t.x[i:i + len(clip)].astype(int) + clip, -32768, 32767)
        segs = audio.vad_segments(t.x, RATE)
        self.assertEqual(len(segs), 1)
        self.assertAlmostEqual(segs[0][0], 2000, delta=60)

    def test_overlap_and_subtract(self):
        self.assertEqual(audio.overlap_ms([(0, 100), (200, 300)], [(50, 250)]), 100)
        self.assertEqual(audio.subtract_windows([(0, 1000)], [(200, 300)]), [(0, 200), (300, 1000)])


class DtmfTest(unittest.TestCase):
    def test_detects_keys(self):
        x = np.concatenate([tone([697, 1209], 120, 0.5), np.zeros(800, np.int16), tone([770, 1336], 120, 0.5),
                            np.zeros(800, np.int16), tone([941, 1477], 120, 0.5), np.zeros(800, np.int16)])
        keys = "".join(k for _, k in audio.detect_dtmf(x, RATE))
        self.assertEqual(keys, "15#")

    def test_no_false_positive_on_beep_or_speech(self):
        x = np.concatenate([tone([1000], 500), speechlike(1500)])
        self.assertEqual(audio.detect_dtmf(x, RATE), [])


SC_BASE = {"id": "t-basic", "class": "outbound_human", "direction": "outbound", "call": {"message": "Book a table."}}


class MetricsTest(unittest.TestCase):
    def _call(self, tmp, party, bot, steps_spec, steps_ev, **kw):
        sc = {**SC_BASE, "steps": steps_spec, **kw.pop("sc_extra", {})}
        d = write_call(Path(tmp) / "c", party, bot, sc, step_events(*steps_ev), **kw)
        return inputs.load_call(d)

    def test_turn_latency_dead_air_talk_over(self):
        with tempfile.TemporaryDirectory() as tmp:
            party = Track(20000).put(600, speechlike(500)).put(5000, speechlike(1000, seed=3))
            # reply 1: 900 ms after "hello"; reply 2: 4 s after the second turn (dead air), overlapping nothing
            bot = Track(20000).put(2000, speechlike(2000, seed=4)).put(10000, speechlike(1500, seed=5))
            call = self._call(tmp, party, bot,
                              [{"id": "hello", "say": "Hello?"}, {"id": "ask", "say": "What?"}],
                              [(0, "hello", "say", 600, 1100), (1, "ask", "say", 5000, 6000)])
            m = metrics.compute(call)
            lat = m["turn_latencies_ms"]
            self.assertEqual(len(lat), 2)
            self.assertAlmostEqual(lat[0], 900, delta=60)
            self.assertAlmostEqual(lat[1], 4000, delta=60)
            self.assertEqual(m["dead_air_events"], 1)
            self.assertAlmostEqual(m["dead_air_s"], 4.0, delta=0.1)
            self.assertEqual(m["talk_over_s"], 0)
            self.assertAlmostEqual(m["first_bot_audio_ms"], 2000, delta=40)
            self.assertEqual(m["bot_audio_before_party_speech_ms"], 0)

    def test_talk_over_excludes_barge_in_and_measures_yield(self):
        with tempfile.TemporaryDirectory() as tmp:
            party = Track(12000).put(500, speechlike(400)).put(3000, speechlike(1000, seed=2))
            bot = Track(12000).put(1500, speechlike(2000, seed=3))  # 1500-3500; party barges in at 3000
            call = self._call(tmp, party, bot,
                              [{"id": "hello", "say": "Hi"},
                               {"id": "cut", "say": "Wait", "gate": {"during_bot_speech": {"offset_ms": 1500}}}],
                              [(0, "hello", "say", 500, 900), (1, "cut", "say", 3000, 4000)])
            m = metrics.compute(call)
            self.assertEqual(m["talk_over_s"], 0)
            self.assertAlmostEqual(m["barge_in_yield_ms"], 500, delta=60)
            self.assertTrue(m["barge_in"][0]["bot_was_speaking"])

    def test_voicemail(self):
        with tempfile.TemporaryDirectory() as tmp:
            party = Track(30000).put(700, speechlike(8000)).put(9100, tone([1000], 500))
            bot = Track(30000).put(4000, speechlike(600, seed=7)).put(11000, speechlike(6000, seed=8))
            steps = [{"id": "greeting", "say": "Leave a message", "machine": True, "reply": False},
                     {"id": "beep", "play": {"beep": True}, "machine": True, "reply": False},
                     {"id": "record", "wait_silence": 15000, "reply": False}]
            call = self._call(tmp, party, bot, steps,
                              [(0, "greeting", "say", 700, 8700), (1, "beep", "play", 9100, 9600),
                               (2, "record", "wait", 9600, 24600)],
                              sc_extra={"amd": {"verdict": "machine_end_beep", "after_step": "beep"},
                                        "expect": {"voicemail": True}})
            m = metrics.compute(call)
            self.assertAlmostEqual(m["vm_bot_during_greeting_s"], 0.6, delta=0.05)
            self.assertAlmostEqual(m["bot_over_machine_s"], 0.6, delta=0.05)
            self.assertAlmostEqual(m["vm_message_start_ms"], 1400, delta=60)
            self.assertFalse(m["vm_message_after_beep"])
            self.assertTrue(m["vm_message_complete"])
            self.assertEqual(m["turn_latencies_ms"], [])

    def test_generic_wav_without_scenario(self):
        with tempfile.TemporaryDirectory() as tmp:
            party = Track(10000).put(500, speechlike(1000)).put(5000, speechlike(800, seed=2))
            bot = Track(10000).put(2200, speechlike(1500, seed=3)).put(6500, speechlike(1000, seed=4))
            st = np.stack([party.x, bot.x], axis=1).astype("<i2")
            p = Path(tmp) / "real.wav"
            with wave.open(str(p), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(st.tobytes())
            m = metrics.compute(inputs.load_call(p))
            self.assertEqual(len(m["turn_latencies_ms"]), 2)
            self.assertAlmostEqual(m["turn_latencies_ms"][0], 700, delta=60)


class HeardTest(unittest.TestCase):
    def words(self, text, t0=0):
        return [{"w": w, "t_ms": t0 + i * 300, "end_ms": t0 + i * 300 + 250} for i, w in enumerate(text.split())]

    def test_normalize_numbers(self):
        self.assertEqual(heard.normalize_words("Table at 7pm, 6:30 p.m."), ["table", "at", "seven", "pm", "six", "thirty", "pm"])

    def test_alignment_flags(self):
        gen = [(1000, "Hi, this is Sam's assistant calling about a booking."),
               (5000, "Could you do Friday at 7?"),
               (9000, "Thanks so much, goodbye!")]
        heard_words = self.words("is Sam's assistant calling about a booking") + \
            self.words("could you do friday at seven", 5000) + \
            self.words("subscribe to my channel please", 7000) + self.words("thanks so", 9000)
        al = heard.align(gen, heard_words)
        l0, l1, l2 = al["lines"]
        self.assertEqual(l0["clipped_start_words"], 2)
        self.assertEqual(l1["status"], "ok")
        self.assertEqual(l2["cut_end_words"], 2)
        self.assertEqual(al["extra_runs"], 1)
        self.assertIn("subscribe", al["extra"][0]["text"])

    def test_compress_time_map(self):
        bot = np.zeros(RATE * 10, dtype=np.int16)
        out, tmap = heard.compress(bot, RATE, [(1000, 2000), (6000, 7000)])
        self.assertEqual(tmap[0], (0, 750, 1500))
        self.assertEqual(heard.map_time(100, tmap), 850)
        self.assertEqual(heard.map_time(1500 + heard.GAP_MS + 100, tmap), 5850)
        self.assertIsNone(heard.map_time(1500 + 300, tmap))


class ChecksTest(unittest.TestCase):
    def test_expectations(self):
        with tempfile.TemporaryDirectory() as tmp:
            party = Track(20000).put(600, speechlike(3000)).put(9000, speechlike(800, seed=2))
            bot = Track(20000).put(2000, speechlike(800, seed=3)).put(5000, tone([697, 1209], 120, 0.5)) \
                .put(10500, speechlike(1500, seed=4))
            sc = {**SC_BASE, "steps": [
                {"id": "menu", "say": "Press 1", "machine": True, "reply": False, "expect": {"bot_silent": True, "dtmf": "1"}},
                {"id": "human", "say": "Hello", "expect": {"bot_says": "sam", "max_reply_ms": 500}}],
                "expect": {"ended_by": "bot", "tools_called": ["press_phone_keys", "end_call"], "no_plugin_errors": True}}
            log = ("    5.000 2026-01-01T00:00:00.000Z LOG   [RealtimeConversation] Tool call: press_phone_keys (14 arg bytes)\n"
                   "    6.000 2026-01-01T00:00:00.000Z ERROR [voice-call] boom\n")
            d = write_call(Path(tmp) / "c", party, bot, sc,
                           step_events((0, "menu", "say", 600, 3600), (1, "human", "say", 9000, 9800)), log=log,
                           transcript=[(12000, "Hi, this is Sam's assistant.")])
            call = inputs.load_call(d)
            m = metrics.compute(call)
            hw = [{"w": "Hi", "t_ms": 10500, "end_ms": 10700}, {"w": "Sam's", "t_ms": 10900, "end_ms": 11200}]
            checks.goodbye(call, m, None)
            res = checks.run_checks(call, m, {"words": hw}, None)
            r = " | ".join(res["reasons"])
            self.assertIn("menu: bot spoke", r)
            self.assertNotIn("menu: keys", r)
            self.assertIn("tool end_call not called", r)
            self.assertIn("plugin error", r)
            self.assertIn("human: reply after", r)
            self.assertNotIn("did not say", r)
            self.assertFalse(res["passed"])
            self.assertTrue(any("reply after" in b for b in res["budget_breaches"]))


class ReportAndCliTest(unittest.TestCase):
    def test_cli_analyze_and_baseline_report(self):
        state = Path(_TMP_STATE)
        for run_id, late in (("phone-20260101-000000", 900), ("phone-20260101-010000", 1500)):
            rd = state / "runs" / run_id
            party = Track(10000).put(600, speechlike(500))
            bot = Track(10000).put(1100 + late, speechlike(1500, seed=3))
            sc = {**SC_BASE, "steps": [{"id": "hello", "say": "Hello?"}], "expect": {"ended_by": "bot"}}
            write_call(rd / "t-basic", party, bot, sc, step_events((0, "hello", "say", 600, 1100)))
            (rd / "run.json").write_text(json.dumps({"run_id": run_id, "arm": "realtime:m:v", "profile": "generic"}))
            cli_main(["analyze", run_id, "--no-judge", "--no-whisper"]
                     + (["--baseline", "phone-20260101-000000"] if late == 1500 else []))
        md = (state / "runs" / "phone-20260101-010000" / "report.md").read_text()
        self.assertIn("## outbound_human", md)
        self.assertIn("vs baseline", md)
        self.assertIn("turn latency p50 (ms)", md)
        rows = [json.loads(l) for l in (state / "results.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 2)
        for k in ("run_id", "arm", "class", "scenario", "passed", "metrics", "cost", "budget_breaches", "classification"):
            self.assertIn(k, rows[0])
        self.assertTrue(rows[0]["passed"])

    def test_latest_rows_dedupes(self):
        rows = [{"schema": "phonelab.result/1", "trial_id": "r/a", "run_id": "r", "scenario": "a", "passed": False},
                {"schema": "phonelab.result/1", "trial_id": "r/a", "run_id": "r", "scenario": "a", "passed": True}]
        self.assertEqual(len(report.latest_rows(rows)), 1)
        self.assertTrue(report.latest_rows(rows)[0]["passed"])


if __name__ == "__main__":
    unittest.main()
