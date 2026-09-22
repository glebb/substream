// The companion service is intentionally plain ESM so it can run with the
// system Node binary during LAN development.
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { loadXtreamCatalogue, searchCatalogue, xtreamConnectionFromPlaylist } from "./companion-service.mjs";

describe("LAN companion provider service", () => {
  it("accepts Xtream URLs without exposing credentials in the connection fingerprint", () => {
    const connection = xtreamConnectionFromPlaylist("https://iptv.example/get.php?username=alice&password=secret");
    expect(connection?.apiUrl.toString()).toBe("https://iptv.example/player_api.php");
    expect(connection?.sourceFingerprint).toMatch(/^vod_/);
    expect(connection?.sourceFingerprint).not.toContain("alice");
    expect(connection?.sourceFingerprint).not.toContain("secret");
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
});
