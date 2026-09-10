export async function* responseTextChunks(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    yield await response.text();
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
