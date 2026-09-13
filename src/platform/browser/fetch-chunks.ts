export const DEFAULT_MAX_WHOLE_RESPONSE_BYTES = 8 * 1024 * 1024;

export type WholeResponseFallbackReason = "missing-length" | "invalid-length" | "too-large" | "encoded";

/** A safe, credential-free error for legacy devices that cannot stream a response. */
export class WholeResponseFallbackError extends Error {
  constructor(readonly reason: WholeResponseFallbackReason, readonly limitBytes = DEFAULT_MAX_WHOLE_RESPONSE_BYTES) {
    const limit = limitBytes === DEFAULT_MAX_WHOLE_RESPONSE_BYTES
      ? "8 MiB"
      : Number.isSafeInteger(limitBytes) && limitBytes >= 0 ? `${limitBytes} bytes` : "the configured limit";
    super(`This device cannot safely import a non-streaming response. Use a response with a known, uncompressed size within ${limit} or a streaming-capable device.`);
    this.name = "WholeResponseFallbackError";
  }
}

/**
 * Checks the limits that can be known before reading a legacy whole-response body.
 * Call this before starting a destructive import (for example, before clearing a catalogue).
 */
export function validateWholeResponseFallback(
  response: Pick<Response, "headers">,
  maxBytes = DEFAULT_MAX_WHOLE_RESPONSE_BYTES,
): number {
  const headers = response.headers;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new WholeResponseFallbackError("encoded", maxBytes);

  const rawLength = headers.get("content-length");
  if (rawLength === null) throw new WholeResponseFallbackError("missing-length", maxBytes);
  if (!/^\d+$/.test(rawLength.trim())) throw new WholeResponseFallbackError("invalid-length", maxBytes);
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw new WholeResponseFallbackError("invalid-length", maxBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || length > maxBytes) {
    throw new WholeResponseFallbackError("too-large", maxBytes);
  }
  return length;
}

export interface ResponseTextChunkOptions {
  onWholeResponseFallback?: () => void;
  fallbackChunkSize?: number;
  maxWholeResponseBytes?: number;
}

export async function* responseTextChunks(
  response: Response,
  options: ResponseTextChunkOptions = {},
): AsyncGenerator<string> {
  if (!response.body || typeof response.body.getReader !== "function") {
    validateWholeResponseFallback(response, options.maxWholeResponseBytes);
    options.onWholeResponseFallback?.();
    const text = await response.text();
    // Content-Length is only a preflight check; verify the decoded body too in case
    // the server sent a stale or dishonest length. This check happens after text()
    // allocates the body, which is why the preflight length and encoding checks matter.
    if (utf8ByteLength(text, options.maxWholeResponseBytes ?? DEFAULT_MAX_WHOLE_RESPONSE_BYTES) > (options.maxWholeResponseBytes ?? DEFAULT_MAX_WHOLE_RESPONSE_BYTES)) {
      throw new WholeResponseFallbackError("too-large", options.maxWholeResponseBytes ?? DEFAULT_MAX_WHOLE_RESPONSE_BYTES);
    }
    const requestedChunkSize = options.fallbackChunkSize ?? 64 * 1024;
    const chunkSize = Number.isSafeInteger(requestedChunkSize) && requestedChunkSize > 0
      ? requestedChunkSize
      : 64 * 1024;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      yield text.slice(offset, offset + chunkSize);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value) yield decoder.decode(value, { stream: true });
    }
    const finalChunk = decoder.decode();
    if (finalChunk) yield finalChunk;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the read/consumer error while still releasing the stream lock.
      }
    }
    reader.releaseLock();
  }
}

function utf8ByteLength(value: string, maxBytes: number): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}
