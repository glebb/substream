import { describe, expect, it } from "vitest";

import { createNordicEpgWorkerSource } from "./skyshowtime-epg.ts";
import { parseSkyShowtimeXmltv, parseSkyShowtimeXmltvAsync } from "./skyshowtime-epg-parser.ts";

const programme = `<programme channel="[SKYS1SV].SkyShowtime.1.se" start="20260928131700 +0000" stop="20260928152600 +0000"><title>Show</title><desc>${"synthetic guide text ".repeat(8)}</desc></programme>`;

describe("Nordic EPG XMLTV parser", () => {
  it("keeps the worker parser self-contained and parses the supported synthetic channel", () => {
    expect(parseSkyShowtimeXmltv(programme)).toEqual([{
      channelId: "[SKYS1SV].SkyShowtime.1.se",
      title: "Show",
      description: "synthetic guide text ".repeat(8).trim(),
      startTime: Date.UTC(2026, 8, 28, 13, 17),
      endTime: Date.UTC(2026, 8, 28, 15, 26),
    }]);
  });

  it("executes the generated classic worker source with a synthetic XML payload", () => {
    const responses: Array<{ programmes: unknown[] }> = [];
    const scope: { onmessage: ((event: { data: ArrayBuffer }) => void) | null; postMessage(value: { programmes: unknown[] }): void } = {
      onmessage: null,
      postMessage: (value) => responses.push(value),
    };
    const installWorker = new Function("self", "TextDecoder", "Uint8Array", createNordicEpgWorkerSource());
    installWorker(scope, TextDecoder, Uint8Array);
    scope.onmessage?.({ data: new TextEncoder().encode(programme).buffer as ArrayBuffer });
    expect((responses[0]?.programmes[0] as { title: string }).title).toBe("Show");
  });

  it("yields between batches while parsing a large synthetic guide", async () => {
    const xml = `<tv>${programme.repeat(3_000)}</tv>`;
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const parsed = await parseSkyShowtimeXmltvAsync(xml);
    expect(timerRan).toBe(true);
    expect(parsed).toHaveLength(3_000);
  });
});
