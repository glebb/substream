import { readPlaylistResponse, safeInspectionError, summarizePlaylist } from "./inspect-m3u-lib.ts";

const DEFAULT_MAX_PLAYLIST_MB = 250;
const requestedMaxMegabytes = Number(process.env.IPTV_M3U_MAX_MB ?? DEFAULT_MAX_PLAYLIST_MB);
const maxPlaylistMegabytes = Number.isFinite(requestedMaxMegabytes) && requestedMaxMegabytes > 0
  ? requestedMaxMegabytes
  : DEFAULT_MAX_PLAYLIST_MB;
const MAX_PLAYLIST_BYTES = Math.floor(maxPlaylistMegabytes * 1024 * 1024);
const playlistUrl = process.env.IPTV_M3U_URL?.trim();

if (!playlistUrl) {
  console.error("IPTV_M3U_URL is empty. Add the private playlist URL to .env.");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(playlistUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("Playlist request failed with HTTP " + response.status);

    const source = await readPlaylistResponse(response, MAX_PLAYLIST_BYTES);
    console.log(JSON.stringify(summarizePlaylist(source), null, 2));
  } catch (error) {
    // Fetch errors often include the full redirected URL, including credentials or signatures.
    console.error(safeInspectionError(error));
    process.exitCode = 1;
  }
}
