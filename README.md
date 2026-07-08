# OpenClaw Voice Call — Realtime Edition

**Give your AI assistant a phone.**

This OpenClaw plugin lets your assistant place and receive real phone calls and hold natural, full-duplex voice conversations — powered by Twilio Programmable Voice and the OpenAI Realtime API. It books your table, checks the store's hours, navigates the phone menu, gets a human on the line, wraps up politely, hangs up on its own, and reports back with a structured outcome, an AI-written summary, and the full transcript.

```
You:        "Call Luigi's and book a table for two on Friday at 7."
Assistant:  *dials, talks past the IVR, negotiates with the host, confirms details*
Assistant:  "Booked — table for 2, Friday 7pm, under your name.
             They said parties over 15 minutes late lose the table."
```

## Why this exists

Every "AI agent" can send an email. Almost none of them can call the dry cleaner. The real world still runs on phone calls — restaurants, doctors' offices, contractors, that one store whose website hasn't been updated since 2019. This plugin closes that gap: your assistant gets a phone number, a voice, ears, a keypad, and the judgment to end the call when the job is done.

## Features

- **Full conversation mode** — Twilio Media Streams bridged to the OpenAI Realtime API (speech-to-speech, GA protocol). Sub-second turnaround, natural barge-in when the other party interrupts.
- **In-call tools** the voice AI uses autonomously:
  - `press_phone_keys` — synthesized DTMF touch-tones for navigating IVR menus ("press 2 for reservations")
  - `report_call_outcome` — structured result capture (status + every fact gathered: times, prices, confirmation numbers)
  - `end_call` — graceful hangup: speaks a closing line, waits for it to *actually play out* on the line (Twilio mark echo), then disconnects. No clipped goodbyes, no lingering dead air.
- **Transcripts & summaries** — every call is finalized into a Markdown transcript with an AI-generated summary and the reported outcome. Retrievable after the call via the `get_transcript` tool action.
- **Call screening awareness** — handles Google Call Screen and voicemail gatekeepers by identifying itself with a configurable identity phrase.
- **Goal-directed calls** — pass `talking_points` and `call_party` (first-party vs third-party) and the AI stays on task: cover the points, collect the answers, confirm out loud, wrap up.
- **Inbound calls** (optional) — allowlist-gated, with a configurable greeting.
- **Device profiles** — per-caller policies: response length, forbidden actions, extra instructions.
- **Hardened by default** — Twilio webhook signature verification, per-call stream auth tokens, pre-auth connection throttling, SSRF-guarded provider API calls, call-duration safety caps, stale-call reaping.
- **Providers** — Twilio (recommended, full realtime conversation mode), plus Telnyx / Plivo / mock for the legacy TTS+STT pipeline.

## Use cases

- **Reservations & appointments** — restaurants, salons, dentists: "book me the earliest slot Thursday afternoon."
- **Information gathering** — opening hours, stock checks, price quotes, "is the kitchen still open?"
- **Errand triage** — call the pharmacy about a refill, the contractor about a quote, the venue about parking.
- **Notifications with a human touch** — a call that speaks a message and confirms it was heard, not just a text that might be missed.
- **Reaching *you*** — your assistant can call your own phone when something needs a real-time decision, and you can just *talk* to it.
- **Inbound assistant line** — allowlisted callers can ring your assistant directly and converse with it.

## How it works

```
 Phone network                Your machine                        OpenAI
┌─────────────┐   webhooks   ┌──────────────────────┐
│   Twilio    │ ───────────► │  Plugin webhook       │
│ Programmable│              │  server (HTTP)        │
│    Voice    │ ◄─────────── │  · TwiML <Connect>    │
│             │   TwiML      │    <Stream>           │
│             │              │                       │
│  Media      │  WebSocket   │  Media stream         │  WebSocket  ┌──────────┐
│  Streams    │ ◄══════════► │  handler (μ-law 8kHz) │ ◄═════════► │ Realtime │
└─────────────┘   audio      └──────────────────────┘    audio    │   API    │
                                                                   └──────────┘
```

The plugin runs an HTTP server inside the OpenClaw gateway. Twilio fetches TwiML from it and opens a bidirectional audio WebSocket; the plugin bridges that audio to an OpenAI Realtime session which does STT, reasoning, tool calls, and TTS in one loop.

## Requirements

- **OpenClaw** ≥ 2026.6 (the plugin loads as a path plugin and runs inside the gateway)
- **Twilio account** with a voice-capable phone number (~$1.15/mo + ~$0.014/min)
- **OpenAI API key** with Realtime API access (`gpt-realtime-2.1` recommended)
- **A public HTTPS URL** reaching the plugin's webhook port (Cloudflare Tunnel, ngrok, or Tailscale Funnel — walkthrough below)

---

# Installation

## 1. Get the plugin

```bash
mkdir -p ~/.openclaw/plugins-src
git clone https://github.com/TristanBrotherton/openclaw-voice-call-realtime.git \
  ~/.openclaw/plugins-src/voice-call-realtime
cd ~/.openclaw/plugins-src/voice-call-realtime
npm install --omit=dev
```

## 2. Set up Twilio (detailed)

1. **Create an account** at [twilio.com](https://www.twilio.com/try-twilio). Trial accounts work for testing but can only call verified numbers and play a trial notice — **upgrade (add billing)** for real use.
2. **Buy a voice-capable phone number**: Console → *Phone Numbers → Manage → Buy a number*. Check the **Voice** capability box. Pick a local number; note it in E.164 form (e.g. `+15551234567`).
3. **Get your credentials**: Console home page → *Account Info* panel:
   - **Account SID** — starts with `AC…`
   - **Auth Token** — click to reveal. Treat it like a password; it signs and verifies every webhook.
4. **Geo permissions** (only if calling outside your country): Console → *Voice → Settings → Geo permissions* — enable the destination countries.
5. **Inbound calls (optional)**: Console → your phone number → *Voice Configuration* → set **"A call comes in"** to *Webhook*, URL = your public webhook URL (below), method POST. For **outbound-only** use you can skip this — the plugin passes TwiML URLs per call via the API.

## 3. Expose the webhook publicly

Twilio must reach the plugin's webhook server (default port `3336`) over HTTPS. **Cloudflare Tunnel** (free, stable hostname) is recommended:

```bash
brew install cloudflared            # or apt/pacman equivalent
cloudflared tunnel login            # authorize against your Cloudflare-managed domain
cloudflared tunnel create voice
cloudflared tunnel route dns voice voice.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: voice
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: voice.yourdomain.com
    service: http://localhost:3336
  - service: http_status:404
```

Run it: `cloudflared tunnel run voice`

**Make it survive reboots.** A dead tunnel silently breaks all calls. On macOS, install a LaunchAgent (`~/Library/LaunchAgents/com.you.cloudflared-voice.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.cloudflared-voice</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string><string>--config</string>
    <string>/Users/you/.cloudflared/config.yml</string>
    <string>run</string><string>voice</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>/tmp/cloudflared-voice.log</string>
  <key>StandardErrorPath</key><string>/tmp/cloudflared-voice.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.cloudflared-voice.plist
```

On Linux, use a systemd unit with `Restart=always`. Alternatives: `ngrok http 3336` (set `tunnel.provider: "ngrok"` for auto-management) or `tailscale funnel 3336`.

## 4. Configure OpenClaw

In `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["voice-call-tristan"],          // plus your other plugins
    "load": { "paths": ["/Users/you/.openclaw/plugins-src"] },
    "entries": {
      "voice-call-tristan": {
        "enabled": true,
        "config": {
          "enabled": true,
          "provider": "twilio",
          "fromNumber": "+15551234567",       // your Twilio number
          "toNumber": "+15557654321",         // default destination (you)
          "twilio": {
            "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "authToken": "your_twilio_auth_token"
          },
          "serve": { "port": 3336, "bind": "127.0.0.1", "path": "/voice/webhook" },
          "publicUrl": "https://voice.yourdomain.com/voice/webhook",
          "outbound": { "defaultMode": "conversation" },
          "maxDurationSeconds": 3600,
          "streaming": {
            "enabled": true,
            "sttProvider": "openai-realtime-conversation",
            "realtimeModel": "gpt-realtime-2.1",
            "realtimeVoice": "alloy",
            "openaiApiKey": "sk-...",
            "realtimePolicy": { "idleTimeoutMs": 120000, "maxSessionMs": 7200000 }
          },
          "callScreening": {
            "enabled": true,
            "callerIdentity": "Hi, this is Alex's AI assistant calling on their behalf."
          }
        }
      }
    }
  }
}
```

Validate and restart:

```bash
openclaw config validate
openclaw gateway restart
```

You should see in the gateway logs:

```
[voice-call] Media streaming initialized
[voice-call] Webhook server listening on http://127.0.0.1:3336/voice/webhook
[voice-call] Runtime initialized
```

Smoke-test the public URL — both must succeed before dialing:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://voice.yourdomain.com/voice/webhook   # → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://voice.yourdomain.com/voice/stream                                                   # → 101
```

---

# Usage

Your OpenClaw agent gets a `voice_call` tool with these actions:

```jsonc
// Place a goal-directed call
{ "action": "initiate_call",
  "to": "+15558675309",
  "message": "Hi! I'm calling on behalf of Alex to book a table.",
  "mode": "conversation",
  "call_party": "third-party",
  "talking_points": ["Table for 2", "Friday around 7pm", "Get a confirmation number"] }

// Check on it
{ "action": "get_status", "callId": "<id>" }

// After it ends: summary, structured outcome, and full transcript
{ "action": "get_transcript", "callId": "<id>" }
```

In practice you just tell your assistant *"call the restaurant and book a table for two on Friday at 7"* — it fills all of this in itself. During the call, the voice AI autonomously presses IVR keys, records the outcome, confirms details out loud, says goodbye, and hangs up.

Transcript files land in `~/.openclaw/voice-calls/transcripts/<callId>.md` with metadata, the reported outcome, an AI summary, and the timestamped dialogue.

Gateway RPCs are also available: `voicecall-tristan.initiate`, `.status`, `.transcript`, `.end`, `.speak`, `.continue`.

## Key configuration reference

| Key | Default | Notes |
|---|---|---|
| `provider` | — | `twilio` (recommended), `telnyx`, `plivo`, `mock` |
| `fromNumber` / `toNumber` | — | E.164; `toNumber` is the default call target |
| `outbound.defaultMode` | `notify` | Use `conversation` for two-way calls |
| `maxDurationSeconds` | `1800` | Hard safety cap per call |
| `streaming.realtimeModel` | `gpt-4o-realtime-preview` | Use `gpt-realtime-2.1` |
| `streaming.realtimeVoice` | `alloy` | `alloy` `ash` `ballad` `coral` `echo` `sage` `shimmer` `verse` |
| `streaming.realtimeSystemPrompt` | — | Base personality/instructions for the voice AI |
| `streaming.realtimePolicy.maxSessionMs` | `7200000` | Realtime session lifetime cap; keep above `maxDurationSeconds` |
| `callScreening.callerIdentity` | — | Phrase spoken to call-screening systems |
| `inboundPolicy` | `disabled` | `allowlist` + `allowFrom: ["+1555…"]` to accept inbound |
| `summaryModel` | `gpt-4o-mini` | Chat model for end-of-call summaries |
| `skipSignatureVerification` | `false` | Leave `false` in production |
| `deviceProfiles` | `[]` | Per-caller response length / forbidden actions / instructions |

## Security notes

- **Keep webhook signature verification on** (`skipSignatureVerification: false`). Your webhook URL is public; verification is what stops forged call events.
- Media stream connections are authenticated with **per-call tokens** passed via TwiML `<Parameter>`, with pre-auth connection throttling on top.
- **Inbound is off by default.** If you enable it, use `allowlist`.
- The voice AI's only tools are call-control (hang up, record outcome, press keys) — it cannot touch your machine, files, or other OpenClaw tools from inside a call.
- On third-party calls the AI is instructed not to volunteer private information beyond the call goal; add hard rules via `deviceProfiles[].forbiddenActions`.
- Your Twilio auth token and OpenAI key live in your OpenClaw config — keep its permissions tight (`chmod 600`).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Twilio error 11200, calls never connect | Public URL unreachable — tunnel down. `curl -X POST` your `publicUrl`; expect 200. |
| Call connects, instant dead air | OpenAI key missing/invalid, or no Realtime access. Check gateway logs for `[RealtimeConversation] API error`. |
| `beta_api_shape_disabled` in logs | You're on an old build — this plugin uses the GA Realtime protocol. Update. |
| Webhook 403s | Signature verification failing — `publicUrl` must exactly match the URL Twilio calls (scheme, host, path). |
| `EADDRINUSE: port 3336` | Another instance (or the stock voice-call plugin) is bound. Disable the stock plugin. |
| Config rejected: "must not have additional properties" | Gateway has a stale manifest snapshot: `openclaw plugins registry --refresh` then restart the gateway. |
| Goodbye clipped / talks over hangup | Fixed in 2026.7.7 — update. |

## Development

```bash
npm install       # dev deps include openclaw for SDK types
npm test          # vitest, 118 tests
```

Layout: `src/manager/` call state machine · `src/providers/` telephony + realtime providers · `src/media-stream.ts` Twilio↔OpenAI audio bridge · `src/webhook.ts` HTTP server + in-call tool handlers · `src/transcript.ts` finalization + summaries · `src/dtmf.ts` touch-tone synthesis.

## Credits & license

MIT. Forked from the official [OpenClaw](https://openclaw.ai) `voice-call` plugin (MIT, © OpenClaw Foundation) and extended with the GA Realtime migration, in-call tools, graceful hangup, DTMF, transcripts/summaries, and reliability fixes.
