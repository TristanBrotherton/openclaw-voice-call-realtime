/**
 * Owner test call: a lab instance of this branch (real Twilio, GPT-Live) calls
 * the owner's phone (the live entry's toNumber). Use ONLY after the owner has
 * confirmed the call. No number routing change: the call's webhooks go to the
 * lab instance's own quick tunnel. Owner tools are on (voiceBridge), so an
 * explain question runs through the Voice PE bridge with the callback.
 *
 *   npx tsx lab/t2/call-owner.ts --confirmed [--runtime live] [--voice vesper] [--message "..."]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalStates } from "../../src/types.js";
import { ConsoleCapture, freePort, readLiveEntry, readOpenAiKey, STATE_DIR } from "../harness/boot.ts";
import { bootReal, readLiveTwilio } from "./boot-real.ts";
import { startTunnel, waitServes } from "./tunnel.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
if (!args.includes("--confirmed")) {
  console.error("Refusing: pass --confirmed only after the owner agreed to this test call.");
  process.exit(2);
}
const runtime = flag("runtime", "live");
const voice = flag("voice", "vesper");
const message = flag(
  "message",
  "Test call of the new voice setup on GPT-Live. Say it's a quick test and ask what they'd like to try — for example an explanation of how one of their projects works.",
);
const waitAfterMs = Number(flag("wait-after-s", "600")) * 1000;

const live = readLiveEntry();
const owner: string | undefined = live?.toNumber;
if (!owner) throw new Error("no owner number (toNumber) in the live entry");
const tw = readLiveTwilio();
const runDir = path.join(STATE_DIR, "owner-calls", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(runDir, { recursive: true });

const capture = new ConsoleCapture(true, [readOpenAiKey(), tw.authToken]);
capture.install();
const port = await freePort();
const tunnel = await startTunnel({ port, label: "owner-call" });
// Help the voice recognise the owner's project names ("dev system" was heard as "dead system").
const projectNames = (() => {
  try {
    const out = execFileSync(path.join(os.homedir(), ".openclaw/workspace/bin/claude-project"), ["list"], { encoding: "utf8", timeout: 15000 });
    return [...out.matchAll(/^"([^"]+)"/gm)].map((m) => m[1]).join(", ");
  } catch {
    return "";
  }
})();
const persona =
  (live?.streaming?.realtimeSystemPrompt ?? "") +
  (projectNames ? `\nThe owner's projects (names you may hear on calls): ${projectNames}.` : "");
const t0 = Date.now();
const rt = await bootReal({
  runtime,
  model: "gpt-realtime-2.1",
  voice,
  profile: "live",
  persona,
  storeDir: path.join(runDir, "store"),
  apiKey: readOpenAiKey(),
  port,
  publicBase: tunnel.url,
  twilio: tw,
  maxDurationSeconds: 900,
  allowDestination: owner,
  extraConfig: {
    voiceBridge: {
      enabled: true,
      url: "http://127.0.0.1:3338",
      askPathFile: path.join(os.homedir(), "development/voice-pe/voice-pe-bridge/.ask-path"),
    },
  },
});
let exitCode = 0;
try {
  // This Mac's resolver may cache "no such host" for a fresh quick-tunnel name;
  // Twilio resolves it itself. Probe, but don't block the call on it.
  await waitServes(`${tunnel.url}/voice/hold-music`, 45000, "owner-call").catch((err) => {
    console.warn(`[owner-call] local probe failed (${err instanceof Error ? err.message : String(err)}); dialling anyway`);
  });
  const res = await rt.runtime.manager.initiateCall(owner, undefined, {
    message,
    callParty: "first-party",
    mode: "conversation",
  });
  if (!res.success) throw new Error(`initiateCall failed: ${res.error}`);
  console.log(`[owner-call] calling the owner (call ${res.callId})`);
  const deadline = Date.now() + 16 * 60_000;
  for (;;) {
    const c = rt.runtime.manager.getCall(res.callId);
    if (!c || TerminalStates.has(c.state) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`[owner-call] call ended; waiting up to ${waitAfterMs / 1000}s for late results`);
  const until = Date.now() + waitAfterMs;
  while (Date.now() < until) {
    const pending = (rt.runtime.webhookServer as unknown as { bridgeTasks: Map<string, unknown> }).bridgeTasks;
    if (!pending || pending.size === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await new Promise((r) => setTimeout(r, 8000)); // let finalize write the transcript
  const t = await rt.runtime.manager.getTranscript(res.callId);
  fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(t, null, 2));
  console.log(`[owner-call] transcript: ${t?.transcriptPath ?? "(none)"}; recording: ${t?.recordingPath ?? "(none)"}`);
} catch (err) {
  console.error("[owner-call] failed:", err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  capture.write(path.join(runDir, "plugin.log"), t0);
  capture.restore();
  await rt.stop().catch(() => {});
  await tunnel.stop().catch(() => {});
  console.log(`[owner-call] run dir: ${runDir}`);
  process.exit(exitCode);
}
