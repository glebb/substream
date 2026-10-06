import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePersonalRelayEnvironment, personalRelayLanAddress } from "./live-relay-personal-config.ts";
import { discoverPersonalRelayChannels } from "./live-relay-personal.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("automatic personal subtitle relay", () => {
  it("creates private stable settings shared by service and TV build", () => {
    const dir = mkdtempSync(join(tmpdir(), "substream-relay-env-test-")); directories.push(dir);
    const initial = ensurePersonalRelayEnvironment(dir, { LIVE_SUBTITLE_RELAY_URL: "http://192.168.1.20:8790" });
    const repeated = ensurePersonalRelayEnvironment(dir, {});
    expect(repeated).toEqual(initial);
    expect(initial.LIVE_SUBTITLE_RELAY_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.LIVE_SUBTITLE_RELAY_ENABLED).toBe("1");
    expect(statSync(join(dir, ".env.live-relay")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".env.live-relay"), "utf8")).not.toContain("IPTV_M3U_URL");
  });

  it("prefers a physical Mac LAN interface over virtual and loopback addresses", () => {
    const address = (ip: string, internal = false) => ({ address: ip, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: ip + "/24" });
    expect(personalRelayLanAddress({ utun0: [address("10.8.0.2")], en0: [address("192.168.1.20")], lo0: [address("127.0.0.1", true)] })).toBe("192.168.1.20");
    expect(() => personalRelayLanAddress({ lo0: [address("127.0.0.1", true)] })).toThrow("No private LAN");
  });

  it("discovers every marked channel and builds fixed MPEG-TS routes with synthetic credentials", async () => {
    let requests = 0;
    const request: typeof fetch = async (input) => {
      requests++;
      const url = new URL(String(input));
      expect(url.pathname).toBe("/iptv/player_api.php");
      expect(url.searchParams.get("action")).toBe("get_live_streams");
      return new Response(JSON.stringify([
        { stream_id: 123, name: "Sky [Multi-Sub]" },
        { stream_id: "456", name: "Other multi-sub HD" },
        { stream_id: 789, name: "Plain HD" },
        { stream_id: 790, name: "FI: MTV Viihde FHD" },
        { stream_id: 791, name: "FI: Sky Showtime 1 FHD" },
        { stream_id: "../invalid", name: "Multi-Sub" },
        null,
      ]));
    };
    const channels = await discoverPersonalRelayChannels("https://provider.example/iptv/get.php?username=test-user&password=test-pass", request);
    expect(channels).toEqual({
      "stream-123": "https://provider.example/iptv/live/test-user/test-pass/123.ts",
      "stream-456": "https://provider.example/iptv/live/test-user/test-pass/456.ts",
      "stream-790": "https://provider.example/iptv/live/test-user/test-pass/790.ts",
      "stream-791": "https://provider.example/iptv/live/test-user/test-pass/791.ts",
    });
    expect(requests).toBe(1);
  });

  it("fails closed when provider metadata cannot produce an allowlist", async () => {
    await expect(discoverPersonalRelayChannels("https://provider.example/get.php?username=u&password=p", async () => new Response("[]"))).rejects.toThrow("No eligible");
    await expect(discoverPersonalRelayChannels("https://provider.example/get.php?username=u&password=p", async () => new Response("{}"))).rejects.toThrow("Invalid provider");
  });
});
