// The companion service is intentionally plain ESM so it can run with the
// system Node binary during LAN development.
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { resolveXtreamEpisode, xtreamConnectionFromPlaylist } from "./companion-service.mjs";

describe("LAN companion provider service", () => {
  it("accepts Xtream URLs without exposing credentials in the connection fingerprint", () => {
    const connection = xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=alice&password=secret");
    expect(connection?.apiUrl.toString()).toBe("https://iptv.example/player_api.php");
    expect(connection?.sourceFingerprint).toMatch(/^vod_/);
    expect(connection?.sourceFingerprint).not.toContain("alice");
    expect(connection?.sourceFingerprint).not.toContain("secret");
    expect(connection?.sourceFingerprint).not.toBe(xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=bob&password=other")?.sourceFingerprint);
    expect(connection?.sourceFingerprint).toBe(xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=alice&password=rotated")?.sourceFingerprint);
    expect(xtreamConnectionFromPlaylist("https://iptv.example/list.m3u")).toBeNull();
  });

  it("resolves an episode against its series and returns safe metadata only", async () => {
    const connection = xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=u&password=p")!;
    let currentSeries = "7";
    const request = async (url: URL) => {
      expect(url.searchParams.get("action")).toBe("get_series_info");
      expect(url.searchParams.get("series_id")).toBe(currentSeries);
      return { ok: true, status: 200, json: async () => ({ episodes: url.searchParams.get("series_id") === "7" ? { "1": [
        { id: 101, title: "Example Show S01E01", container_extension: "mkv" },
      ] } : {} }) };
    };
    await expect(resolveXtreamEpisode(connection, "7", "101", request)).resolves.toMatchObject({
      id: "101", kind: "episode", title: "Example Show S01E01", extension: "mkv", sourceFingerprint: connection.sourceFingerprint,
    });
    currentSeries = "8";
    await expect(resolveXtreamEpisode(connection, "8", "101", request)).resolves.toBeNull();
    currentSeries = "7";
    expect(JSON.stringify(await resolveXtreamEpisode(connection, "7", "101", request))).not.toContain("password");
  });

  it("aborts hanging episode provider calls on their deadlines", async () => {
    const connection = xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=u&password=p")!;
    const hangingRequest = (_url: URL, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    await expect(resolveXtreamEpisode(connection, "7", "101", hangingRequest, { timeoutMs: 10 })).rejects.toThrow();
  });
});
