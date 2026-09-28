import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { NordicEpgRequestError, NordicSkyShowtimeEpgClient, NORDIC_SKYSHOWTIME_EPG_URL, skyShowtimeNordicXmltvId } from "./skyshowtime-epg.ts";

const fixture = `<?xml version="1.0"?><tv>
  <programme channel="[SKYS1SV].SkyShowtime.1.se" start="20260928131700 +0000" stop="20260928152600 +0000"><title lang="en">Song Sung Blue</title><desc lang="sv">Beskrivning &amp; detaljer</desc></programme>
  <programme channel="[SKYS2SV].SkyShowtime.2.se" start="20260928125200 +0000" stop="20260928134400 +0000"><title>House</title></programme>
  <programme channel="other" start="20260928131700 +0000" stop="20260928152600 +0000"><title>Ignored</title></programme>
</tv>`;

describe("NordicSkyShowtimeEpgClient", () => {
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
