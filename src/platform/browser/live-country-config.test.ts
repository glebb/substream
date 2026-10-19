import { describe, expect, it } from "vitest";
import { clearLiveCountries, loadLastLiveCountry, loadLiveCountries, saveLastLiveCountry, saveLiveCountries } from "./live-country-config.ts";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}

describe("live country preferences", () => {
  it("defaults to Finland until a selection is saved", () => {
    expect(loadLiveCountries(storage())).toEqual(["finland"]);
    expect(loadLiveCountries(null)).toEqual(["finland"]);
  });

  it("deduplicates, validates and keeps the saved order", () => {
    const local = storage();
    expect(saveLiveCountries(["sweden", "finland", "sweden", "https://x.example", ""], local)).toEqual(["sweden", "finland"]);
    expect(loadLiveCountries(local)).toEqual(["sweden", "finland"]);
  });

  it("returns the stored selection when a write fails", () => {
    const local = storage();
    saveLiveCountries(["finland", "sweden"], local);
    const full = { ...local, setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };
    expect(saveLiveCountries(["finland", "sweden", "norway"], full)).toEqual(["finland", "sweden"]);
  });

  it("never stores an empty selection", () => {
    const local = storage();
    expect(saveLiveCountries([], local)).toEqual(["finland"]);
    local.setItem("substream.live-countries", "not json");
    expect(loadLiveCountries(local)).toEqual(["finland"]);
  });

  it("clears the selection back to the default", () => {
    const local = storage();
    saveLiveCountries(["sweden"], local);
    saveLastLiveCountry("sweden", local);
    clearLiveCountries(local);
    expect(loadLiveCountries(local)).toEqual(["finland"]);
    expect(loadLastLiveCountry(local)).toBeNull();
  });

  it("remembers the last opened country", () => {
    const local = storage();
    expect(loadLastLiveCountry(local)).toBeNull();
    saveLastLiveCountry("united-kingdom", local);
    saveLastLiveCountry("Bad Value", local);
    expect(loadLastLiveCountry(local)).toBe("united-kingdom");
  });
});
