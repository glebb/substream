import type { EpgProgramme } from "../core/live/types.ts";

/** A replacement schedule is authoritative, including when temporarily unavailable. */
export async function loadLiveGuideSource(
  replacementId: string | null,
  sources: { replacement(id: string): Promise<EpgProgramme[]>; provider(): Promise<EpgProgramme[]> },
): Promise<EpgProgramme[]> {
  try {
    return replacementId ? await sources.replacement(replacementId) : await sources.provider();
  } catch { return []; }
}
