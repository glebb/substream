import { describe, expect, it, vi } from "vitest";
import { VodSubtitleController } from "./vod-subtitle-controller.ts";
import type { VodEmbeddedSubtitleCandidate } from "../core/subtitles/vod-selection.ts";

describe("VodSubtitleController", () => {
  it("allows sequential OpenSubtitles requests more than eight seconds before embedded fallback", async () => {
    vi.useFakeTimers();
    try {
      const discoverEmbedded = vi.fn(async () => [{ id: "native", language: "fi", label: "Finnish" }]);
      const controller = new VodSubtitleController({
        preferredLanguage: "fi", discoverEmbedded, selectEmbedded: () => true,
        searchExternal: async () => {
          await new Promise((resolve) => setTimeout(resolve, 9_000));
          return { language: "fi", activate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 9_000));
            return true;
          } };
        },
      });
      const selection = controller.start();
      await vi.advanceTimersByTimeAsync(18_000);
      expect(await selection).toEqual({ source: "external", language: "fi" });
      expect(discoverEmbedded).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("skips unplayable file tracks and automatically activates preferred external subtitles", async () => {
    const selectEmbedded = vi.fn(() => true);
    const activate = vi.fn(() => true);
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [{ id: "file-fi", language: "fin", label: "Finnish", playable: false }],
      selectEmbedded,
      searchExternal: async (language) => ({ language, activate }),
    });
    expect(await controller.start()).toEqual({ source: "external", language: "fi" });
    expect(selectEmbedded).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("falls back to preferred embedded when an external download cannot activate", async () => {
    const activate = vi.fn(() => true);
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [{ id: "native-fi", language: "fin", label: "Finnish", playable: true }],
      selectEmbedded: () => true,
      searchExternal: async (language) => ({ language, activate: () => { activate(); return false; } }),
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", language: "fi" });
    expect(activate).toHaveBeenCalledOnce();
  });

  it("uses preferred embedded when preferred external is unavailable", async () => {
    const order: string[] = [];
    const track = { id: "fi", label: "Finnish", language: "fin" };
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [track],
      selectEmbedded: async () => { order.push("embedded"); return true; },
      searchExternal: async () => { order.push("external"); return null; },
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", track });
    expect(order).toEqual(["external", "embedded"]);
  });

  it("tries the next full embedded track after preferred external search fails", async () => {
    const first = { id: "fi-1", label: "Finnish", language: "fi" };
    const second = { id: "fi-2", label: "Finnish commentary", language: "fin" };
    const selectEmbedded = vi.fn((track: typeof first) => track.id === "fi-2");
    const searchExternal = vi.fn(async () => null);
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [first, second],
      selectEmbedded,
      searchExternal,
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", track: second });
    expect(selectEmbedded.mock.calls.map(([track]) => track.id)).toEqual(["fi-1", "fi-2"]);
    expect(searchExternal).toHaveBeenCalledExactlyOnceWith("fi");
  });

  it("tries preferred external before fallback embedded", async () => {
    const order: string[] = [];
    const track = { id: "en", label: "English", language: "eng" };
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [track],
      selectEmbedded: async () => { order.push("embedded"); return true; },
      searchExternal: async (language) => {
        order.push(`search:${language}`);
        return language === "fi" ? { language, activate: async () => { order.push("external"); return true; } } : null;
      },
    });
    expect(await controller.start()).toMatchObject({ source: "external", language: "fi" });
    expect(order).toEqual(["search:fi", "external"]);
  });

  it("tries fallback external before fallback embedded", async () => {
    const order: string[] = [];
    const track = { id: "en", label: "English", language: "en" };
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [track],
      selectEmbedded: async () => { order.push("embedded"); return true; },
      searchExternal: async (language) => { order.push(`search:${language}`); return null; },
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", track });
    expect(order).toEqual(["search:fi", "search:en", "embedded"]);
  });

  it.each(["fi", "en"] as const)("uses %s OpenSubtitles before embedded tracks in that language", async (preferredLanguage) => {
    const selectEmbedded = vi.fn(() => true);
    const discoverEmbedded = vi.fn(async () => [{ id: "native", label: preferredLanguage, language: preferredLanguage }]);
    const controller = new VodSubtitleController({
      preferredLanguage, discoverEmbedded, selectEmbedded,
      searchExternal: async (language) => ({ language, activate: () => true }),
    });
    expect(await controller.start()).toEqual({ source: "external", language: preferredLanguage });
    expect(selectEmbedded).not.toHaveBeenCalled();
    expect(discoverEmbedded).not.toHaveBeenCalled();
  });

  it("keeps Finnish embedded ahead of English OpenSubtitles when Finnish is preferred", async () => {
    const searchExternal = vi.fn(async (language: string) => language === "en" ? { language, activate: () => true } : null);
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [{ id: "fi", label: "Finnish", language: "fin" }],
      selectEmbedded: () => true, searchExternal,
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", language: "fi" });
    expect(searchExternal).toHaveBeenCalledExactlyOnceWith("fi");
  });

  it("uses fallback OpenSubtitles ahead of fallback embedded tracks", async () => {
    const selectEmbedded = vi.fn(() => true);
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [{ id: "en", label: "English", language: "eng" }],
      selectEmbedded,
      searchExternal: async (language) => language === "en" ? { language, activate: () => true } : null,
    });
    expect(await controller.start()).toEqual({ source: "external", language: "en" });
    expect(selectEmbedded).not.toHaveBeenCalled();
  });

  it("does not activate an external result after the user makes a manual choice", async () => {
    let resolveSearch!: (result: { language: string; activate: (isCurrent: () => boolean) => boolean } | null) => void;
    const activate = vi.fn((isCurrent: () => boolean) => isCurrent());
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [],
      selectEmbedded: () => true,
      searchExternal: () => new Promise((resolve) => { resolveSearch = resolve; }),
    });
    const pending = controller.start();
    await vi.waitFor(() => expect(resolveSearch).toBeTypeOf("function"));
    controller.chooseManual();
    resolveSearch({ language: "fi", activate });
    expect(await pending).toEqual({ source: "off" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("times out bounded discovery and leaves subtitles off when no candidates exist", async () => {
    vi.useFakeTimers();
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoveryTimeoutMs: 10,
      discoverEmbedded: () => new Promise<readonly VodEmbeddedSubtitleCandidate[]>(() => {}),
      selectEmbedded: () => true,
      searchExternal: async () => null,
    });
    const pending = controller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ source: "off" });
    vi.useRealTimers();
  });

  it("continues fallback when preferred external search rejects", async () => {
    const fallback = { id: "en", label: "English", language: "en" };
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoverEmbedded: async () => [fallback],
      selectEmbedded: () => true,
      searchExternal: async () => { throw new Error("synthetic search failure"); },
    });
    expect(await controller.start()).toMatchObject({ source: "embedded", track: fallback });
  });

  it("invalidates a timed-out external activation before fallback can be replaced late", async () => {
    vi.useFakeTimers();
    const attached: string[] = [];
    const fallback = { id: "en", label: "English", language: "en" };
    const controller = new VodSubtitleController({
      preferredLanguage: "fi",
      discoveryTimeoutMs: 0,
      externalTimeoutMs: 10,
      discoverEmbedded: async () => [fallback],
      selectEmbedded: (track) => { attached.push(track.id); return true; },
      searchExternal: async (language) => language === "fi" ? {
        language,
        activate: async (isCurrent) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (isCurrent()) attached.push("late-external");
          return true;
        },
      } : null,
    });
    const pending = controller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ source: "embedded", track: fallback });
    await vi.advanceTimersByTimeAsync(20);
    expect(attached).toEqual(["en"]);
    vi.useRealTimers();
  });
});
