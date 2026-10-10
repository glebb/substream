import { describe, expect, it, vi } from "vitest";
import { loadLiveGuideSource } from "./live-guide-source.ts";

describe("authoritative replacement guide", () => {
  it.each(["empty", "failed"])("never requests provider EPG when replacement is %s", async (mode) => {
    const provider = vi.fn(async () => []);
    const replacement = vi.fn(async () => { if (mode === "failed") throw new Error("synthetic failure"); return []; });
    expect(await loadLiveGuideSource("synthetic-replacement", { provider, replacement })).toEqual([]);
    expect(replacement).toHaveBeenCalledWith("synthetic-replacement");
    expect(provider).not.toHaveBeenCalled();
  });
  it("retains provider EPG for channels without a replacement", async () => {
    const provider = vi.fn(async () => []);
    const replacement = vi.fn(async () => []);
    await loadLiveGuideSource(null, { provider, replacement });
    expect(provider).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });
});
