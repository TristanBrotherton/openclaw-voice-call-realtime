import {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "openclaw/plugin-sdk/tts-runtime";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

/**
 * E.164 phone number format: +[country code][number]
 * Examples use 555 prefix (reserved for fictional numbers)
 */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls how inbound calls are handled:
 * - "disabled": Block all inbound calls (outbound only)
 * - "allowlist": Only accept calls from numbers in allowFrom
 * - "pairing": Unknown callers can request pairing (future)
 * - "open": Accept all inbound calls (dangerous!)
 */
export const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

export const TelnyxConfigSchema = z
  .object({
    /** Telnyx API v2 key */
    apiKey: z.string().min(1).optional(),
    /** Telnyx connection ID (from Call Control app) */
    connectionId: z.string().min(1).optional(),
    /** Public key for webhook signature verification */
    publicKey: z.string().min(1).optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

export const TwilioConfigSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export const PlivoConfigSchema = z
  .object({
    /** Plivo Auth ID (starts with MA/SA) */
    authId: z.string().min(1).optional(),
    /** Plivo Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

// -----------------------------------------------------------------------------
// STT/TTS Configuration
// -----------------------------------------------------------------------------

export const SttConfigSchema = z
  .object({
    /** STT provider (currently only OpenAI supported) */
    provider: z.literal("openai").default("openai"),
    /** Whisper model to use */
    model: z.string().min(1).default("whisper-1"),
  })
  .strict()
  .default({ provider: "openai", model: "whisper-1" });
export type SttConfig = z.infer<typeof SttConfigSchema>;

export { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema };
export type VoiceCallTtsConfig = z.infer<typeof TtsConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const VoiceCallServeConfigSchema = z
  .object({
    /** Port to listen on */
    port: z.number().int().positive().default(3334),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });
export type VoiceCallServeConfig = z.infer<typeof VoiceCallServeConfigSchema>;

export const VoiceCallTailscaleConfigSchema = z
  .object({
    /**
     * Tailscale exposure mode:
     * - "off": No Tailscale exposure
     * - "serve": Tailscale serve (private to tailnet)
     * - "funnel": Tailscale funnel (public HTTPS)
     */
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    /** Path for Tailscale serve/funnel (should usually match serve.path) */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", path: "/voice/webhook" });
export type VoiceCallTailscaleConfig = z.infer<typeof VoiceCallTailscaleConfigSchema>;

// -----------------------------------------------------------------------------
// Tunnel Configuration (unified ngrok/tailscale)
// -----------------------------------------------------------------------------

export const VoiceCallTunnelConfigSchema = z
  .object({
    /**
     * Tunnel provider:
     * - "none": No tunnel (use publicUrl if set, or manual setup)
     * - "ngrok": Use ngrok for public HTTPS tunnel
     * - "tailscale-serve": Tailscale serve (private to tailnet)
     * - "tailscale-funnel": Tailscale funnel (public HTTPS)
     */
    provider: z.enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"]).default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, forwarded headers may be trusted for loopback requests
     * to reconstruct the public ngrok URL used for signing.
     *
     * IMPORTANT: This does NOT bypass signature verification.
     */
    allowNgrokFreeTierLoopbackBypass: z.boolean().default(false),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTierLoopbackBypass: false });
export type VoiceCallTunnelConfig = z.infer<typeof VoiceCallTunnelConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Security Configuration
// -----------------------------------------------------------------------------

export const VoiceCallWebhookSecurityConfigSchema = z
  .object({
    /**
     * Allowed hostnames for webhook URL reconstruction.
     * Only these hosts are accepted from forwarding headers.
     */
    allowedHosts: z.array(z.string().min(1)).default([]),
    /**
     * Trust X-Forwarded-* headers without a hostname allowlist.
     * WARNING: Only enable if you trust your proxy configuration.
     */
    trustForwardingHeaders: z.boolean().default(false),
    /**
     * Trusted proxy IP addresses. Forwarded headers are only trusted when
     * the remote IP matches one of these addresses.
     */
    trustedProxyIPs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ allowedHosts: [], trustForwardingHeaders: false, trustedProxyIPs: [] });
export type WebhookSecurityConfig = z.infer<typeof VoiceCallWebhookSecurityConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Call Configuration
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

export const OutboundConfigSchema = z
  .object({
    /** Default call mode for outbound calls */
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after TTS before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration (OpenAI Realtime STT)
// -----------------------------------------------------------------------------

export const RealtimeSessionPolicySchema = z
  .object({
    /** Enable managed realtime session policy enforcement */
    enabled: z.boolean().default(true),
    /** Open realtime session when media stream connects */
    connectOnStreamStart: z.boolean().default(true),
    /** Close realtime session when media stream disconnects */
    closeOnStreamDisconnect: z.boolean().default(true),
    /** Close session after assistant finishes speaking */
    closeAfterAssistantDone: z.boolean().default(false),
    /** Idle timeout for realtime session (fires only when no audio frames or events at all) */
    idleTimeoutMs: z.number().int().positive().default(120000),
    /** Absolute max realtime session lifetime (must exceed maxDurationSeconds so it never cuts a live call) */
    maxSessionMs: z.number().int().positive().default(7200000),
    /** Maximum reconnect attempts under managed policy */
    maxReconnectAttempts: z.number().int().nonnegative().default(5),
    /** Base reconnect backoff in ms */
    reconnectBackoffMs: z.number().int().positive().default(1000),
    /** Optional no-audio timeout for future use */
    maxConsecutiveNoAudioMs: z.number().int().positive().optional(),
  })
  .strict()
  .default({
    enabled: true,
    connectOnStreamStart: true,
    closeOnStreamDisconnect: true,
    closeAfterAssistantDone: false,
    idleTimeoutMs: 120000,
    maxSessionMs: 7200000,
    maxReconnectAttempts: 5,
    reconnectBackoffMs: 1000,
  });
export type RealtimeSessionPolicy = z.infer<typeof RealtimeSessionPolicySchema>;

export const DeviceVoicePolicySchema = z
  .object({
    /** Stable device/profile identifier */
    id: z.string().min(1),
    /** Optional match hints for selecting this profile */
    match: z
      .object({
        phoneNumbers: z.array(E164Schema).default([]),
      })
      .strict()
      .optional(),
    /** Preferred response length on this device */
    responseLength: z.enum(["short", "medium", "long"]).optional(),
    /** Extra local instructions for this device */
    extraInstructions: z.string().optional(),
    /** Actions forbidden for this device */
    forbiddenActions: z.array(z.string().min(1)).default([]),
    /** Whether tool use is allowed by default on this device */
    allowToolUse: z.boolean().optional(),
    /** Realtime overrides for this device */
    realtime: z
      .object({
        enabled: z.boolean().optional(),
        connectOnStreamStart: z.boolean().optional(),
        closeOnStreamDisconnect: z.boolean().optional(),
        closeAfterAssistantDone: z.boolean().optional(),
        idleTimeoutMs: z.number().int().positive().optional(),
        maxSessionMs: z.number().int().positive().optional(),
        maxReconnectAttempts: z.number().int().nonnegative().optional(),
        reconnectBackoffMs: z.number().int().positive().optional(),
        maxConsecutiveNoAudioMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DeviceVoicePolicy = z.infer<typeof DeviceVoicePolicySchema>;

export const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable real-time audio streaming (requires WebSocket support) */
    enabled: z.boolean().default(false),
    /** Streaming provider mode */
    sttProvider: z
      .enum(["openai-realtime", "openai-realtime-conversation"])
      .default("openai-realtime"),
    /** OpenAI API key for Realtime API (uses OPENAI_API_KEY env if not set) */
    openaiApiKey: z.string().min(1).optional(),
    /** OpenAI transcription model (STT mode) */
    sttModel: z.string().min(1).default("gpt-4o-transcribe"),
    /** OpenAI realtime model (conversation mode) */
    realtimeModel: z.string().min(1).default("gpt-4o-realtime-preview"),
    /** Voice used in conversation mode */
    realtimeVoice: z
      .enum(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"])
      .default("alloy"),
    /** Optional system prompt for conversation mode */
    realtimeSystemPrompt: z.string().optional(),
    /** VAD silence duration in ms before considering speech ended */
    silenceDurationMs: z.number().int().positive().default(800),
    /** VAD threshold 0-1 (higher = less sensitive) */
    vadThreshold: z.number().min(0).max(1).default(0.5),
    /** WebSocket path for media stream connections */
    streamPath: z.string().min(1).default("/voice/stream"),
    /** Managed realtime session lifecycle policy */
    realtimePolicy: RealtimeSessionPolicySchema,
    /**
     * Close unauthenticated media stream sockets if no valid `start` frame arrives in time.
     * Protects against pre-auth idle connection hold attacks.
     */
    preStartTimeoutMs: z.number().int().positive().default(5000),
    /** Maximum number of concurrently pending (pre-start) media stream sockets. */
    maxPendingConnections: z.number().int().positive().default(32),
    /** Maximum pending media stream sockets per source IP. */
    maxPendingConnectionsPerIp: z.number().int().positive().default(4),
    /** Hard cap for all open media stream sockets (pending + active). */
    maxConnections: z.number().int().positive().default(128),
  })
  .strict()
  .default({
    enabled: false,
    sttProvider: "openai-realtime",
    sttModel: "gpt-4o-transcribe",
    realtimeModel: "gpt-4o-realtime-preview",
    realtimeVoice: "alloy",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
    streamPath: "/voice/stream",
    realtimePolicy: {
      enabled: true,
      connectOnStreamStart: true,
      closeOnStreamDisconnect: true,
      closeAfterAssistantDone: false,
      idleTimeoutMs: 120000,
      maxSessionMs: 7200000,
      maxReconnectAttempts: 5,
      reconnectBackoffMs: 1000,
    },
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  });
export type VoiceCallStreamingConfig = z.infer<typeof VoiceCallStreamingConfigSchema>;

// -----------------------------------------------------------------------------
// Call Screening Configuration
// -----------------------------------------------------------------------------

/**
 * Call screening handles interactive screening flows where the callee's phone
 * asks the caller to identify themselves before connecting (e.g. Google Call
 * Screen, carrier spam filters, voicemail gatekeepers).
 *
 * - Non-streaming mode: explicitly listens for a screening prompt, responds
 *   with callerIdentity, then proceeds with the initial message.
 * - Streaming modes: screening-aware instructions are injected into the AI
 *   system prompt so it handles screening autonomously.
 */
export const CallScreeningConfigSchema = z
  .object({
    /** Enable call screening detection and response */
    enabled: z.boolean().default(false),
    /** Identity phrase spoken to the screening system, e.g. "Hi, this is Alex's assistant calling about a reservation." */
    callerIdentity: z.string().optional(),
    /** How long to listen for a screening prompt before assuming no screening (ms) */
    screeningTimeoutMs: z.number().int().positive().default(8000),
  })
  .strict()
  .default({ enabled: false, screeningTimeoutMs: 8000 });
export type CallScreeningConfig = z.infer<typeof CallScreeningConfigSchema>;

// -----------------------------------------------------------------------------
// Main Voice Call Configuration
// -----------------------------------------------------------------------------

export const VoiceCallConfigSchema = z
  .object({
    /** Enable voice call functionality */
    enabled: z.boolean().default(false),

    /** Active provider (telnyx, twilio, plivo, or mock) */
    provider: z.enum(["telnyx", "twilio", "plivo", "mock"]).optional(),

    /** Telnyx-specific configuration */
    telnyx: TelnyxConfigSchema.optional(),

    /** Twilio-specific configuration */
    twilio: TwilioConfigSchema.optional(),

    /** Plivo-specific configuration */
    plivo: PlivoConfigSchema.optional(),

    /** Phone number to call from (E.164) */
    fromNumber: E164Schema.optional(),

    /** Default phone number to call (E.164) */
    toNumber: E164Schema.optional(),

    /** Inbound call policy */
    inboundPolicy: InboundPolicySchema.default("disabled"),

    /** Allowlist of phone numbers for inbound calls (E.164) */
    allowFrom: z.array(E164Schema).default([]),

    /** Greeting message for inbound calls */
    inboundGreeting: z.string().optional(),

    /** Outbound call configuration */
    outbound: OutboundConfigSchema,

    /** Maximum call duration in seconds (hard safety cap; the conversation normally ends via hangup) */
    maxDurationSeconds: z.number().int().positive().default(1800),

    /**
     * Maximum age of a call in seconds before it is automatically reaped.
     * Catches calls stuck in unexpected states (e.g., notify-mode calls that
     * never receive a terminal webhook). Set to 0 to disable.
     * Default: 0 (disabled). Recommended: 120-300 for production.
     */
    staleCallReaperSeconds: z.number().int().nonnegative().default(0),

    /** Silence timeout for end-of-speech detection (ms) */
    silenceTimeoutMs: z.number().int().positive().default(800),

    /** Timeout for user transcript (ms) */
    transcriptTimeoutMs: z.number().int().positive().default(180000),

    /** Ring timeout for outbound calls (ms) */
    ringTimeoutMs: z.number().int().positive().default(30000),

    /** Maximum concurrent calls */
    maxConcurrentCalls: z.number().int().positive().default(1),

    /** Webhook server configuration */
    serve: VoiceCallServeConfigSchema,

    /** Tailscale exposure configuration (legacy, prefer tunnel config) */
    tailscale: VoiceCallTailscaleConfigSchema,

    /** Tunnel configuration (unified ngrok/tailscale) */
    tunnel: VoiceCallTunnelConfigSchema,

    /** Webhook signature reconstruction and proxy trust configuration */
    webhookSecurity: VoiceCallWebhookSecurityConfigSchema,

    /** Real-time audio streaming configuration */
    streaming: VoiceCallStreamingConfigSchema,

    /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** STT configuration */
    stt: SttConfigSchema,

    /** TTS override (deep-merges with core messages.tts) */
    tts: TtsConfigSchema,

    /** Call screening detection and response */
    callScreening: CallScreeningConfigSchema,

    /** Optional device-specific voice policies */
    deviceProfiles: z.array(DeviceVoicePolicySchema).default([]),

    /** Store path for call logs */
    store: z.string().optional(),

    /** Model for generating voice responses (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o") */
    responseModel: z.string().default("openai/gpt-4o-mini"),

    /** System prompt for voice responses */
    responseSystemPrompt: z.string().optional(),

    /** Timeout for response generation in ms (default 30s) */
    responseTimeoutMs: z.number().int().positive().default(30000),

    /** Model used to summarize call transcripts at call end (OpenAI chat model id) */
    summaryModel: z.string().min(1).default("gpt-4o-mini"),

    /**
     * Log call transcript content (user speech, AI responses, partials) to the
     * gateway log. Off by default: phone calls routinely contain personal
     * data. When false, only lengths are logged. Transcript files and
     * summaries are unaffected.
     */
    logTranscripts: z.boolean().default(false),
  })
  .strict();

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

/**
 * Resolves the configuration by merging environment variables into missing fields.
 * Returns a new configuration object with environment variables applied.
 */
export function resolveVoiceCallConfig(config: VoiceCallConfig): VoiceCallConfig {
  const resolved = JSON.parse(JSON.stringify(config)) as VoiceCallConfig;

  // Telnyx
  if (resolved.provider === "telnyx") {
    resolved.telnyx = resolved.telnyx ?? {};
    resolved.telnyx.apiKey = resolved.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
    resolved.telnyx.connectionId = resolved.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
    resolved.telnyx.publicKey = resolved.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  }

  // Twilio
  if (resolved.provider === "twilio") {
    resolved.twilio = resolved.twilio ?? {};
    resolved.twilio.accountSid = resolved.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    resolved.twilio.authToken = resolved.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  }

  // Plivo
  if (resolved.provider === "plivo") {
    resolved.plivo = resolved.plivo ?? {};
    resolved.plivo.authId = resolved.plivo.authId ?? process.env.PLIVO_AUTH_ID;
    resolved.plivo.authToken = resolved.plivo.authToken ?? process.env.PLIVO_AUTH_TOKEN;
  }

  // Tunnel Config
  resolved.tunnel = resolved.tunnel ?? {
    provider: "none",
    allowNgrokFreeTierLoopbackBypass: false,
  };
  resolved.tunnel.allowNgrokFreeTierLoopbackBypass =
    resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
  resolved.tunnel.ngrokAuthToken = resolved.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN;
  resolved.tunnel.ngrokDomain = resolved.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN;

  // Webhook Security Config
  resolved.webhookSecurity = resolved.webhookSecurity ?? {
    allowedHosts: [],
    trustForwardingHeaders: false,
    trustedProxyIPs: [],
  };
  resolved.webhookSecurity.allowedHosts = resolved.webhookSecurity.allowedHosts ?? [];
  resolved.webhookSecurity.trustForwardingHeaders =
    resolved.webhookSecurity.trustForwardingHeaders ?? false;
  resolved.webhookSecurity.trustedProxyIPs = resolved.webhookSecurity.trustedProxyIPs ?? [];

  return resolved;
}

/**
 * Validate that the configuration has all required fields for the selected provider.
 */
export function validateProviderConfig(config: VoiceCallConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.provider) {
    errors.push("plugins.entries.voice-call.config.provider is required");
  }

  if (!config.fromNumber && config.provider !== "mock") {
    errors.push("plugins.entries.voice-call.config.fromNumber is required");
  }

  if (config.provider === "telnyx") {
    if (!config.telnyx?.apiKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    }
    if (!config.telnyx?.connectionId) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
      );
    }
    if (!config.skipSignatureVerification && !config.telnyx?.publicKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
      );
    }
  }

  if (config.provider === "twilio") {
    if (!config.twilio?.accountSid) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );
    }
    if (!config.twilio?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "plivo") {
    if (!config.plivo?.authId) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    }
    if (!config.plivo?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
