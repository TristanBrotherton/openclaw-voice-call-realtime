import type { WebhookContext } from "../../types.js";

export type TwimlResponseKind = "empty" | "pause" | "queue" | "stored" | "stream" | "reject";

export type TwimlRequestView = {
  callStatus: string | null;
  direction: string | null;
  isStatusCallback: boolean;
  callSid?: string;
  callIdFromQuery?: string;
  from?: string;
  stirVerstat?: string;
};

export type TwimlPolicyInput = TwimlRequestView & {
  hasStoredTwiml: boolean;
  isNotifyCall: boolean;
  hasActiveStreams: boolean;
  canStream: boolean;
  /** When false, inbound calls are rejected pre-answer (no stream, no AI). */
  acceptInbound?: boolean;
};

export type TwimlDecision =
  | {
      kind: "empty" | "pause" | "queue" | "reject";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stored";
      consumeStoredTwimlCallId: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stream";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    };

function isOutboundDirection(direction: string | null): boolean {
  return direction?.startsWith("outbound") ?? false;
}

export function readTwimlRequestView(ctx: WebhookContext): TwimlRequestView {
  const params = new URLSearchParams(ctx.rawBody);
  const type = typeof ctx.query?.type === "string" ? ctx.query.type.trim() : undefined;
  const callIdFromQuery =
    typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
      ? ctx.query.callId.trim()
      : undefined;

  return {
    callStatus: params.get("CallStatus"),
    direction: params.get("Direction"),
    isStatusCallback: type === "status" || type === "amd",
    callSid: params.get("CallSid") || undefined,
    callIdFromQuery,
    from: params.get("From") || undefined,
    stirVerstat: params.get("StirVerstat") || undefined,
  };
}

export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      return { kind: "stored", consumeStoredTwimlCallId: input.callIdFromQuery };
    }
    if (input.isNotifyCall) {
      return { kind: "empty" };
    }

    if (isOutboundDirection(input.direction)) {
      return input.canStream ? { kind: "stream" } : { kind: "pause" };
    }
  }

  if (input.isStatusCallback) {
    return { kind: "empty" };
  }

  if (input.direction === "inbound") {
    if (input.acceptInbound === false) {
      return { kind: "reject" };
    }
    if (input.hasActiveStreams) {
      return { kind: "queue" };
    }
    if (input.canStream && input.callSid) {
      return { kind: "stream", activateStreamCallSid: input.callSid };
    }
    return { kind: "pause" };
  }

  if (input.callStatus !== "in-progress") {
    return { kind: "empty" };
  }

  return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
