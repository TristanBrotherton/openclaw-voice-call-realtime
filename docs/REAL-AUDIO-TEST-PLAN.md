# Real-audio test loop for phone calls

Status: design, 2026-10-16. Not built yet.

## Why

Unit tests show what the plugin *sent*. Only a recording of a real call shows
what the other party *heard*: a greeting spoken over a voicemail prompt, a
first syllable lost to the codec, two "one moment"s, a goodbye cut off by the
hangup, three seconds of dead air before a reply. Every change to how calls
sound or behave goes through this loop before it reaches real calls, and every
regression found on a real call becomes a scenario in it.

## Shape: three tiers, one corpus

| Tier | What runs | Cost per scenario | When |
|---|---|---|---|
| T0 unit | vitest; fake OpenAI and Twilio | free, seconds | every change |
| T1 replay | the real plugin and the real voice model (GPT-Live or Realtime); a local fake Twilio Media Stream plays recorded 8 kHz audio and records what comes back; Twilio webhooks (status, AMD) simulated | ~$0.05–0.20 of model time | every change to call behaviour |
| T2 real phone | a real PSTN call between the plugin's number and a second Twilio number run by the test harness (the "party"); dual-channel Twilio recording | ~$0.10–0.40 incl. Twilio minutes | before deploying; nightly while iterating |
| T3 handset | a real phone (Call Screen, iOS Live Voicemail, carrier voicemail) | manual | rare, when screener behaviour changes |

The same scenario file drives T1 and T2. T1 is the fast inner loop; T2
confirms on the real network (real codec, real AMD, real jitter, real
latency). T1 cannot exercise Twilio AMD, so voicemail scenarios get their
verdict from the scenario file in T1 and from Twilio in T2.

## The party (scripted other end)

A small harness service (in this repo, `lab/`) that answers the second
Twilio number with a bidirectional Media Stream and plays a scenario:

- **Scripted turns**: pre-rendered audio clips with gates, as in the Voice PE
  corpus ("speak when the bot has finished", "speak 0.8 s into the bot's
  reply" for barge-in, "stay silent 20 s").
- **Actor mode**: a voice model plays a described person ("a busy
  receptionist who answers with the business name and puts you on hold") for
  free-form conversation. Its turns are recorded like scripted ones.
- **Listens**: VAD on the bot's audio to time gates; DTMF detection to check
  keys the bot pressed; a transcript of the bot.

For inbound scenarios the party *calls* the plugin's number instead.

## Audio sources

- Rendered with OpenAI TTS and macOS voices at several speeds and accents,
  encoded to 8 kHz mu-law, so every phrase is reproducible.
- Real recordings where synthetic audio would mislead: the owner's own
  voicemail greeting, carrier default greetings and beeps, hold music,
  a Google Call Screen prompt. Recorded once from our own lines only, kept
  in `lab/fixtures/` (private, never published).
- Degradations mixed in at render time: line noise, packet-loss gaps,
  low volume, a TV in the background.

## Scenarios (first corpus)

Outbound, human: quick "hello?"; slow pickup with silence; answers with a
name ("Dr Lee's office"); interrupts the bot mid-sentence; asks "who is
this?"; goes silent for 20 s; hangs up mid-answer; wrong person answers;
switches to Spanish; bad line; long slow lookup (ask_assistant).

Outbound, machines: standard carrier voicemail with beep; long custom
greeting (25 s); greeting with no beep; mailbox full; phone menu "press 1
for…", with hold music and then a human; Google Call Screen; iOS Live
Voicemail prompt.

Inbound: known caller; unknown caller (take a message); caller silent;
second caller while one is active; transfer to owner who doesn't answer.

Each scenario states its expectations: outcome (human / voicemail left /
menu navigated / hung up), tools that must or must not run, keys pressed,
phrases that must or must not be heard, and latency budgets.

## What is measured (from the two recorded channels)

- **Turn latency**: party speech end to bot audio heard (p50/p90 per class).
- **Talk-over**: seconds both channels speak at once, excluding a deliberate
  barge-in; bot speech during a voicemail greeting (must be 0).
- **Dead air**: any gap over 3 s where the bot owes a reply.
- **Voicemail**: message starts after the beep; whole message inside the
  recording; call ends after it.
- **Heard vs generated**: the bot's own transcript against the transcript of
  its recorded channel (clipped first words, cut-off goodbyes, lines the
  model "said" that never played).
- **Goodbye**: last bot line heard to the end before hangup.
- **Tools and keys**: from plugin logs and the party's DTMF detector.
- **Naturalness**: an LLM judge scores each call (pickup, pacing, filler,
  repetition, tone, recovery) against a fixed rubric, with the transcript
  and timing; scores are tracked, not gating.
- **Cost**: model and Twilio cost per call.

Every run appends rows to a results store; the report compares runs with
percentile deltas (bootstrap), so a change is judged by numbers, not by one
call.

## Sharing with Voice PE

The Voice PE lab (`~/development/voice-pe/lab/voicepe_lab`) already has the
corpus format, results store, report with bootstrap deltas and cost
accounting. They move into one shared lab core used by both rigs; the phone
rig adds the party, the Twilio recording collector and the phone metrics. No
second copy of store/report/corpus code.

## Safety

- The harness dials only the party number and the plugin's own number; any
  other destination is refused in code.
- A per-run and per-day spend cap (default $5/day), checked before each call.
- Twilio recordings are downloaded and then deleted from Twilio; local
  recordings are purged after 14 days unless kept for a regression.
- Real tool side effects are stubbed or pointed at test fixtures: no real
  iMessages, owner calls or transfers to the owner's phone from the lab.

## Loop for improvement

1. Change the plugin.
2. T0, then the T1 suite (minutes).
3. Read the report: failures, latency and talk-over deltas against the last
   good run, judge scores; listen to any flagged call.
4. Iterate; then T2 on the real network before deploying.
5. A problem seen on a real call is turned into a scenario first, then
   fixed.
