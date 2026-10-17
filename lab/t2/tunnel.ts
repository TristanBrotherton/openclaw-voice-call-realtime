/**
 * Cloudflare quick tunnel for T2: `cloudflared tunnel --url http://127.0.0.1:PORT`.
 * Parses the https://*.trycloudflare.com URL from cloudflared's output and
 * waits until a probe path answers through the tunnel. Stopped on exit.
 *
 * A config file of our own is passed with --config: otherwise cloudflared
 * picks up ~/.cloudflared/config.yml (a named tunnel's credentials and
 * ingress) and the quick tunnel answers 404 for everything.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../harness/boot.ts";

export const CLOUDFLARED = process.env.CLOUDFLARED || "/opt/homebrew/bin/cloudflared";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type Tunnel = { url: string; port: number; stop: () => Promise<void> };

const live = new Set<ChildProcess>();
process.on("exit", () => {
  for (const p of live) p.kill("SIGTERM");
});

/** First trycloudflare URL in a chunk of cloudflared output (or null). */
export function parseTunnelUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

export async function startTunnel(params: {
  port: number;
  /** Path that must answer 2xx through the tunnel before it counts as up (omit: URL only). */
  probePath?: string;
  label: string;
  timeoutMs?: number;
}): Promise<Tunnel> {
  const timeoutMs = params.timeoutMs ?? 90000;
  const cfg = path.join(STATE_DIR, "t2-quick-tunnel.yml");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(cfg, "no-autoupdate: true\n");
  const child = spawn(CLOUDFLARED, ["tunnel", "--config", cfg, "--url", `http://127.0.0.1:${params.port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      live.delete(child);
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.kill("SIGTERM");
    });
    live.delete(child);
  };

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`tunnel ${params.label}: no URL after ${timeoutMs} ms`)), timeoutMs);
      const onData = (d: Buffer) => {
        buf += d.toString();
        const u = parseTunnelUrl(buf);
        if (u) {
          clearTimeout(timer);
          resolve(u);
        }
        if (buf.length > 65536) buf = buf.slice(-4096);
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`tunnel ${params.label}: cloudflared exited (${code})`));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if (params.probePath !== undefined) await waitServes(url + params.probePath, timeoutMs, params.label);
    return { url, port: params.port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Poll until GET url answers 2xx (new quick-tunnel hostnames take a few seconds to resolve). */
export async function waitServes(url: string, timeoutMs: number, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      // macOS caches a negative answer for a quick-tunnel name probed before it
      // existed; Twilio resolves it itself, so check through public DNS instead.
      if (await servesViaPublicDns(url)) return;
      last = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tunnel ${label}: ${new URL(url).pathname} not serving after ${timeoutMs} ms (${last})`);
}

/** GET url resolving its host through 1.1.1.1 (bypasses the local negative DNS cache). */
async function servesViaPublicDns(url: string): Promise<boolean> {
  try {
    const { Resolver } = await import("node:dns/promises");
    const { execFileSync } = await import("node:child_process");
    const resolver = new Resolver();
    resolver.setServers(["1.1.1.1"]);
    const u = new URL(url);
    const [ip] = await resolver.resolve4(u.hostname);
    if (!ip) return false;
    const code = execFileSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "--resolve", `${u.hostname}:443:${ip}`, url],
      { encoding: "utf8" },
    ).trim();
    return code.startsWith("2");
  } catch {
    return false;
  }
}
