import type { M3uAttributes, M3uEntry, M3uPlaylist } from "./types.ts";

interface PendingEntry {
  name: string;
  duration: number | null;
  attributes: M3uAttributes;
  options: Record<string, string>;
  line: number;
}

const ATTRIBUTE_PATTERN = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;

export function parseAttributes(input: string): M3uAttributes {
  const attributes: M3uAttributes = {};

  for (const match of input.matchAll(ATTRIBUTE_PATTERN)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) attributes[key] = value;
  }

  return attributes;
}

function findUnquotedComma(input: string): number {
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if ((character === "\"" || character === "'") && quote === null) quote = character;
    else if (character === quote) quote = null;
    else if (character === "," && quote === null) return index;
  }

  return -1;
}

function parseExtInf(line: string, lineNumber: number): PendingEntry {
  const body = line.slice(line.indexOf(":") + 1).trim();
  const commaIndex = findUnquotedComma(body);
  const metadata = commaIndex >= 0 ? body.slice(0, commaIndex) : body;
  const name = commaIndex >= 0 ? body.slice(commaIndex + 1).trim() : "";
  const durationToken = metadata.match(/^(-?\d+(?:\.\d+)?)/)?.[1];

  return {
    name,
    duration: durationToken === undefined ? null : Number(durationToken),
    attributes: parseAttributes(metadata),
    options: {},
    line: lineNumber,
  };
}

function fallbackName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).at(-1);
    return lastSegment ? decodeURIComponent(lastSegment) : "Untitled stream";
  } catch {
    return "Untitled stream";
  }
}

export function parseM3u(source: string): M3uPlaylist {
  const parser = new IncrementalM3uParser();
  const entries = [...parser.push(source), ...parser.finish()];
  return { header: parser.header, entries, warnings: parser.warnings };
}

/** Parses arbitrarily split playlist text without retaining prior chunks. */
export class IncrementalM3uParser {
  readonly header: M3uAttributes = {};
  readonly warnings: M3uPlaylist["warnings"] = [];
  private lineRemainder = "";
  private pending: PendingEntry | null = null;
  private lineNumber = 0;
  private sawContent = false;
  private finished = false;

  push(chunk: string): M3uEntry[] {
    if (this.finished) throw new Error("Cannot add chunks after finishing the M3U parser");
    const entries: M3uEntry[] = [];
    const source = this.lineNumber === 0 ? chunk.replace(/^\uFEFF/, "") : chunk;
    this.lineRemainder += source;
    let newlineIndex = this.lineRemainder.indexOf("\n");
    while (newlineIndex >= 0) {
      entries.push(...this.processLine(this.lineRemainder.slice(0, newlineIndex)));
      this.lineRemainder = this.lineRemainder.slice(newlineIndex + 1);
      newlineIndex = this.lineRemainder.indexOf("\n");
    }
    return entries;
  }

  finish(): M3uEntry[] {
    if (this.finished) return [];
    this.finished = true;
    const entries = this.lineRemainder ? this.processLine(this.lineRemainder) : [];
    this.lineRemainder = "";
    if (!this.sawContent) this.warnings.push({ line: 1, message: "Missing #EXTM3U header" });
    if (this.pending) this.warnings.push({ line: this.pending.line, message: "Entry metadata has no media URL" });
    return entries;
  }

  private processLine(rawLine: string): M3uEntry[] {
    this.lineNumber += 1;
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) return [];

    if (!this.sawContent) {
      this.sawContent = true;
      if (!line.startsWith("#EXTM3U")) this.warnings.push({ line: this.lineNumber, message: "Missing #EXTM3U header" });
    }
    if (line.startsWith("#EXTM3U")) {
      Object.assign(this.header, parseAttributes(line.slice("#EXTM3U".length)));
      return [];
    }
    if (line.startsWith("#EXTINF")) {
      if (this.pending) this.warnings.push({ line: this.pending.line, message: "Entry metadata has no media URL" });
      this.pending = parseExtInf(line, this.lineNumber);
      return [];
    }
    if (line.startsWith("#EXTVLCOPT:") || line.startsWith("#KODIPROP:")) {
      if (!this.pending) return [];
      const separator = line.indexOf("=");
      const prefixLength = line.indexOf(":") + 1;
      const key = line.slice(prefixLength, separator >= 0 ? separator : undefined).trim().toLowerCase();
      if (key) this.pending.options[key] = separator >= 0 ? line.slice(separator + 1).trim() : "";
      return [];
    }
    if (line.startsWith("#")) return [];

    const metadata = this.pending ?? { name: "", duration: null, attributes: {}, options: {}, line: this.lineNumber };
    this.pending = null;
    return [{ ...metadata, name: metadata.name || fallbackName(line), url: line }];
  }
}
