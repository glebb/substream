import type { CurrentAndNextProgramme, EpgProgramme } from "./types.ts";

/**
 * Returns a stable, usable schedule: invalid entries and exact duplicates are
 * discarded, and the remainder is ordered by start and end time.
 */
export function normalizeEpgProgrammes(programmes: readonly EpgProgramme[]): EpgProgramme[] {
  const seen = new Set<string>();
  const normalized: EpgProgramme[] = [];

  for (const programme of programmes) {
    if (!programme.channelId.trim() || !programme.title.trim()) continue;
    if (!Number.isFinite(programme.startTime) || !Number.isFinite(programme.endTime)) continue;
    if (programme.endTime <= programme.startTime) continue;

    const key = [programme.channelId, programme.startTime, programme.endTime, programme.title].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(programme);
  }

  return normalized.sort((left, right) => left.startTime - right.startTime
    || left.endTime - right.endTime
    || left.title.localeCompare(right.title));
}

/**
 * Selects the programme active at now and the next one after it.
 * Times are epoch milliseconds. In overlapping schedules, the active entry
 * with the latest start wins; the next entry must begin after it ends so
 * overlapping entries are not shown as next.
 */
export function selectCurrentAndNextProgramme(
  programmes: readonly EpgProgramme[],
  now: number,
): CurrentAndNextProgramme {
  if (!Number.isFinite(now)) return { current: null, next: null };

  const schedule = normalizeEpgProgrammes(programmes);
  let current: EpgProgramme | null = null;
  for (const programme of schedule) {
    if (programme.startTime <= now && now < programme.endTime
      && (!current || programme.startTime > current.startTime
        || (programme.startTime === current.startTime && programme.endTime < current.endTime))) {
      current = programme;
    }
  }

  const next = schedule.find((programme) => programme.startTime > now
    && (!current || programme.startTime >= current.endTime)) ?? null;
  return { current, next };
}
