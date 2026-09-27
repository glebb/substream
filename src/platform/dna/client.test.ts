import { describe, expect, it, vi } from "vitest";
import { DnaGuideClient } from "./client.ts";

describe("DnaGuideClient", () => {
  it("maps catalog channels and skips generic logos", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ _embedded: { "xrtv:media-item": [
      { name: "Yle TV1", datalistTerm: "ch-1118", _embedded: { "xrtv:image": [{ src: "https://img.dna.fi/yle.png" }] } },
      { name: "Generic", datalistTerm: "ch-1", _embedded: { "xrtv:image": [{ src: "https://www.dna.fi/o/dna-fi-theme/images/dna/dna_logo.png" }] } },
      { name: "Unsafe", datalistTerm: "ch-2", _embedded: { "xrtv:image": [{ src: "https://evil.example/logo.png" }] } },
    ] } }) });
    const client = new DnaGuideClient(request);
    await expect(client.channels()).resolves.toEqual([
      { id: "ch-1118", name: "Yle TV1", logo: "https://img.dna.fi/yle.png" },
      { id: "ch-1", name: "Generic", logo: null },
      { id: "ch-2", name: "Unsafe", logo: null },
    ]);
    const url = new URL(request.mock.calls[0]![0] as string);
    expect(url.searchParams.get("q")).toBe("profile:ch");
    expect(url.searchParams.get("limit")).toBe("1000");
  });

  it("decodes HAL programme metadata and requests the bounded schedule", async () => {
    const start = 1_800_000_000_000;
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ _embedded: { "xrtv:media-item": [
      { _embedded: { "xrtv:meta": { data: { start, end: start + 1_800_000, title: { lang: "fi", value: "Uutiset" }, description: { value: "Ajankohtaiset" } } } } },
      { _embedded: { "xrtv:meta": { data: { start: start + 1, end: start, title: { value: "invalid" } } } } },
    ] } }) });
    const client = new DnaGuideClient(request);
    await expect(client.schedule("ch-1118", start, start + 86_400_000)).resolves.toEqual([
      { channelId: "ch-1118", title: "Uutiset", startTime: start, endTime: start + 1_800_000, description: "Ajankohtaiset" },
    ]);
    const url = new URL(request.mock.calls[0]![0] as string);
    expect(url.searchParams.getAll("q")).toEqual(["channel:ch-1118", "profile:pr", `start-interval:${start}/${start + 86_400_000}`]);
    expect(url.searchParams.get("view")).toBe("web-aggregated");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("sanitizes network failures and validates channel IDs", async () => {
    const client = new DnaGuideClient(async () => { throw new Error("private URL with secret"); });
    await expect(client.schedule("not-an-id")).rejects.toThrow("Invalid DNA channel identifier");
    await expect(client.channels()).rejects.toThrow("DNA guide request failed");
    await expect(client.channels()).rejects.not.toThrow("secret");
  });
});
