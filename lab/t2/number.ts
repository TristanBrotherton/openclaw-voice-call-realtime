/**
 * T2 (real phone) number routing.
 *
 * We have one Twilio number. For a real-network test the plugin under test
 * (a lab instance on this branch) calls that same number; the incoming leg
 * must reach the lab's party instead of the live plugin. For the length of a
 * run the number's voice URL points at the lab front door, which
 *   - answers registered lab calls (From = our own number) with the party, and
 *   - redirects every other call to the live webhook (so a real caller still
 *     reaches the live assistant),
 * with the live webhook as Twilio's fallback URL in case the lab is down.
 * The original routing is saved to the state dir first and restored after the
 * run; `restore` puts it back if a run died.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../harness/boot.js";

const SAVED = path.join(STATE_DIR, "t2-number-routing.json");

export type TwilioCreds = { accountSid: string; authToken: string };

export type NumberRouting = {
  sid: string;
  phoneNumber: string;
  voiceUrl: string;
  voiceMethod: string;
  voiceFallbackUrl: string;
  voiceFallbackMethod: string;
};

function auth(c: TwilioCreds): string {
  return "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
}

async function twilio(c: TwilioCreds, method: "GET" | "POST", url: string, form?: Record<string, string>) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth(c),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  if (!res.ok) {
    throw new Error(`Twilio ${method} ${new URL(url).pathname} -> ${res.status}`);
  }
  return (await res.json()) as Record<string, any>;
}

export async function getRouting(c: TwilioCreds, phoneNumber: string): Promise<NumberRouting> {
  const list = await twilio(
    c,
    "GET",
    `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
  );
  const n = list.incoming_phone_numbers?.[0];
  if (!n) {
    throw new Error("number not found on the account");
  }
  return {
    sid: n.sid,
    phoneNumber: n.phone_number,
    voiceUrl: n.voice_url ?? "",
    voiceMethod: n.voice_method ?? "POST",
    voiceFallbackUrl: n.voice_fallback_url ?? "",
    voiceFallbackMethod: n.voice_fallback_method ?? "POST",
  };
}

async function setRouting(c: TwilioCreds, r: NumberRouting): Promise<void> {
  await twilio(c, "POST", `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/IncomingPhoneNumbers/${r.sid}.json`, {
    VoiceUrl: r.voiceUrl,
    VoiceMethod: r.voiceMethod,
    VoiceFallbackUrl: r.voiceFallbackUrl,
    VoiceFallbackMethod: r.voiceFallbackMethod,
  });
}

/** Point the number at the lab front door; returns the saved original routing. */
export async function routeToLab(c: TwilioCreds, phoneNumber: string, frontDoorUrl: string): Promise<NumberRouting> {
  if (fs.existsSync(SAVED)) {
    // A previous run did not restore: never save the lab URL as "original".
    await restoreRouting(c);
  }
  const original = await getRouting(c, phoneNumber);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SAVED, JSON.stringify(original, null, 2));
  await setRouting(c, {
    ...original,
    voiceUrl: frontDoorUrl,
    voiceMethod: "POST",
    voiceFallbackUrl: original.voiceUrl, // live webhook if the lab is unreachable
    voiceFallbackMethod: original.voiceMethod,
  });
  return original;
}

/** Restore the routing saved by routeToLab (no-op when nothing is saved). */
export async function restoreRouting(c: TwilioCreds): Promise<boolean> {
  if (!fs.existsSync(SAVED)) {
    return false;
  }
  const original = JSON.parse(fs.readFileSync(SAVED, "utf8")) as NumberRouting;
  await setRouting(c, original);
  fs.unlinkSync(SAVED);
  return true;
}
