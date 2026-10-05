import { describe, expect, it, vi } from "vitest";
import { exitBrowserFullscreen, requestBrowserFullscreen, requestLandscapeOrientation } from "./fullscreen.ts";

describe("optional browser fullscreen", () => {
  it("allows playback to continue when the fullscreen API is absent", async () => {
    await expect(requestBrowserFullscreen({})).resolves.toBe(false);
    expect(await exitBrowserFullscreen({})).toBe(false);
  });

  it("contains synchronous failures and rejected fullscreen requests", async () => {
    expect(await requestBrowserFullscreen({ requestFullscreen() { throw new TypeError(); } })).toBe(false);
    expect(await requestBrowserFullscreen({ requestFullscreen: () => Promise.reject(new Error()) })).toBe(false);
    expect(await exitBrowserFullscreen({ exitFullscreen: () => Promise.reject(new Error()) })).toBe(false);
  });

  it("calls fullscreen with its receiver during the current gesture", async () => {
    let called = false;
    const element = { requestFullscreen() { expect(this).toBe(element); called = true; } };
    const request = requestBrowserFullscreen(element);
    expect(called).toBe(true);
    expect(await request).toBe(true);
  });

  it("requests landscape and tolerates unsupported or denied orientation locking", async () => {
    const lock = vi.fn(async () => undefined);
    await requestLandscapeOrientation({ lock });
    expect(lock).toHaveBeenCalledWith("landscape");
    await expect(requestLandscapeOrientation(undefined)).resolves.toBeUndefined();
    await expect(requestLandscapeOrientation({ lock: () => Promise.reject(new Error()) })).resolves.toBeUndefined();
  });
});
