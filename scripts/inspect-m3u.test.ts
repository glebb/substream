import { describe, expect, it, vi } from "vitest";
import { PlaylistSizeLimitError, readPlaylistResponse, safeInspectionError, summarizePlaylist } from "./inspect-m3u-lib.ts";

describe("inspect-m3u safety helpers", () => {
  it("enforces the actual streaming byte limit and cancels an oversized response", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("de"));
      },
      cancel: cancelled,
    });

    await expect(readPlaylistResponse(new Response(stream), 4)).rejects.toBeInstanceOf(PlaylistSizeLimitError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("refuses a declared oversized response before consuming its stream", async () => {
    const getReader = vi.fn();
    const response = {
      headers: new Headers({ "content-length": "10" }),
      body: { getReader },
    } as unknown as Response;

    await expect(readPlaylistResponse(response, 4)).rejects.toBeInstanceOf(PlaylistSizeLimitError);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("omits provider names, URL-like metadata, and raw evidence from summaries", () => {
    const secret = "https://user:pass@private.example/movie/u/p/file.mkv?token=signed-secret";
    const summary = summarizePlaylist(`#EXTM3U\n#EXTINF:-1 group-title="Movies: ${secret}",${secret}\n${secret}\n`);
    const printed = JSON.stringify(summary);

    expect(summary).toMatchObject({ totalEntries: 1, vodCandidates: 1, largestVodGroups: [{ category: "Category 1", entries: 1 }] });
    expect(printed).not.toContain("private.example");
    expect(printed).not.toContain("signed-secret");
    expect(printed).not.toContain("user:pass");
  });

  it("replaces fetch errors containing signed or redirected URLs with a fixed diagnostic", () => {
    const message = safeInspectionError(new TypeError("failed to fetch https://user:pass@private.example/redirect?token=signed-secret"));
    expect(message).toBe("Playlist inspection failed. Check the configured URL and network connection.");
    expect(message).not.toContain("private.example");
    expect(message).not.toContain("signed-secret");
  });
});
