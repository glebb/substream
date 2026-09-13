import { describe, expect, it, vi } from "vitest";
import { responseTextChunks, WholeResponseFallbackError } from "./fetch-chunks.ts";

function legacyResponse(text: string, headers: Record<string, string> = { "content-length": String(new TextEncoder().encode(text).length) }): Response {
  return {
    body: {},
    headers: new Headers(headers),
    text: vi.fn(async () => text),
  } as unknown as Response;
}

describe("responseTextChunks", () => {
  it("chunks a small legacy response after checking its declared size", async () => {
    const response = legacyResponse("abcdefghijkl");
    const onWholeResponseFallback = vi.fn();
    const chunks: string[] = [];
    for await (const chunk of responseTextChunks(response, { onWholeResponseFallback, fallbackChunkSize: 4 })) chunks.push(chunk);

    expect(chunks).toEqual(["abcd", "efgh", "ijkl"]);
    expect(onWholeResponseFallback).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity, 1.5])("handles invalid fallback chunk size %s", async (fallbackChunkSize) => {
    const chunks: string[] = [];
    for await (const chunk of responseTextChunks(legacyResponse("synthetic playlist"), { fallbackChunkSize })) chunks.push(chunk);
    expect(chunks.join("")).toBe("synthetic playlist");
  });

  it.each([
    [{}, "missing-length"],
    [{ "content-length": "n/a" }, "invalid-length"],
    [{ "content-length": "9" }, "too-large"],
    [{ "content-length": "4", "content-encoding": "gzip" }, "encoded"],
  ] as const)("refuses unsafe legacy response metadata before reading", async (headers, reason) => {
    const response = legacyResponse("synthetic", headers);
    const text = response.text;
    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of responseTextChunks(response, { maxWholeResponseBytes: 8 })) chunks.push(chunk);
    }).rejects.toMatchObject({ reason } satisfies Partial<WholeResponseFallbackError>);
    expect(text).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });

  it("checks decoded body size in case Content-Length is wrong", async () => {
    const response = legacyResponse("oversized", { "content-length": "1" });
    await expect(async () => {
      for await (const _chunk of responseTextChunks(response, { maxWholeResponseBytes: 4 })) { /* consume */ }
    }).rejects.toMatchObject({ reason: "too-large" });
  });

  it("includes a custom byte cap in the safe fallback error", async () => {
    const response = legacyResponse("text", { "content-length": "5" });
    await expect(async () => {
      for await (const _chunk of responseTextChunks(response, { maxWholeResponseBytes: 4 })) { /* consume */ }
    }).rejects.toThrow("within 4 bytes");
  });

  it("decodes UTF-8 characters split across streamed chunks", async () => {
    const encoded = new TextEncoder().encode("A🌲B");
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, 3));
        controller.enqueue(encoded.slice(3));
        controller.close();
      },
    }));
    const chunks: string[] = [];
    for await (const chunk of responseTextChunks(response)) chunks.push(chunk);
    expect(chunks.join("")).toBe("A🌲B");
  });

  it("cancels a stream when the consumer stops early", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
      },
      cancel,
    }));
    for await (const _chunk of responseTextChunks(response)) break;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a reader when read rejects", async () => {
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("synthetic read failure")),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    const response = {
      body: { getReader: () => reader },
    } as unknown as Response;
    await expect(async () => {
      for await (const _chunk of responseTextChunks(response)) { /* consume */ }
    }).rejects.toThrow("synthetic read failure");
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
