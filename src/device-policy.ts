import type { VoiceCallConfig } from "./config.js";
import type { CallParty } from "./types.js";

export type VoiceResponseLength = "short" | "medium" | "long";

export type EffectiveRealtimePolicy = {
  enabled: boolean;
  connectOnStreamStart: boolean;
  closeOnStreamDisconnect: boolean;
  closeAfterAssistantDone: boolean;
  idleTimeoutMs: number;
  maxSessionMs: number;
  maxReconnectAttempts: number;
  reconnectBackoffMs: number;
  maxConsecutiveNoAudioMs?: number;
};

export type EffectiveDevicePolicy = {
  deviceId?: string;
  responseLength?: VoiceResponseLength;
  extraInstructions?: string;
  forbiddenActions: string[];
  allowToolUse?: boolean;
  realtime: EffectiveRealtimePolicy;
};

export function resolveDevicePolicy(
  config: VoiceCallConfig,
  params?: { deviceId?: string; from?: string },
): EffectiveDevicePolicy {
  const profile = resolveDeviceProfile(config, params);
  const realtimeConfig = config.streaming?.realtimePolicy;
  const profileRealtime = profile?.realtime;

  return {
    deviceId: profile?.id,
    responseLength: profile?.responseLength,
    extraInstructions: profile?.extraInstructions,
    forbiddenActions: profile?.forbiddenActions ?? [],
    allowToolUse: profile?.allowToolUse,
    realtime: {
      enabled: profileRealtime?.enabled ?? realtimeConfig?.enabled ?? true,
      connectOnStreamStart:
        profileRealtime?.connectOnStreamStart ?? realtimeConfig?.connectOnStreamStart ?? true,
      closeOnStreamDisconnect:
        profileRealtime?.closeOnStreamDisconnect ??
        realtimeConfig?.closeOnStreamDisconnect ??
        true,
      closeAfterAssistantDone:
        profileRealtime?.closeAfterAssistantDone ??
        realtimeConfig?.closeAfterAssistantDone ??
        false,
      idleTimeoutMs: profileRealtime?.idleTimeoutMs ?? realtimeConfig?.idleTimeoutMs ?? 120000,
      maxSessionMs: profileRealtime?.maxSessionMs ?? realtimeConfig?.maxSessionMs ?? 7200000,
      maxReconnectAttempts:
        profileRealtime?.maxReconnectAttempts ?? realtimeConfig?.maxReconnectAttempts ?? 5,
      reconnectBackoffMs:
        profileRealtime?.reconnectBackoffMs ?? realtimeConfig?.reconnectBackoffMs ?? 1000,
      maxConsecutiveNoAudioMs:
        profileRealtime?.maxConsecutiveNoAudioMs ?? realtimeConfig?.maxConsecutiveNoAudioMs,
    },
  };
}

export function buildDevicePolicyPrompt(policy: EffectiveDevicePolicy): string | undefined {
  const parts: string[] = [];

  if (policy.responseLength === "short") {
    parts.push("Keep responses short and concise unless brevity would make the answer unclear.");
  } else if (policy.responseLength === "medium") {
    parts.push("Keep responses moderately concise and avoid rambling.");
  } else if (policy.responseLength === "long") {
    parts.push("Longer explanations are acceptable when helpful, but stay conversational.");
  }

  if (policy.forbiddenActions.length > 0) {
    parts.push(`Never do these actions for this device/context: ${policy.forbiddenActions.join(", ")}.`);
  }

  if (policy.allowToolUse === false) {
    parts.push("Do not use tools unless absolutely required by higher-priority instructions.");
  }

  if (policy.extraInstructions?.trim()) {
    parts.push(policy.extraInstructions.trim());
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Call-context prompt: party framing + talking points
// ---------------------------------------------------------------------------

export type CallContextParams = {
  callParty?: CallParty;
  talkingPoints?: string[];
};

/**
 * Build additional system-prompt text based on who is being called and any
 * talking points the caller supplied.
 *
 * Returns `undefined` when there is nothing to add.
 */
export function buildCallContextPrompt(params: CallContextParams): string | undefined {
  const parts: string[] = [];

  if (params.callParty === "first-party") {
    parts.push(
      "You are speaking directly with the owner/user who initiated this call. " +
        "Be a flexible, permissive assistant — follow their instructions, answer any question, " +
        "and treat them as someone with full authority. No need for formal scripts.",
    );
  } else if (params.callParty === "third-party") {
    parts.push(
      "You are calling a third party on behalf of the user (e.g. a restaurant, business, or contact). " +
        "Stay goal-directed: introduce yourself as calling on behalf of the user, cover the talking points, " +
        "collect the requested information, and wrap up politely. " +
        "Do not volunteer private details about the user beyond what is needed for the call goal.",
    );
  }

  if (params.talkingPoints?.length) {
    parts.push("Talking points to cover during this call:");
    for (const point of params.talkingPoints) {
      parts.push(`  - ${point}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Call-screening prompt: identity & gatekeeper handling
// ---------------------------------------------------------------------------

export type ScreeningContextParams = {
  callerIdentity?: string;
};

/**
 * Build system-prompt text that teaches the AI how to handle call-screening
 * flows (e.g. Google Call Screen, carrier spam filters, voicemail gatekeepers).
 *
 * Returns `undefined` when screening is not configured.
 */
export function buildScreeningContextPrompt(
  params: ScreeningContextParams,
): string | undefined {
  if (!params.callerIdentity) {
    return undefined;
  }
  return (
    "Identity and call screening: When you need to identify yourself — to a call " +
    "screening system, on voicemail, or when asked who is calling — use the identity " +
    "given in your call instructions if one was provided; those always take priority. " +
    `Only if your instructions do not specify an identity, default to: "${params.callerIdentity}". ` +
    "For screening prompts, state the identity clearly and concisely, then wait " +
    "silently for the callee to accept. Once the real person is on the line, deliver " +
    "your message normally and do not repeat the full identification. " +
    "Introduce yourself AT MOST ONCE per call: if you have already greeted or " +
    "identified yourself, never repeat the introduction, even after a pause or " +
    "an automatic reply."
  );
}

function resolveDeviceProfile(config: VoiceCallConfig, params?: { deviceId?: string; from?: string }) {
  const profiles = config.deviceProfiles ?? [];
  if (params?.deviceId) {
    const byId = profiles.find((profile) => profile.id === params.deviceId);
    if (byId) {
      return byId;
    }
  }
  if (params?.from) {
    return profiles.find((profile) => profile.match?.phoneNumbers?.includes(params.from));
  }
  return undefined;
}
