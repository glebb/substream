// The companion service is intentionally plain ESM so it can run with the
// system Node binary during LAN development.
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { loadXtreamCatalogue, resolveXtreamEpisode, searchCatalogue, xtreamConnectionFromPlaylist } from "./companion-service.mjs";

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

  it("loads and searches synthetic provider records while returning safe metadata only", async () => {
    const connection = xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=u&password=p")!;
    const responses: Record<string, unknown> = {
      get_vod_categories: [{ category_id: 1, category_name: "Films" }],
      get_series_categories: [{ category_id: 2, category_name: "Shows" }],
      get_vod_streams: [{ stream_id: 42, name: "The Example (2024)", container_extension: "mkv" }],
      get_series: [{ series_id: 7, name: "Example Show" }],
    };
    const records = await loadXtreamCatalogue(connection, async (url) => {
      const action = new URL(String(url)).searchParams.get("action")!;
      return { ok: true, status: 200, json: async () => responses[action] ?? [] };
    });
    const found = searchCatalogue(records, "example");
    expect(found.map((item) => item.id)).toEqual(["7", "42"]);
    expect(found[1]).toMatchObject({ kind: "movie", title: "The Example", year: 2024, extension: "mkv" });
    expect(JSON.stringify(found)).not.toContain("password");
    expect(JSON.stringify(found)).not.toContain("streamUrl");
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
});
