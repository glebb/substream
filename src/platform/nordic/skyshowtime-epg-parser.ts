import type { EpgProgramme } from "../../core/live/types.ts";

/** Kept self-contained so its source can be embedded in a classic worker. */
export function parseSkyShowtimeXmltv(xml: string): EpgProgramme[] {
  const supported: Record<string, boolean> = {
    "[SKYS1SV].SkyShowtime.1.se": true,
    "[SKYS2SV].SkyShowtime.2.se": true,
  };
  const programmes: EpgProgramme[] = [];
  const expression = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(xml)) !== null) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    const channelId = attribute(attributes, "channel");
    const startTime = xmltvTime(attribute(attributes, "start"));
    const endTime = xmltvTime(attribute(attributes, "stop"));
    const title = elementText(body, "title");
    if (!channelId || !supported[channelId] || startTime === null || endTime === null || endTime <= startTime || !title) continue;
    const description = elementText(body, "desc");
    const programme: EpgProgramme = { channelId, title, startTime, endTime };
    if (description) programme.description = description;
    programmes.push(programme);
  }
  return programmes.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);

  function attribute(source: string, name: string): string {
    return new RegExp("\\b" + name + "=\"([^\"]*)\"", "i").exec(source)?.[1] || "";
  }
  function elementText(source: string, name: string): string {
    const raw = new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i").exec(source)?.[1] || "";
    return decodeXml(raw.replace(/<[^>]+>/g, "")).trim();
  }
  function decodeXml(value: string): string {
    return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[entity] || entity));
  }
  function xmltvTime(value: string): number | null {
    const time = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+([+-])(\d{2})(\d{2})$/.exec(value.trim());
    if (!time) return null;
    const year = Number(time[1]); const month = Number(time[2]); const day = Number(time[3]);
    const hour = Number(time[4]); const minute = Number(time[5]); const second = Number(time[6]);
    const utc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset = (Number(time[8]) * 60 + Number(time[9])) * 60_000;
    return Number.isFinite(utc) ? utc + (time[7] === "+" ? -offset : offset) : null;
  }
}

/** Cooperative fallback used when a classic worker is unavailable or blocked. */
export async function parseSkyShowtimeXmltvAsync(xml: string): Promise<EpgProgramme[]> {
  const supported: Record<string, boolean> = {
    "[SKYS1SV].SkyShowtime.1.se": true,
    "[SKYS2SV].SkyShowtime.2.se": true,
  };
  const programmes: EpgProgramme[] = [];
  const expression = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let match: RegExpExecArray | null;
  let processed = 0;
  while ((match = expression.exec(xml)) !== null) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    const channelId = attribute(attributes, "channel");
    const startTime = xmltvTime(attribute(attributes, "start"));
    const endTime = xmltvTime(attribute(attributes, "stop"));
    const title = elementText(body, "title");
    if (channelId && supported[channelId] && startTime !== null && endTime !== null && endTime > startTime && title) {
      const description = elementText(body, "desc");
      programmes.push({ channelId, title, startTime, endTime, ...(description ? { description } : {}) });
    }
    processed += match[0].length;
    if (processed >= 128 * 1024) {
      processed = 0;
      await yieldToUi();
    }
  }
  return programmes.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
}

function attribute(source: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(source)?.[1] ?? "";
}

function elementText(source: string, name: string): string {
  const raw = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(source)?.[1] ?? "";
  return decodeXml(raw.replace(/<[^>]+>/g, "")).trim();
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
}

function xmltvTime(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+([+-])(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
  return Number.isFinite(utc) ? utc + (sign === "+" ? -offset : offset) : null;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
