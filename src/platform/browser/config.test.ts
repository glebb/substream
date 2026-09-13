import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../package-defaults.ts", () => ({ packageDefaults: {
  playlistUrl: "https://package-default.invalid/playlist",
  openSubtitlesApiKey: "package-default-key",
} }));
import { clearSavedOpenSubtitlesSettings, loadOpenSubtitlesApiKey, saveOpenSubtitlesApiKey } from "./opensubtitles-config.ts";
import { clearSavedPlaylistUrl, loadPlaylistUrl, savePlaylistUrl } from "./playlist-config.ts";
import { clearCatalogClearedMarker, markCatalogCleared, wasCatalogCleared } from "./catalog-preferences.ts";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("browser configuration storage", () => {
  it("uses bundled defaults when localStorage access is denied", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => { throw new DOMException("blocked", "SecurityError"); },
    });

    expect(loadPlaylistUrl()).toBe("https://package-default.invalid/playlist");
    expect(loadOpenSubtitlesApiKey()).toBe("package-default-key");
  });

  it("prefers locally saved configuration over bundled defaults", () => {
    const values = new Map([
      ["substream.playlist-url", "https://local.example.invalid/playlist"],
      ["substream.opensubtitles-api-key", "local-test-key"],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn((key: string) => values.get(key) ?? null) },
    });

    expect(loadPlaylistUrl()).toBe("https://local.example.invalid/playlist");
    expect(loadOpenSubtitlesApiKey()).toBe("local-test-key");
  });

  it("keeps the session usable when denied storage prevents saving", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => { throw new DOMException("blocked", "SecurityError"); }),
        setItem: vi.fn(() => { throw new DOMException("blocked", "SecurityError"); }) },
    });

    expect(() => savePlaylistUrl("https://example.invalid/playlist")).not.toThrow();
    expect(() => saveOpenSubtitlesApiKey("temporary-key")).not.toThrow();
    expect(loadPlaylistUrl()).toBe("https://package-default.invalid/playlist");
    expect(loadOpenSubtitlesApiKey()).toBe("package-default-key");
  });

  it("clears only this app's saved credentials and catalogue-clear preference", () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    savePlaylistUrl("https://synthetic.example/list");
    saveOpenSubtitlesApiKey("synthetic-key");
    values.set("unrelated.preference", "keep");
    markCatalogCleared();
    expect(wasCatalogCleared()).toBe(true);

    clearSavedPlaylistUrl();
    clearSavedOpenSubtitlesSettings();
    clearCatalogClearedMarker();
    expect(values.has("substream.playlist-url")).toBe(false);
    expect(values.has("substream.opensubtitles-api-key")).toBe(false);
    expect(wasCatalogCleared()).toBe(false);
    expect(values.get("unrelated.preference")).toBe("keep");
  });
});
