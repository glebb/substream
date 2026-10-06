import { useEffect, useState, type RefObject } from "react";
import type { MediaPlayer } from "../platform/media-player.ts";
import { streamInformationRows } from "../platform/stream-information.ts";

export function StreamInfoOverlay({ playerRef }: { playerRef: RefObject<MediaPlayer | null> }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => refresh((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const player = playerRef.current;
  const rows = streamInformationRows(player?.getStreamInformation?.() ?? {});
  return <aside className="video-info-overlay" aria-label="Stream information">
    <strong>Stream information</strong>
    <span>Resolution: {player?.getVideoResolution?.() ?? "Unavailable"}</span>
    {rows.map(([label, value]) => <span key={label}>{label}: {value}</span>)}
    {player?.getPlaybackDiagnostics?.() && <small>{player.getPlaybackDiagnostics()}</small>}
    <small>Details depend on the stream and player.</small>
  </aside>;
}
