import { describe, expect, it } from "vitest";
import { OpenSubtitlesClient } from "./client.ts";

describe("OpenSubtitlesClient browser transport", () => {
  it("does not invoke native fetch with the client as its receiver", async () => {
    const nativeFetch = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => "",
      } as Response);
    } as typeof fetch;
    try {
      await new OpenSubtitlesClient("test-key").search({ query: "Example", languages: ["en"], type: "movie" });
      expect(receiver).toBeUndefined();
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});
