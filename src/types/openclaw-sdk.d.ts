// openclaw 2026.10.x ships these plugin-sdk runtime modules without .d.ts
// files. The gateway provides them at runtime; these declarations cover only
// what this plugin imports.
declare module "openclaw/plugin-sdk/tts-runtime" {
  import type { z } from "zod";
  export const TtsAutoSchema: z.ZodType<"off" | "always" | "inbound" | "tagged">;
  export const TtsModeSchema: z.ZodType<"final" | "all">;
  export const TtsProviderSchema: z.ZodType<string>;
  export const TtsConfigSchema: z.ZodType<
    | {
        auto?: "off" | "always" | "inbound" | "tagged";
        enabled?: boolean;
        mode?: "final" | "all";
        provider?: string;
        providers?: Record<string, Record<string, unknown> | undefined>;
        [key: string]: unknown;
      }
    | undefined
  >;
}

declare module "openclaw/plugin-sdk/text-utility-runtime" {
  export function sleep(ms: number): Promise<void>;
}
