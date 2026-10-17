import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";

// OpenClaw validates plugin config against openclaw.plugin.json (additionalProperties: false)
// before the plugin's own zod schema runs. A key zod accepts but the JSON schema doesn't
// makes the whole gateway refuse to start (2026-10-16 deploy).
describe("openclaw.plugin.json config schema", () => {
  const json = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const zodShape = (VoiceCallConfigSchema as unknown as { shape: Record<string, unknown> }).shape;

  it("declares every top-level config key the plugin accepts", () => {
    const declared = Object.keys(json.configSchema.properties);
    const missing = Object.keys(zodShape).filter((k) => !declared.includes(k));
    expect(missing).toEqual([]);
  });

  it("declares every streaming key", () => {
    const declared = Object.keys(json.configSchema.properties.streaming.properties);
    const streaming = zodShape.streaming as { _def?: { innerType?: { shape?: Record<string, unknown> } }; shape?: Record<string, unknown> };
    let inner: any = streaming;
    while (inner && !inner.shape && (inner._def?.innerType || inner._def?.in)) inner = inner._def.innerType ?? inner._def.in;
    const keys = Object.keys(inner?.shape ?? {});
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !declared.includes(k))).toEqual([]);
  });
});
