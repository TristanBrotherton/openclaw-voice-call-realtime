# Phone call lab (T1)

Runs the real plugin in-process against scripted phone calls and measures
what the other side actually heard. Design: `docs/REAL-AUDIO-TEST-PLAN.md`.

```
lab/
  run.ts                 runner: scenarios -> run dir -> analyzer -> report
  harness/               TypeScript side (plays the calls)
    boot.ts              boots the plugin: real webhook server, media stream, call manager,
                         voice model; a lab provider that never dials; stubbed assistant,
                         owner messages and post-call reports
    fake-twilio.ts       Twilio Media Streams client: 20 ms mu-law frames in real time,
                         playout buffer with mark echo and clear, as Twilio does
    party.ts             scripted other side: steps with gates, bot VAD, DTMF detector
    render.ts            party audio: OpenAI TTS (cached) + synthesized beeps, DTMF, hold music
    run-scenario.ts      one call end to end; writes the call directory
    scenario.ts          scenario format + validation
  scenarios/*.yaml       the corpus (oh-* outbound human, om-* voicemail, oi-* phone menu,
                         os-* screener, ib-* inbound)
  analyze/               Python analyzer (package phonelab), entry point run.py
  tests/                 vitest: playout/mark/clear and party gates (no network)
```

## Run

```
npx tsx lab/run.ts                                   # whole corpus, realtime / gpt-realtime-2.1 / ballad
npx tsx lab/run.ts om-* oi-*                         # scenarios by glob (id or file name)
npx tsx lab/run.ts --runtime live --baseline phone-20261016-193535
npx tsx lab/run.ts --repeat 3 --no-judge -v oh-barge-in
```

Options: `--runtime realtime|live` (sets `streaming.runtime`), `--model`, `--voice`,
`--profile live|generic` (live copies persona, turn detection, screening and greeting
settings from the installed plugin's config; generic uses a neutral persona),
`--repeat N`, `--cap USD` (default 5), `--baseline RUN`, `--no-analyze`, `--no-judge`,
`--verbose` (echo plugin logs).

At the end the runner prints the report path. Re-analyse or re-render without
running calls again:

```
python3 -I lab/analyze/run.py analyze phone-YYYYMMDD-HHMMSS [--baseline RUN] [--no-judge] [--no-whisper] [--no-store]
python3 -I lab/analyze/run.py report  phone-YYYYMMDD-HHMMSS [--baseline RUN]
python3 -I lab/analyze/run.py call    path/to/call-dir-or-stereo.wav [--events F] [--log F] [--scenario F.json] [--transcript F.json]
```

`call` works on any stereo recording (left = remote party, right = bot), such as
the plugin's own call recordings; without a scenario every party utterance is
treated as owing a reply.

Tests:

```
npx vitest run lab/                       # harness
npx tsc --noEmit -p lab                   # typecheck lab + src
python3 -I lab/analyze/tests/test_phonelab.py
```

Python needs numpy. `-I` (isolated mode) is deliberate: `run.py` puts
`lab/analyze` on `sys.path` and `phonelab.shared` appends
`$VOICEPE_LAB_PATH` (default `~/development/voice-pe/lab`) to import the
shared `Store`, `pct` and `bootstrap_delta`. Never edit files there.

## Where results go

`~/.local/state/voice-call-lab/` (override with `VOICE_CALL_LAB_STATE`), never the repo:

- `runs/<run_id>/run.json`, `report.md`
- `runs/<run_id>/<scenario>/` `recording.wav` (stereo 8 kHz: left party, right bot as heard),
  `events.jsonl` (party steps, bot VAD, marks, clears, DTMF, AMD injection, hangup),
  `plugin.log`, `call.json` (call record + stub calls), `scenario.json`, `meta.json`,
  `analysis.json`, `whisper.json`, `judge.json` (the last two are caches; delete to redo)
- `results.jsonl`, `runs.jsonl`: the shared store (one row per call: run_id, arm, class,
  scenario, passed, metrics, cost, budget_breaches, classification). The report keeps the
  latest row per call, so re-analysing a run is safe.
- `ledger.jsonl`: spend per call (model + TTS from the runner, whisper + judge from the analyzer)
- `tts-cache/`: rendered party clips

## What is measured

Per-channel energy VAD on the recording gives party and bot segments; the
scenario timeline (events) says which party steps owe a reply, which are
machine prompts and which are barge-ins.

| metric | meaning |
|---|---|
| turn latency | party speech end to bot audible (per turn; p50/p90 per class) |
| dead air | reply gaps over 3 s where the bot owed a reply (incl. no reply at all) |
| talk-over | seconds both speak, excluding barge-in steps |
| bot over machine | bot audio during machine steps (greeting, beep, menu, hold music, screener) |
| barge-in yield | party onset to bot quiet, on `during_bot_speech` steps |
| voicemail | bot over the greeting (must be 0), message start after the beep, complete before hangup |
| goodbye | last line heard to the end: nothing unplayed at hangup, not cut by the hangup, last words heard |
| first audio | answer to first bot audio |
| heard vs generated | whisper-1 on the bot channel (word timestamps) vs the plugin's bot transcript: word recall, missing / partial lines, clipped first words, extra heard runs |
| DTMF | Goertzel detection on the bot channel |
| judge | gpt-5.4-mini (fallback gpt-4.1-mini), fixed rubric: pickup, pacing, filler/repetition, tone, recovery, task success, 1-5 + note; tracked, not gating |

## Adding a scenario

Copy a similar YAML in `lab/scenarios/`. Use generic fictional businesses and
people only; numbers are never real. Essentials:

```yaml
id: om-example              # prefix by class
class: outbound_machine     # report section
direction: outbound         # or inbound (call.caller: owner|trusted|unknown)
call: { message: "...", talking_points: [...], call_party: third-party }
amd: { verdict: machine_end_beep, after_step: beep, offset_ms: 150 }   # or at_ms; human|machine_end_*|unknown|none
steps:
  - id: greeting
    say: "..."               # TTS (voice, instructions, speed, gain_db, noise_db)
    gate: { at_ms: 700 }     # at_ms | after_step | after_bot_done{quiet_ms} | during_bot_speech{offset_ms} | on_dtmf{digits}
    machine: true            # bot must not talk over it
    reply: false             # does not ask for a reply
    expect: { bot_silent: true }   # bot_says / bot_not_says (regex, heard), dtmf, max_reply_ms, max_yield_ms
  - { id: beep, play: { beep: { freq: 1000, ms: 500 } }, machine: true, reply: false }
  - { id: record, wait_silence: 45000, reply: false }
  # also: play {dtmf|hold_music|silence|noise}, hangup: true, gate_timeout_ms
expect: { ended_by: bot, voicemail: true, goodbye_complete: true, tools_called: [end_call], no_plugin_errors: true }
limits: { max_duration_ms: 80000, idle_end_ms: 10000 }
stubs: { assistant: [{ match: "regex", answer: "...", delay_ms: 2500 }] }
```

Phrase checks run on what was heard (whisper), in the window from the step's
start to the next step's start. A real-call problem becomes a scenario first,
then gets fixed.

## Safety

- The lab dials nothing: the lab provider refuses any destination outside the fictional
  555-01xx lab numbers and never talks to Twilio.
- Tool side effects are stubbed: ask_assistant answers from the scenario, owner messages and
  post-call reports are recorded, not sent. No calendar or home config is loaded.
- The OpenAI key is read at runtime from the installed plugin config and redacted from the
  captured plugin log; it is never printed or stored.
- Spend cap: `$5/day` by default (`--cap`), checked before each scenario against the ledger
  (estimated from the scenario's max duration).
- Recordings stay in the state dir, outside this public repo. The live persona
  (`--profile live`) puts real names into calls and transcripts; keep reports private.
- Never point the lab at the live plugin checkout.

## T2: real phone network

`lab/t2/` runs the same outbound scenarios over the real network. The lab
instance of the plugin (this branch, real Twilio provider) calls our own Twilio
number, and the incoming leg is answered by the scripted party.

```
npx tsx lab/t2/run-t2.ts --dry-run                       # checks only: no routing change, no calls
npx tsx lab/t2/run-t2.ts oh-quick-hello om-voicemail-beep  # runtime live, voice vesper by default
npx tsx lab/t2/run-t2.ts --runtime realtime --voice marin oh-*
npx tsx lab/t2/run-t2.ts --restore                       # put the number's routing back by hand
```

```
lab/t2/
  tunnel.ts        cloudflared quick tunnels (A -> plugin webhook, B -> party / front door)
  boot-real.ts     the plugin via createVoiceCallRuntime with the real Twilio provider
  party-server.ts  POST /front (front door), WS /party (Twilio media stream -> PartyEngine), GET /healthz
  number.ts        read / route / restore the number's voice URL
  run-t2.ts        runner (same run-dir layout and analyzer as T1, arm "t2-<runtime>-<voice>")
```

What a run does to the number:

1. Saves the number's voice URL, method and fallback URL to
   `<state>/t2-number-routing.json`.
2. Sets the voice URL to `https://<tunnel B>/front` and the fallback URL to the
   original (live) voice URL, so Twilio reaches the live assistant if the lab is down.
3. The front door checks the Twilio signature. A call from our own number while a
   lab call is armed (60 s window, one call) gets `<Connect><Stream>` to the party;
   every other call gets `<Redirect>` to the live webhook, so a real caller still
   reaches the live assistant during a run. A bad signature gets 403 (Twilio then
   uses the fallback). Decisions are logged with numbers masked.
4. At the end, on any error, Ctrl-C, SIGTERM or an uncaught exception, the saved
   routing is put back. If the process was killed hard, run `--restore`; the next
   run also restores a leftover saved routing before saving again.

The lab plugin has `inboundPolicy: "disabled"`, transfer off, refuses any
destination but our own number, and stubs the assistant, owner messages and
post-call reports exactly as T1. AMD (`leave-message`) and the plugin's own
recording are on. Per scenario the call directory holds the party's
`recording.wav` (left party sent, right bot received), `events.jsonl` (plus
`bot_hangup` and `amd_twilio`), `plugin.log`, `call.json` (numbers masked),
`meta.json` and the plugin's own recording under `store/recordings/`.

Cost: the daily ledger and cap are shared with T1; T2 adds Twilio voice
(~$0.014/min per leg, two legs) and AMD ($0.0075/call). Each call is a real
outbound call billed by Twilio.

T2 limits: DTMF from the bot reaches the party as Twilio `dtmf` events (fed to the
engine's detector as synthesized tones); event times are from the party's media
clock; inbound scenarios are skipped.

## Limitations

- T1 only: no real network, codec loss or Twilio AMD; the AMD verdict and its time come
  from the scenario. The party's silence is digital silence (no comfort noise).
- Party audio is synthetic TTS; machine prompts, beeps and hold music are synthesized.
- Energy VAD counts any sound (hold music, beeps) as audio; the scenario marks such steps
  as machine/no-reply so they do not count as turns.
- Cost figures for the model are per-minute estimates, not billed usage.
