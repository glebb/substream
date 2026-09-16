/** Removes provider-specific styling while preserving readable dialogue and line breaks. */
export function normalizeSubtitleText(text: string): string {
  return text
    .replace(/\{(?:\\[^}]*)+\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}
