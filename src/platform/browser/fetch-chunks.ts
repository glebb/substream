export interface ResponseTextChunkOptions {
  onWholeResponseFallback?: () => void;
  fallbackChunkSize?: number;
}

export async function* responseTextChunks(
  response: Response,
  options: ResponseTextChunkOptions = {},
): AsyncGenerator<string> {
  if (!response.body || typeof response.body.getReader !== "function") {
    options.onWholeResponseFallback?.();
    const text = await response.text();
    const chunkSize = options.fallbackChunkSize ?? 64 * 1024;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      yield text.slice(offset, offset + chunkSize);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const finalChunk = decoder.decode();
    if (finalChunk) yield finalChunk;
  } finally {
    reader.releaseLock();
  }
}
