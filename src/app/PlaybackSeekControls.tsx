import { useContext, useRef, useState } from "react";
import type { PlaybackProgress } from "../platform/media-player.ts";
import { LanguageContext, Localized } from "./language.tsx";

/** Keep dragging local; restarting the remux worker on every input would prevent seeking. */
export function PlaybackSeekControls({ progress, formatTime, onSeek, onSkip }: {
  progress: PlaybackProgress;
  formatTime(seconds: number): string;
  onSeek(seconds: number): void;
  onSkip(seconds: number): void;
}) {
  const { language } = useContext(LanguageContext);
  const [draft, setDraft] = useState<number | undefined>();
  const pending = useRef<number | undefined>(undefined);
  const duration = progress.durationSeconds;
  const enabled = Number.isFinite(duration) && duration > 0;
  const current = Math.max(0, Math.min(draft ?? progress.currentTimeSeconds, enabled ? duration : 0));
  const commit = () => {
    const seconds = pending.current;
    pending.current = undefined;
    setDraft(undefined);
    if (seconds !== undefined && enabled) onSeek(seconds);
  };
  return <Localized language={language}><div className="touch-seek-controls">
    <div className="playback-progress" aria-label="Playback progress">
      <span>{formatTime(current)}</span>
      <input type="range" aria-label="Seek video" min="0" max={enabled ? duration : 0} step="1"
        value={current} disabled={!enabled} onChange={(event) => {
          const seconds = Number(event.currentTarget.value);
          pending.current = seconds;
          setDraft(seconds);
        }} onPointerUp={commit} onTouchEnd={commit} onMouseUp={commit} onKeyUp={commit} onBlur={commit}
        onPointerCancel={() => { pending.current = undefined; setDraft(undefined); }} />
      <span>{formatTime(enabled ? duration : 0)}</span>
    </div>
    <div className="touch-skip-buttons">
      <button type="button" aria-label="Back 10 seconds" onClick={() => onSkip(-10)}>−10 s</button>
      <button type="button" aria-label="Forward 30 seconds" onClick={() => onSkip(30)}>+30 s</button>
    </div>
  </div></Localized>;
}
