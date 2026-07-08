/**
 * Direct Home Assistant backend for in-call home status and control.
 *
 * Talks to a Home Assistant instance over its REST API so the voice AI can
 * answer "are the doors locked?" and (when allowControl is on) act on
 * "turn off the porch light" in ~1-2 seconds — bypassing the slower
 * agent-bridge path for the common home cases.
 *
 * Security: the check_home / control_home tools that use this are offered
 * ONLY on calls verified as the owner or a trusted contact (see
 * resolveCallParty); third-party and unverified callers never receive them.
 * Control is additionally gated behind allowControl (off by default). The
 * token lives only in config/env and is never placed in the model prompt.
 */

export type HomeAssistantConfig = {
  baseUrl: string;
  token: string;
  /** Entity domains the tools may read and control. */
  exposeDomains: string[];
  /** Whether control_home (service calls) is permitted at all. */
  allowControl: boolean;
  timeoutMs: number;
  /** Max entities returned by a status query. */
  maxResults: number;
};

type HaState = {
  entity_id: string;
  state: string;
  attributes?: { friendly_name?: string };
};

/** Spoken command → Home Assistant service, by entity domain. */
const COMMAND_SERVICES: Record<string, Record<string, string>> = {
  on: { light: "turn_on", switch: "turn_on", fan: "turn_on", climate: "turn_on" },
  off: { light: "turn_off", switch: "turn_off", fan: "turn_off", climate: "turn_off" },
  toggle: { light: "toggle", switch: "toggle", fan: "toggle" },
  lock: { lock: "lock" },
  unlock: { lock: "unlock" },
  open: { cover: "open_cover" },
  close: { cover: "close_cover" },
};

export const HA_COMMANDS = Object.keys(COMMAND_SERVICES);

async function haFetch(
  config: HomeAssistantConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Home Assistant returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function domainOf(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}

function label(s: HaState): string {
  const name = s.attributes?.friendly_name || s.entity_id;
  return `${name} (${s.entity_id}): ${s.state}`;
}

/**
 * Read entity states, restricted to exposeDomains and optionally filtered by
 * a query substring against entity id / friendly name. Returns a compact,
 * human-readable summary safe to speak.
 */
export async function queryHomeStates(
  config: HomeAssistantConfig,
  query?: string,
): Promise<string> {
  const all = (await haFetch(config, "/api/states")) as HaState[];
  const q = (query ?? "").toLowerCase().trim();
  const matches = all
    .filter((s) => config.exposeDomains.includes(domainOf(s.entity_id)))
    .filter((s) => {
      if (!q) return true;
      const hay = `${s.entity_id} ${s.attributes?.friendly_name ?? ""}`.toLowerCase();
      return q.split(/\s+/).some((term) => hay.includes(term));
    });

  if (matches.length === 0) {
    return q ? `No matching devices found for "${query}".` : "No exposed devices found.";
  }
  const shown = matches.slice(0, config.maxResults);
  const lines = shown.map((s) => `- ${label(s)}`);
  if (matches.length > shown.length) {
    lines.push(`…and ${matches.length - shown.length} more (narrow your query).`);
  }
  return lines.join("\n");
}

export type HomeControlResult = { ok: boolean; message: string };

/**
 * Perform a bounded control action on a single entity. Only the mapped
 * command set is allowed (no arbitrary service calls), and only for entities
 * in exposeDomains. Returns a short confirmation with the resulting state.
 */
export async function controlHomeEntity(
  config: HomeAssistantConfig,
  entityId: string,
  command: string,
): Promise<HomeControlResult> {
  if (!config.allowControl) {
    return { ok: false, message: "Home control is disabled." };
  }
  const domain = domainOf(entityId);
  if (!config.exposeDomains.includes(domain)) {
    return { ok: false, message: `Entity domain "${domain}" is not permitted.` };
  }
  const service = COMMAND_SERVICES[command.toLowerCase()]?.[domain];
  if (!service) {
    return {
      ok: false,
      message: `Command "${command}" is not valid for ${domain}. Valid: ${HA_COMMANDS.join(", ")}.`,
    };
  }
  await haFetch(config, `/api/services/${domain}/${service}`, {
    method: "POST",
    body: { entity_id: entityId },
  });
  // Read back the resulting state for confirmation.
  try {
    const after = (await haFetch(config, `/api/states/${entityId}`)) as HaState;
    return { ok: true, message: `${label(after)}` };
  } catch {
    return { ok: true, message: `${entityId}: ${command} sent.` };
  }
}
