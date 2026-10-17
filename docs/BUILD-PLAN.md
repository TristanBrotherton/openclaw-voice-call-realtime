# Build plan: GPT-Live by default, real-audio lab, natural calls

Started 2026-10-16. Branch `feat/live-lab`, dev worktree
`~/development/voice-call-plugin-dev` (outside the OpenClaw plugin load path,
so the live plugin keeps running `main` until we deploy).

## Probe result (2026-10-16)

`gpt-live-1` works with our key: Responses delegation (`gpt-6-luna`, priority
tier), one function tool. Events seen: `session.started`,
`session.output_audio.delta` (`delta`, 24 kHz PCM16, continuous from session
start), `session.input_transcript.delta` / `session.output_transcript.delta`
(`start_ms`/`end_ms`), `session.delegation.created`, `response.event`
envelopes (Responses stream: `output_item.done` with the function call,
`output_text.done`, `completed`), `session.usage.updated`, `session.closed`.
Speech end to first reply words ~0.5 s; a tool answer ~2.6 s, with Live's own
"one second" in between.

## Milestones (each ends with tests green and a lab run)

1. **Lab core (T0/T1).** Scenario format, the scripted party, a fake Twilio
   media stream that drives the real plugin in-process, two-channel recording,
   metrics (turn latency, talk-over, dead air, heard vs generated), results
   store and report. Baseline run on today's Realtime runtime.
2. **Audio layer.** mu-law 8 kHz <-> PCM16 24 kHz resampling, a playout clock
   (what Twilio has buffered), an output lead buffer for Live's real-time
   pacing, a caller-side voice activity detector.
3. **GPT-Live runtime.** `GptLiveConversationSession` behind the existing
   session interface: deferred `session.start` (prompt known first), pre-start
   audio replay, Responses delegation for all call tools (TS port of the
   delegation ledger), speaking/quiet detection in place of response events,
   history on reconnect. Config `streaming.runtime: "live" | "realtime"`, Live
   default for us, automatic fallback to Realtime when Live cannot connect.
4. **Reliability.** No dead air on a failed model connection (fallback, then
   spoken apology and hangup); silence check based on real speech ("are you
   still there?"); history kept across reconnects; Realtime transcript
   truncated at the point the caller interrupted; warning before the maximum
   call length; reports for unanswered, busy and failed calls.
5. **Pickup and voicemail.** Wait for the other side's first words before
   speaking; short "hello" releases at once, a long greeting waits for the
   AMD verdict; voicemail: message after the beep, capped, then hang up;
   screeners answered once; silent pickup gets a "hello?".
6. **Unexpected situations.** Hold (model declares hold, silence check
   suspended, capped), phone menus (wait for the prompt, then keys; keys the
   caller presses), wrong person, bad line, language switch (transcription
   language unlocked), caller hangs up mid-lookup (lookup cancelled).
7. **Natural conversation.** Background tasks for slow lookups with a later
   answer by voice or text, one fallback "one moment" clip, verified-result
   wording, answers counted as delivered only when heard, assistant context
   kept across the call, per-turn timing log.
8. **T2 real phone runs** (one number: the plugin calls its own number; the
   number's voice URL points at the lab front door for the run, which
   redirects any non-lab call to the live webhook; fallback URL = live; URL
   restored after the run). Then deploy to `main` and the live plugin.

## Sharing

- Phone lab analysis is Python and uses the Voice PE lab's store and report
  (`voicepe_lab`) instead of a second copy; the generic parts move into one
  shared lab core with the Voice PE session.
- Spoken fixed lines and persona text live in one file per purpose, read by
  both runtimes. Voice PE's JS bridge helpers (`voice-pe-bridge/lib`) are
  reused when the assistant-bridge work (milestone 7) needs them.

## Deploy notes (the maintainer's install only, not code defaults)

The public defaults stay conservative; the maintainer's `openclaw.json` sets:
`streaming.runtime: "live"` (GPT-Live by default for us),
`streaming.live.voice: "vesper"` (the voice the Voice PE devices use on GPT-Live) and
`recording.enabled: true` (record every call; code default is off, see
README "Call recording").

## Budget and safety

$5/day lab cap (model + Twilio), checked before each run. The lab dials only
our own number. Recordings live in `~/.local/state/voice-call-lab/`, never in
the repo (public). Tool side effects in the lab are stubbed: no iMessages, no
transfers, no owner calls.
