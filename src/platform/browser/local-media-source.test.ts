import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLocalFilename, LocalMediaSource, localDisplayTitle, localSubtitleQuery } from "./local-media-source.ts";

describe("local media source", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the object URL through effect replay and revokes it after the last retained player releases", async () => {
    vi.useFakeTimers();
    const file = new File([new Uint8Array([1, 2, 3])], "Example.mp4", { type: "video/mp4" });
    const urls = { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL: vi.fn() };
    const source = new LocalMediaSource(file, urls);
    const firstRelease = source.retain();
    firstRelease();
    const strictReplayRelease = source.retain();
    await vi.runOnlyPendingTimersAsync();
    expect(source.file).toBe(file);
    expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    strictReplayRelease();
    await vi.runOnlyPendingTimersAsync();
    expect(source.file).toBeNull();
    expect(source.url).toBeNull();
    expect(urls.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("normalizes the display/search name and preserves uncertain filename classification", () => {
    expect(localDisplayTitle("  The.Show_S01E02.mkv")).toBe("The Show S01E02");
    expect(localSubtitleQuery("Movie (2024).mp4")).toBe("Movie 2024");
    expect(classifyLocalFilename("The.Show.S02E03.mkv")).toMatchObject({ contentType: "series", season: 2, episode: 3, evidence: [expect.stringContaining("explicit")] });
    expect(classifyLocalFilename("Example.Feature.Film.mp4")).toMatchObject({ contentType: "other", evidence: [expect.stringContaining("does not establish")] });
  });

  it("cleans a release filename into an exact series and episode search target", () => {
    const filename = "Cape.Fear.S01E10.1080p.HEVC.x265-MeGusta[EZTVx.to].mkv";
    expect(localSubtitleQuery(filename)).toBe("Cape Fear");
    expect(classifyLocalFilename(filename)).toMatchObject({ contentType: "series", season: 1, episode: 10 });
    expect(localSubtitleQuery("Cape.Fear.1x10.1080p.WEB-DL.mkv")).toBe("Cape Fear");
    expect(classifyLocalFilename("Cape.Fear.1x10.1080p.WEB-DL.mkv")).toMatchObject({ contentType: "series", season: 1, episode: 10 });
  });
});
