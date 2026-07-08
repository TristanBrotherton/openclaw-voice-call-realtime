import { afterEach, describe, expect, it, vi } from "vitest";
import { controlHomeEntity, queryHomeStates, HA_COMMANDS } from "./home-assistant.js";

const cfg = {
  baseUrl: "https://ha.example.com:8123",
  token: "test-token",
  exposeDomains: ["lock", "light", "cover"],
  allowControl: true,
  maxResults: 40,
  timeoutMs: 5000,
};

const mockFetch = (handler: (url: string, init?: RequestInit) => unknown) => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
};

afterEach(() => vi.unstubAllGlobals());

const STATES = [
  { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front Door" } },
  { entity_id: "lock.garage", state: "unlocked", attributes: { friendly_name: "Garage" } },
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen Light" } },
  { entity_id: "sensor.temp", state: "21", attributes: { friendly_name: "Temp" } }, // not exposed
];

describe("queryHomeStates", () => {
  it("returns only exposed domains and formats readably", async () => {
    mockFetch(() => STATES);
    const out = await queryHomeStates(cfg);
    expect(out).toContain("Front Door (lock.front_door): locked");
    expect(out).toContain("Garage (lock.garage): unlocked");
    expect(out).not.toContain("sensor.temp"); // domain not exposed
  });

  it("filters by query substring", async () => {
    mockFetch(() => STATES);
    const out = await queryHomeStates(cfg, "garage");
    expect(out).toContain("Garage");
    expect(out).not.toContain("Front Door");
  });

  it("reports no matches", async () => {
    mockFetch(() => STATES);
    expect(await queryHomeStates(cfg, "spaceship")).toContain("No matching devices");
  });
});

describe("controlHomeEntity", () => {
  it("maps command to the correct service and confirms new state", async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/states/lock.front_door")) {
        return { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front Door" } };
      }
      return {};
    });
    const r = await controlHomeEntity(cfg, "lock.front_door", "lock");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("locked");
    expect(calls.some((c) => c.includes("POST") && c.includes("/api/services/lock/lock"))).toBe(true);
  });

  it("rejects domains not in exposeDomains", async () => {
    mockFetch(() => ({}));
    const r = await controlHomeEntity(cfg, "vacuum.roomba", "on");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not permitted");
  });

  it("rejects invalid command for the domain", async () => {
    mockFetch(() => ({}));
    const r = await controlHomeEntity(cfg, "lock.front_door", "on"); // 'on' invalid for lock
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not valid");
  });

  it("refuses entirely when allowControl is off", async () => {
    mockFetch(() => ({}));
    const r = await controlHomeEntity({ ...cfg, allowControl: false }, "lock.front_door", "lock");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("disabled");
  });

  it("exposes the expected command set", () => {
    expect(HA_COMMANDS).toEqual(
      expect.arrayContaining(["on", "off", "toggle", "lock", "unlock", "open", "close"]),
    );
  });
});

import { resolveCallParty } from "./assistant-bridge.js";

describe("home/action gating: verified tiers require strong signals, not labels", () => {
  const owner = "+15550001111";
  const trusted = "+15550002222";
  const stranger = "+15559998888";

  it("outbound to the owner's own number is first-party (no label needed)", () => {
    expect(
      resolveCallParty({ direction: "outbound", to: owner, ownerNumbers: [owner], trustedNumbers: [] }),
    ).toBe("first-party");
  });

  it("outbound to a stranger is NEVER promoted to first-party by a mislabel", () => {
    // The agent wrongly tags a third-party call as first-party — must not unlock owner tier.
    expect(
      resolveCallParty({
        direction: "outbound",
        to: stranger,
        callParty: "first-party",
        ownerNumbers: [owner],
        trustedNumbers: [trusted],
      }),
    ).toBe("unverified");
  });

  it("inbound from a stranger is unverified even with a first-party label", () => {
    expect(
      resolveCallParty({
        direction: "inbound",
        from: stranger,
        callParty: "first-party",
        ownerNumbers: [owner],
        trustedNumbers: [],
        stirVerstat: "TN-Validation-Passed-A",
      }),
    ).toBe("unverified");
  });

  it("inbound from the owner's number needs attestation to be first-party", () => {
    const base = { direction: "inbound", from: owner, ownerNumbers: [owner], trustedNumbers: [] };
    expect(resolveCallParty(base)).toBe("unverified"); // spoofable, no attestation
    expect(resolveCallParty({ ...base, stirVerstat: "TN-Validation-Passed-A" })).toBe("first-party");
  });

  it("outbound to a trusted number is trusted-contact", () => {
    expect(
      resolveCallParty({ direction: "outbound", to: trusted, ownerNumbers: [owner], trustedNumbers: [trusted] }),
    ).toBe("trusted-contact");
  });
});
