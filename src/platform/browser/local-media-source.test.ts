import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLocalFilename, guessLocalContainer, LocalMediaSource, localDisplayTitle, localSubtitleQuery, probeLocalContainer } from "./local-media-source.ts";

function ebmlHeader(docType: string): Uint8Array<ArrayBuffer> {
  const doc = [...docType].map((character) => character.charCodeAt(0));
  // EBML magic, header size, EBMLVersion (0x4286 = 1), then DocType (0x4282).
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | doc.length, ...doc, 0x18, 0x53, 0x80, 0x67]);
}

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

  it("detects Matroska and WebM from the EBML header regardless of the filename", async () => {
    expect(await probeLocalContainer(new File([ebmlHeader("matroska")], "renamed.mp4"))).toBe("matroska");
    expect(await probeLocalContainer(new File([ebmlHeader("webm")], "clip.mkv"))).toBe("webm");
    expect(await probeLocalContainer(new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], "movie.mkv"))).toBe("other");
    const unreadable = { name: "movie.mkv", type: "", slice: () => ({ arrayBuffer: () => Promise.reject(new Error("unreadable")) }) } as unknown as File;
    expect(await probeLocalContainer(unreadable)).toBe("matroska");
    expect(guessLocalContainer({ name: "clip.WEBM" })).toBe("webm");
    expect(guessLocalContainer({ name: "movie.mp4", type: "video/mp4" })).toBe("other");
  });

  it("starts from a filename guess and updates the container after the header probe", async () => {
    const file = new File([ebmlHeader("matroska")], "Example.bin");
    const source = new LocalMediaSource(file, { createObjectURL: () => "blob:synthetic", revokeObjectURL: vi.fn() });
    expect(source.container).toBe("other");
    await vi.waitFor(() => expect(source.container).toBe("matroska"));
    source.dispose();
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
