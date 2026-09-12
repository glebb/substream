import { describe, expect, it, vi } from "vitest";
import { responseTextChunks } from "./fetch-chunks.ts";

describe("responseTextChunks", () => {
  it("falls back safely when a legacy response has no stream reader", async () => {
    const onWholeResponseFallback = vi.fn();
    const response = {
      body: {},
      text: async () => "abcdefghijkl",
    } as unknown as Response;

    const chunks: string[] = [];
    for await (const chunk of responseTextChunks(response, { onWholeResponseFallback, fallbackChunkSize: 4 })) chunks.push(chunk);

    expect(chunks).toEqual(["abcd", "efgh", "ijkl"]);
    expect(onWholeResponseFallback).toHaveBeenCalledOnce();
  });
});
