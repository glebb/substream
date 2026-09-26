import { describe, expect, it, vi } from "vitest";
import { XtreamClient } from "./client.ts";

describe("XtreamClient", () => {
  it("loads live categories and streams without exposing credentials in records", async () => {
    const urls: string[] = [];
    const client = XtreamClient.fromPlaylistUrl("https://tv.example/get.php?username=user&password=secret", async (url) => {
      urls.push(url);
      const action = new URL(url).searchParams.get("action");
      return { ok: true, status: 200, json: async () => action === "get_live_categories"
        ? [{ category_id: "7", category_name: "SUOMI" }]
        : [{ stream_id: "42", category_id: "7", name: "Yle TV1 HD", stream_icon: "https://img.example/yle.png", epg_channel_id: "yle1.fi", num: 3 }] };
    });
    expect(await client!.liveCategories()).toEqual([{ id: "7", name: "SUOMI" }]);
    expect(await client!.liveStreams("7")).toEqual([{ streamId: "42", categoryId: "7", name: "Yle TV1 HD", logo: "https://img.example/yle.png", epgId: "yle1.fi", order: 3 }]);
    expect(client!.liveStreamUrl("42")).toBe("https://tv.example/live/user/secret/42.ts");
    expect(JSON.stringify(await client!.liveStreams("7"))).not.toContain("secret");
    expect(urls.every((url) => url.includes("action=get_live_"))).toBe(true);
  });

  it("loads short EPG, normalizes timestamps and decodes provider text", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [
      { title: "Uutiset", start_timestamp: "1790438400", stop_timestamp: 1790440200, description: "VGFya2VtcGkgdGllZG90" },
      { title: "V2VhdGhlcg==", start: "2026-09-26 19:00:00", end: "2026-09-26 19:30:00" },
      { title: "Missing end", start_timestamp: 1790438400 },
      { title: "Reversed", start_timestamp: 1790440200, stop_timestamp: 1790438400 },
    ] });
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=secret", request);
    if (!client) throw new Error("Expected Xtream client");

    await expect(client.shortEpg("42", 5)).resolves.toEqual([
      { channelId: "42", title: "Uutiset", startTime: 1790438400000, endTime: 1790440200000, description: "Tarkempi tiedot" },
      { channelId: "42", title: "Weather", startTime: Date.parse("2026-09-26T19:00:00"), endTime: Date.parse("2026-09-26T19:30:00") },
    ]);
    const requestedUrl = request.mock.calls[0]?.[0];
    if (typeof requestedUrl !== "string") throw new Error("Expected an EPG request URL");
    const requestUrl = new URL(requestedUrl);
    expect(requestUrl.searchParams.get("action")).toBe("get_short_epg");
    expect(requestUrl.searchParams.get("stream_id")).toBe("42");
    expect(requestUrl.searchParams.get("limit")).toBe("5");
  });

  it("accepts the epg_listings response wrapper", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ epg_listings: [
      { title: "Evening news", start_timestamp: 1790438400, stop_timestamp: 1790440200 },
    ] }) });
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass", request);
    if (!client) throw new Error("Expected Xtream client");

    await expect(client.shortEpg("42")).resolves.toEqual([
      { channelId: "42", title: "Evening news", startTime: 1790438400000, endTime: 1790440200000 },
    ]);
  });

  it("validates short EPG arguments and sanitizes request errors", async () => {
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=secret", async () => {
      throw new Error("failed https://iptv.example/player_api.php?username=user&password=secret");
    });
    if (!client) throw new Error("Expected Xtream client");

    await expect(client.shortEpg("42/other")).rejects.toThrow("Invalid provider stream identifier");
    await expect(client.shortEpg("42", 0)).rejects.toThrow("Invalid EPG programme limit");
    await expect(client.shortEpg("42")).rejects.toMatchObject({ message: "Provider request failed" });
    await expect(client.shortEpg("42")).rejects.not.toThrow("secret");
  });
  it("detects a get.php playlist and lazily maps a movie category", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ stream_id: 7, name: "FI:Example Movie - 2024", container_extension: "mkv" }] });
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass&type=m3u_plus", request);
    if (!client) throw new Error("Expected Xtream client");

    const movies = await client.movies("12");

    expect(movies).toMatchObject([{ title: "Example Movie", year: 2024, streamUrl: "https://iptv.example/movie/user/pass/7.mkv" }]);
    expect(request).toHaveBeenCalledWith(expect.stringContaining("player_api.php?"));
    expect(request).toHaveBeenCalledWith(expect.stringContaining("action=get_vod_streams"));
    expect(client.pairingFingerprint()).not.toContain("user");
  });

  it("returns null for non-Xtream playlist URLs", () => {
    expect(XtreamClient.fromPlaylistUrl("https://example.test/list.m3u")).toBeNull();
  });

  it("rebuilds provider stream URLs from safe identifiers and rejects invalid IDs", () => {
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass");
    if (!client) throw new Error("Expected Xtream client");
    expect(client.streamUrlFor("series", "42", "mkv")).toBe("https://iptv.example/series/user/pass/42.mkv");
    expect(() => client.streamUrlFor("movie", "42/other", "mkv")).toThrow("Invalid provider stream identifier");
    expect(client.sourceFingerprint()).toMatch(/^vod_[a-z0-9]+$/);
    expect(client.sourceFingerprint()).toBe(XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=other&password=different")?.sourceFingerprint());
    expect(client.sourceFingerprint()).not.toBe(XtreamClient.fromPlaylistUrl("https://different.example/get.php?username=user&password=pass")?.sourceFingerprint());
    const otherAccount = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=other&password=different");
    const sameAccountDifferentPassword = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=rotated");
    expect(client.pairingFingerprint()).toMatch(/^vod_[a-z0-9]+$/);
    expect(client.pairingFingerprint()).not.toBe(otherAccount?.pairingFingerprint());
    expect(client.pairingFingerprint()).toBe(sameAccountDifferentPassword?.pairingFingerprint());
    expect(client.pairingFingerprint()).not.toContain("user");
  });

  it("loads movie and series categories without downloading streams", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ category_id: "1", category_name: "Nordic" }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ category_id: "2", category_name: "Drama" }] });
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass", request);
    if (!client) throw new Error("Expected Xtream client");

    await expect(client.categories()).resolves.toEqual([
      { id: "1", name: "Nordic", contentType: "movie" },
      { id: "2", name: "Drama", contentType: "series" },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it("normalizes missing years and rejects path syntax in container extensions", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [
    { stream_id: 7, name: "Example Movie", year: " ", container_extension: "mkv?unexpected=1" },
  ] });
  const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass", request);
  expect(client).not.toBeNull();
  await expect(client!.movies("1")).resolves.toMatchObject([
    { year: null, streamUrl: "https://iptv.example/movie/user/pass/7.mp4" },
  ]);
});
