import { describe, expect, it } from "vitest";
import { classifyM3uEntry, IncrementalM3uParser, parseM3u, redactUrl } from "./index.ts";

describe("parseM3u", () => {
  it("parses extended attributes, commas in quoted values, and IPTV options", () => {
    const playlist = parseM3u(`#EXTM3U x-tvg-url="https://epg.example/guide.xml"
#EXTINF:-1 tvg-id="film-1" tvg-name="Film, The" group-title="VOD | Movies",Film, The (2024)
#EXTVLCOPT:http-user-agent=Example Player
https://iptv.example/movie/alice/secret/42.mkv
`);

    expect(playlist.entries).toHaveLength(1);
    expect(playlist.header["x-tvg-url"]).toBe("https://epg.example/guide.xml");
    expect(playlist.entries[0]).toMatchObject({
      name: "Film, The (2024)",
      duration: -1,
      attributes: { "tvg-id": "film-1", "tvg-name": "Film, The", "group-title": "VOD | Movies" },
      options: { "http-user-agent": "Example Player" },
    });
  });

  it("preserves URL-only entries and reports incomplete metadata", () => {
    const playlist = parseM3u(`#EXTM3U
https://example.test/video/standalone.mp4
#EXTINF:-1,Missing URL
`);

    expect(playlist.entries[0]?.name).toBe("standalone.mp4");
    expect(playlist.warnings).toEqual([{ line: 3, message: "Entry metadata has no media URL" }]);
  });

  it("emits entries when lines are split across arbitrary chunks", () => {
    const parser = new IncrementalM3uParser();
    const entries = [
      ...parser.push("#EXTM3U\n#EXTINF:-1 group-title=\"Movies: Finland\",Example"),
      ...parser.push(" Movie\nhttps://iptv.example/movie/user/pass/1.mkv\n"),
      ...parser.finish(),
    ];

    expect(entries).toMatchObject([{ name: "Example Movie", attributes: { "group-title": "Movies: Finland" } }]);
    expect(parser.warnings).toEqual([]);
  });
});

describe("classifyM3uEntry", () => {
  it("classifies common Xtream movie URLs as VOD", () => {
    const entry = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="English Movies",Example Movie
https://iptv.example/movie/alice/secret/42.mkv
`).entries[0];

    expect(entry && classifyM3uEntry(entry)).toMatchObject({ kind: "vod", confidence: "high" });
  });

  it("keeps ambiguous transport streams rather than discarding them", () => {
    const entry = parseM3u(`#EXTM3U
#EXTINF:-1,Channel or movie
https://iptv.example/12345
`).entries[0];

    expect(entry && classifyM3uEntry(entry)).toMatchObject({ kind: "unknown" });
  });

  it("does not mistake a Movies Club live-channel group for a VOD catalogue", () => {
    const entry = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="Sweden - Movies Club",SE: Film Channel FHD
https://iptv.example/live/alice/secret/42.ts
`).entries[0];

    expect(entry && classifyM3uEntry(entry)).toMatchObject({ kind: "live", confidence: "high" });
  });

  it("does not treat a generic transport-stream extension as VOD evidence", () => {
    const entry = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="Sweden - Movies Club",SE: Film Channel FHD
https://iptv.example/channel/42.ts
`).entries[0];

    expect(entry && classifyM3uEntry(entry)).toMatchObject({ kind: "live", confidence: "high" });
  });
});

describe("redactUrl", () => {
  it("redacts query, userinfo, and Xtream-style path credentials", () => {
    expect(redactUrl("https://bob:secret@iptv.example/movie/alice/password/42.mkv?token=abc&safe=yes"))
      .toBe("https://REDACTED:REDACTED@iptv.example/movie/REDACTED/REDACTED/42.mkv?token=REDACTED&safe=yes");
  });
});
