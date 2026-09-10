/** Minimal surface used by the Tizen FileSystem API; avoids Tizen globals in core code. */
export interface TizenFileStream {
  readonly eof: boolean;
  read(characterCount: number): string;
  close(): void;
}

export interface TizenFile {
  openStream(
    mode: "r",
    onSuccess: (stream: TizenFileStream) => void,
    onError: (error: unknown) => void,
  ): void;
}

function openReadStream(file: TizenFile): Promise<TizenFileStream> {
  return new Promise((resolve, reject) => file.openStream("r", resolve, reject));
}

/**
 * Reads a downloaded M3U from Tizen private storage in bounded character chunks.
 * The caller passes these chunks directly to importM3uChunks().
 */
export async function* readTizenFileChunks(
  file: TizenFile,
  chunkCharacters = 64 * 1024,
): AsyncGenerator<string> {
  const stream = await openReadStream(file);
  try {
    while (!stream.eof) {
      const chunk = stream.read(chunkCharacters);
      if (!chunk) break;
      yield chunk;
    }
  } finally {
    stream.close();
  }
}
