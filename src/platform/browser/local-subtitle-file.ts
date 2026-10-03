import { parseSrtCues } from "../../core/subtitles/srt-cues.ts";

export const MAX_LOCAL_SUBTITLE_BYTES = 2 * 1024 * 1024;

/** Read a bounded UTF-8 SRT/WebVTT file through FileReader for older browsers. */
export function readLocalSubtitleFile(file: File): Promise<{ text: string; label: string; language: string }> {
  if (file.size > MAX_LOCAL_SUBTITLE_BYTES) return Promise.reject(new Error("Subtitle file is too large (maximum 2 MB)."));
  if (!/\.(srt|vtt)$/i.test(file.name)) return Promise.reject(new Error("Choose an SRT or WebVTT subtitle file."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Subtitle file could not be read. Try another UTF-8 SRT or WebVTT file."));
    reader.onabort = () => reject(new Error("Subtitle file reading was cancelled."));
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") : "";
      const vtt = /\.vtt$/i.test(file.name);
      const timestamp = "(?:\\d{2,}:)?\\d{2}:\\d{2}\\.\\d{3}";
      const valid = vtt
        ? /^WEBVTT(?:\s|$)/.test(text) && new RegExp(timestamp + "\\s+-->\\s+" + timestamp).test(text)
        : parseSrtCues(text).length > 0;
      if (!valid) {
        reject(new Error("This file does not contain supported SRT or WebVTT subtitle cues."));
        return;
      }
      resolve({ text, label: file.name.slice(0, 100), language: "und" });
    };
    reader.readAsText(file, "UTF-8");
  });
}
