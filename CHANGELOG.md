# Changelog

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
