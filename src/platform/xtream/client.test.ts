import { describe, expect, it, vi } from "vitest";
import { XtreamClient } from "./client.ts";

describe("XtreamClient", () => {
  it("detects a get.php playlist and lazily maps a movie category", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ stream_id: 7, name: "FI:Example Movie - 2024", container_extension: "mkv" }] });
    const client = XtreamClient.fromPlaylistUrl("https://iptv.example/get.php?username=user&password=pass&type=m3u_plus", request);
    if (!client) throw new Error("Expected Xtream client");

    const movies = await client.movies("12");

    expect(movies).toMatchObject([{ title: "Example Movie", year: 2024, streamUrl: "https://iptv.example/movie/user/pass/7.mkv" }]);
    expect(request).toHaveBeenCalledWith(expect.stringContaining("player_api.php?"));
    expect(request).toHaveBeenCalledWith(expect.stringContaining("action=get_vod_streams"));
  });

  it("returns null for non-Xtream playlist URLs", () => {
    expect(XtreamClient.fromPlaylistUrl("https://example.test/list.m3u")).toBeNull();
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
