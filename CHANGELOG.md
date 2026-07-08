# Changelog

## 2026.7.19

### Changes

- Direct Home Assistant backend (`homeAssistant`): check_home reads device
  status in ~1s (vs tens of seconds via the agent bridge); control_home
  (opt-in via allowControl) performs a bounded command set (on/off/toggle/
  lock/unlock/open/close) on one entity. Both tools are offered only on
  verified owner/trusted calls; never to third-party/unverified. baseUrl/
  token fall back to HA_BASE_URL / HA_TOKEN. allowControl defaults off.

## 2026.7.18

### Changes

- `assistantBridge.ownerActions` (off | confirm-sensitive | full): verified
  owner/trusted calls can drive the agent's full toolset through
  ask_assistant, not just ask questions. Third-party/unverified calls remain
  questions-only regardless. The phone-facing model still holds no tools
  directly — the agent is the sole executor and boundary. Default
  confirm-sensitive requires spoken confirmation for irreversible actions.

## 2026.7.17

### Changes

- `inboundSecurity.rejectUnverified`: fail-closed inbound. Calls that do not
  pass the identity checks (allowlist + STIR attestation A when required)
  are rejected with TwiML <Reject> before the call is answered — no realtime
  session is created and no per-minute charges accrue.

## 2026.7.16

### Changes

- Inbound caller verification: number-based trust tiers now require
  SHAKEN/STIR attestation A (`inboundSecurity.trustStirA`, default on) since
  caller ID is spoofable; optional spoken `passphrase` verified via the new
  verify_passphrase tool (never placed in the prompt) upgrades a caller to
  owner for the call. Trust context injected into inbound call prompts.
- Ending etiquette: goodbye lives ONLY in end_call final_message (no spoken
  wrap-up first), never say "the owner" aloud, follow-up status stated at
  most once, ask_assistant fallback wording adapts to who is on the call.

## 2026.7.15

### Changes

- Fixed calendar-question routing: check_calendar is now described (and the
  guidance enforces) as the tool for ANY schedule question; the model no
  longer routes calendar lookups through the slow ask_assistant path.
- Anti-leak etiquette: tool results/timeouts/errors are marked internal —
  the voice AI must never say "system", "tool", "lookup", "timed out" or
  similar to the other party; failures are voiced as natural follow-ups.
- `streaming.language`: transcription language hint — prevents hallucinated
  foreign-language transcripts on short utterances.

## 2026.7.14

### Changes

- `ask_owner` in-call tool (opt-in via `askOwner.enabled`): mid-call text
  escalation. The voice AI messages the owner a question through their
  agent's usual channel and waits (default 2 min) while the caller holds;
  the owner's reply routes back into the live call via the new
  answer_call_question tool action. On timeout the AI proceeds
  conservatively. get_status now surfaces pending questions.

## 2026.7.13

### Changes

- `calendar.command`: local command backend for check_calendar (e.g.
  icalBuddy on macOS) — availability answers in ~1-2s instead of routing a
  full agent turn. `calendar.commandThirdParty` runs a privacy-reduced
  variant (busy times only) on third-party/unverified calls.
- `voicecall-<id>.calendar` gateway RPC for testing the calendar backend.
- Greeting is now one combined opening (identity + purpose); narration-style
  intro messages ("calling you now") are rephrased instead of spoken.

## 2026.7.12

### Changes

- Post-call reports (`postCallReport.enabled`): when a call finalizes, the
  owner's OpenClaw agent is briefed automatically — it messages the owner and
  performs obvious follow-ups. The voice_call tool stops advising polling
  when this is on.
- Answering-machine detection (`amd.enabled`): Twilio async AMD with
  DetectMessageEnd; policy on machine pickup — leave-message (voicemail after
  the beep, default), hangup, or continue. Verdict recorded in metadata.
- Mid-call transfer (`transfer.enabled`): new transfer_to_owner in-call tool —
  announces the handoff, drains playback, then redirects the call to the
  owner's phone via TwiML <Dial> with a no-answer fallback.
- Semantic turn detection (`streaming.turnDetection: "semantic_vad"` with
  `vadEagerness`): thought-aware end-of-turn detection, fewer interruptions.

## 2026.7.11

### Changes

- Fixed duplicate empty call records: the provider's final status callback
  after a bot-initiated hangup no longer resurrects the call.
- Fixed double self-introduction at call start (greeting + identity prompt
  racing the VAD auto-response).
- ask_assistant: default timeout raised to 60s, optional
  `assistantBridge.model` override for faster bridge runs, and the voice AI
  now warns the other party the check may take up to a minute.

## 2026.7.10

### Changes

- `assistantBridge.trustedNumbers`: allowlist of E.164 numbers treated like
  the owner for the bridge action policy. Trusted contacts can ask the agent
  to perform actions (attributed to them); all other third parties remain
  questions-only.

## 2026.7.9

### Changes

- New `ask_assistant` in-call tool (opt-in via `assistantBridge.enabled`):
  the voice AI can relay a question to the owner's OpenClaw agent mid-call
  and use the answer — calendar availability, preferences, facts. The agent
  answers via a scoped subagent turn and is told the question comes from a
  live call, so it applies its own judgment about what to share.
- New `check_calendar` in-call tool (opt-in via `calendar.icsUrl`): free/busy
  from a secret iCal feed (Google/iCloud/Outlook/Fastmail), computed locally.
  Only busy windows are exposed — never event titles or details.

## 2026.7.8

### Changes

- Fixed `package-lock.json`: previous lockfile referenced local filesystem
  paths and broke `npm ci` / `npm install` on other machines. The `openclaw`
  dev dependency now resolves from the npm registry.
- Privacy: call content (transcripts, partials, AI responses, DTMF digits,
  tool arguments) is no longer written to gateway logs by default. Opt in
  with `logTranscripts: true`. Transcript files are unaffected.
- Hardening: media stream WebSocket server now sets `maxPayload: 64KB`.

## 2026.7.7 — Realtime Edition

### Changes

- Migrated to the GA OpenAI Realtime API (the beta protocol was retired by
  OpenAI with `beta_api_shape_disabled`); legacy event names kept as aliases.
- In-call tools for the voice AI: `end_call` (graceful hangup — final message
  is spoken and fully played out via Twilio mark echo before disconnect),
  `report_call_outcome` (structured result capture), `press_phone_keys`
  (synthesized DTMF for IVR menus).
- End-of-call transcripts: Markdown transcript file per call with an
  AI-generated summary and reported outcome; `get_transcript` tool action and
  `.transcript` gateway RPC work after the call ends.
- Barge-in is disabled during call wrap-up so the goodbye cannot be flushed
  by the other party talking over it.
- Greeting delivery hardened against reading instruction text aloud.
- `speak`/`continue_call` route through the realtime session in conversation
  mode (previously they issued TwiML that replaced <Connect><Stream> and
  dropped the call).
- Session instructions survive websocket reconnects; OpenAI error events are
  logged; response.cancel only sent when a response is active.
- Sane lifetime defaults: maxDurationSeconds 1800, realtime maxSessionMs 2h,
  idleTimeoutMs 120s (previously calls were cut at 3-5 minutes).
- Memory-leak fixes (bounded event dedupe sets), guarded websocket upgrade
  handler, test store-path collision fix.


## 2026.3.2

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.1

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.26

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.25

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.24

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.22

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.26

### Changes

- Breaking: voice-call TTS now uses core `messages.tts` (plugin TTS config deep‑merges with core).
- Telephony TTS supports OpenAI + ElevenLabs; Edge TTS is ignored for calls.
- Removed legacy `tts.model`/`tts.voice`/`tts.instructions` plugin fields.
- Ngrok free-tier bypass renamed to `tunnel.allowNgrokFreeTierLoopbackBypass` and gated to loopback + `tunnel.provider="ngrok"`.

## 0.1.0

### Highlights

- First public release of the @openclaw/voice-call plugin.

### Features

- Providers: Twilio (Programmable Voice + Media Streams), Telnyx (Call Control v2), and mock provider for local dev.
- Call flows: outbound notify vs. conversation modes, configurable auto‑hangup, and multi‑turn continuation.
- Inbound handling: policy controls (disabled/allowlist/open), allowlist matching, and inbound greeting.
- Webhooks: built‑in server with configurable bind/port/path plus `publicUrl` override.
- Exposure helpers: ngrok + Tailscale serve/funnel; dev‑only signature bypass for ngrok free tier.
- Streaming: OpenAI Realtime STT over media WebSocket with partial + final transcripts.
- Speech: OpenAI TTS (model/voice/instructions) with Twilio `<Say>` fallback.
- Tooling: `voice_call` tool actions for initiate/continue/speak/end/status.
- Gateway RPC: `voicecall.initiate|continue|speak|end|status` (+ legacy `voicecall.start`).
- CLI: `openclaw voicecall` commands (call/start/continue/speak/end/status/tail/expose).
- Observability: JSONL call logs and `voicecall tail` for live inspection.
- Response controls: `responseModel`, `responseSystemPrompt`, and `responseTimeoutMs` for auto‑responses.
