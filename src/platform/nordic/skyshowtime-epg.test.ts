import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { NordicEpgRequestError, NordicSkyShowtimeEpgClient, NORDIC_SKYSHOWTIME_EPG_URL, nordicGuideSourceUrl, skyShowtimeNordicXmltvId } from "./skyshowtime-epg.ts";

const fixture = `<?xml version="1.0"?><tv>
  <programme channel="[SKYS1SV].SkyShowtime.1.se" start="20260928131700 +0000" stop="20260928152600 +0000"><title lang="en">Song Sung Blue</title><desc lang="sv">Beskrivning &amp; detaljer</desc></programme>
  <programme channel="[SKYS2SV].SkyShowtime.2.se" start="20260928125200 +0000" stop="20260928134400 +0000"><title>House</title></programme>
  <programme channel="other" start="20260928131700 +0000" stop="20260928152600 +0000"><title>Ignored</title></programme>
</tv>`;

describe("NordicSkyShowtimeEpgClient", () => {
  it("never routes a Tizen guide request through the optional companion", () => {
    expect(nordicGuideSourceUrl({ isTizen: true, relayUrl: "http://192.0.2.44:8787", development: false })).toBe(NORDIC_SKYSHOWTIME_EPG_URL);
    expect(nordicGuideSourceUrl({ isTizen: false, relayUrl: "http://192.0.2.44:8787", development: false })).toBe("/public/nordic-epg");
  });

  it("loads the packaged Tizen guide directly with no companion configured", async () => {
    const source = nordicGuideSourceUrl({ isTizen: true, development: false });
    const requested: string[] = [];
    const client = new NordicSkyShowtimeEpgClient(async (url) => {
      requested.push(url);
      const bytes = gzipSync(new TextEncoder().encode(fixture));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }, source);

    const schedule = await client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-provider-channel");
    expect(schedule.map(({ channelId, title }) => ({ channelId, title }))).toEqual([{
      channelId: "synthetic-provider-channel", title: "Song Sung Blue",
    }]);
    expect(requested).toEqual([NORDIC_SKYSHOWTIME_EPG_URL]);
    expect(requested.join(" ")).not.toContain("/api/nordic-epg");
  });

  it("maps only the Finnish provider IDs", () => {
    expect(skyShowtimeNordicXmltvId({ country: "finland", epgId: "skyshowtime1.se", name: "FI: Sky Showtime 1 FHD" })).toBe("[SKYS1SV].SkyShowtime.1.se");
    expect(skyShowtimeNordicXmltvId({ country: "finland", epgId: "SkyShowtime 2.se", name: "FI: Sky Showtime 2 FHD" })).toBe("[SKYS2SV].SkyShowtime.2.se");
    expect(skyShowtimeNordicXmltvId({ country: "finland", name: "FI: Sky Showtime 1 FHD [Multi-Sub]" })).toBe("[SKYS1SV].SkyShowtime.1.se");
    expect(skyShowtimeNordicXmltvId({ country: "unknown", epgId: "skyshowtime1.se", name: "FI: Sky Showtime 1" })).toBeNull();
    expect(skyShowtimeNordicXmltvId({ country: "finland", epgId: "other", name: "FI: Something Else" })).toBeNull();
  });

  it("decompresses XMLTV and converts UTC timestamps without using device time", async () => {
    let calls = 0;
    const client = new NordicSkyShowtimeEpgClient(async (url) => {
      calls += 1;
      expect(url).toBe(NORDIC_SKYSHOWTIME_EPG_URL);
      const bytes = gzipSync(new TextEncoder().encode(fixture));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    });
    await expect(client.schedule("[SKYS1SV].SkyShowtime.1.se", "provider-1")).resolves.toEqual([{
      channelId: "provider-1", title: "Song Sung Blue", description: "Beskrivning & detaljer",
      startTime: Date.UTC(2026, 8, 28, 13, 17), endTime: Date.UTC(2026, 8, 28, 15, 26),
    }]);
    await client.schedule("[SKYS2SV].SkyShowtime.2.se", "provider-2");
    expect(calls).toBe(1);
  });

  it("sanitizes request failures", async () => {
    const client = new NordicSkyShowtimeEpgClient(async () => { throw new Error("https://private.example/secret"); });
    await expect(client.schedule("[SKYS1SV].SkyShowtime.1.se", "provider-1")).rejects.toEqual(new NordicEpgRequestError());
  });
});

it("routes hosted browsers through a fixed public endpoint without a companion", () => {
  expect(nordicGuideSourceUrl({ canFetchDirectly: false, development: false })).toBe("/public/nordic-epg");
  expect(nordicGuideSourceUrl({ canFetchDirectly: true, development: false })).toBe(NORDIC_SKYSHOWTIME_EPG_URL);
});

it("retries after a failed request and omits cookies and referrers", async () => {
  let calls = 0;
  const bytes = gzipSync(new TextEncoder().encode(fixture));
  const client = new NordicSkyShowtimeEpgClient(async (_url, init) => {
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    if (++calls === 1) throw new Error("synthetic failure");
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  });
  await expect(client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-1")).rejects.toBeInstanceOf(NordicEpgRequestError);
  expect(await client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-1")).toHaveLength(1);
  expect(calls).toBe(2);
});

it("refreshes the shared feed after its cache lifetime", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let calls = 0;
    const bytes = gzipSync(new TextEncoder().encode(fixture));
    const client = new NordicSkyShowtimeEpgClient(async () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    });
    await client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-1");
    await client.schedule("[SKYS2SV].SkyShowtime.2.se", "synthetic-2");
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 12 * 60 * 1000);
    await client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-1");
    expect(calls).toBe(2);
  } finally { vi.useRealTimers(); }
});

it("times out an unresponsive public feed and permits a retry", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const client = new NordicSkyShowtimeEpgClient(async () => new Promise(() => {}));
    const pending = client.schedule("[SKYS1SV].SkyShowtime.1.se", "synthetic-1");
    const assertion = expect(pending).rejects.toBeInstanceOf(NordicEpgRequestError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  } finally { vi.useRealTimers(); }
});
