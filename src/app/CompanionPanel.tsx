import { useEffect, useRef, useState } from "react";
import { XtreamClient } from "../platform/xtream/client.ts";
import { companionEvents, companionSelectionTitle, companionServerUrl, connectCompanionService, type CompanionConnection } from "../platform/companion/client.ts";
import type { VodCatalogItem } from "../core/catalog/index.ts";
import type { SettingsControlKey } from "./remote-navigation.ts";
import { RemoteEditable } from "./remote-editable.tsx";

export function companionRetryDelay(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt), 30_000);
}

type CompanionPanelProps = {
  playlistUrl: string;
  onSelected?: (title: VodCatalogItem) => void;
  onPlay: (title: VodCatalogItem) => void;
  editingServer: boolean;
  onEditingServerChange: (editing: boolean) => void;
  remoteMode: boolean;
  registerControl?: (key: SettingsControlKey, element: HTMLElement | null) => void;
  focusClass?: (key: SettingsControlKey) => string;
};

/** TV-side LAN companion connection. Only a provider item ID crosses back from the companion. */
export function CompanionPanel({ playlistUrl, onSelected, onPlay, editingServer, onEditingServerChange, remoteMode, registerControl, focusClass = () => "" }: CompanionPanelProps) {
  const [server, setServer] = useState(companionServerUrl());
  const [draft, setDraft] = useState(companionServerUrl());
  const [connection, setConnection] = useState<CompanionConnection | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const renewalInFlight = useRef(false);
  const retryRenewalAt = useRef(0);
  const pollInFlight = useRef(false);
  const connectInFlight = useRef(false);
  const onPlayRef = useRef(onPlay);
  const onSelectedRef = useRef(onSelected);
  onPlayRef.current = onPlay;
  onSelectedRef.current = onSelected;

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    const poll = async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        if (Date.now() >= connection.expiresAt - 120_000 && Date.now() >= retryRenewalAt.current && !renewalInFlight.current) {
          renewalInFlight.current = true;
          retryRenewalAt.current = Date.now() + 10_000;
          try { await connect(true); } finally { renewalInFlight.current = false; }
          return;
        }
        const events = await companionEvents(server, connection.sessionId, sequence.current);
        for (const event of events) {
          sequence.current = Math.max(sequence.current, event.sequence);
          const client = XtreamClient.fromPlaylistUrl(playlistUrl);
          if (!client || event.selection.sourceFingerprint !== client.pairingFingerprint()) {
            setError("The selected title belongs to a different provider connection.");
            continue;
          }
          const candidate = companionSelectionTitle(event.selection);
          if (!candidate) continue;
          const streamKind = candidate.contentType === "movie" ? "movie" : "series";
          candidate.streamUrl = client.streamUrlFor(streamKind, event.selection.id, event.selection.extension);
          if (event.action === "play") {
            setStatus(`${candidate.title} sent to TV playback.`);
            onPlayRef.current(candidate);
          } else if (onSelectedRef.current) {
            setStatus(`${candidate.title} received from companion.`);
            onSelectedRef.current(candidate);
          }
        }
      } catch (cause) {
        if (!cancelled) {
          const message = cause instanceof Error && cause.message === "Companion connection expired."
            ? cause.message
            : "TV connection was interrupted. Reconnecting…";
          setError(message);
          if (message === "Companion connection expired." && !renewalInFlight.current) {
            renewalInFlight.current = true;
            retryRenewalAt.current = Date.now() + 10_000;
            window.setTimeout(() => { void connect(true).finally(() => { renewalInFlight.current = false; }); }, 5_000);
          }
        }
      } finally {
        pollInFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connection, playlistUrl, server]);

  const connect = async (silent = false) => {
    if (connectInFlight.current) return;
    connectInFlight.current = true;
    if (!silent) { setError(""); setStatus("Connecting to companion service…"); }
    try {
      const normalized = new URL((silent ? server : draft).trim()).origin;
      const result = await connectCompanionService(normalized, playlistUrl);
      setServer(normalized); setConnection(result); sequence.current = 0;
      setStatus("TV connection active. Search in the web app to send playback here.");
    } catch (cause) { if (!silent) { setStatus(""); setError(cause instanceof Error ? cause.message : "Companion service connection failed."); } }
    finally { connectInFlight.current = false; }
  };

  useEffect(() => {
    if (connection || !server.trim() || !playlistUrl.trim()) return;
    let cancelled = false;
    let attempt = 0;
    let timer: number | undefined;
    const retry = async () => {
      if (cancelled) return;
      await connect(true);
      if (cancelled || connection) return;
      timer = window.setTimeout(() => {
        attempt += 1;
        void retry();
      }, companionRetryDelay(attempt));
    };
    void retry();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  // Startup and recovery are best-effort; Settings retains explicit Connect for draft addresses.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, playlistUrl, server]);

  return <section className="settings-section companion-panel">
    <h3>TV connection</h3>
    <p className="hint">Connect this TV to the LAN service so the web app can search the full Xtream catalogue and send playback here. Credentials and stream URLs stay on this TV and the LAN service.</p>
    <RemoteEditable
      label="LAN service address"
      value={draft}
      editing={editingServer}
      remoteMode={remoteMode}
      className={focusClass("companion-url")}
      controlRef={(element) => registerControl?.("companion-url", element)}
      onBeginEdit={() => onEditingServerChange(true)}
      renderEditor={(controlRef) => <label htmlFor="companion-url">LAN service address<input className={focusClass("companion-url")} data-settings-focus="companion-url" id="companion-url" type="url" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="http://192.168.1.50:8787" autoComplete="off" ref={(element) => { controlRef(element); registerControl?.("companion-url", element); }} /></label>}
    />
    <button className={focusClass("companion-start")} data-settings-focus="companion-start" type="button" ref={(element) => registerControl?.("companion-start", element)} onClick={() => void connect()} disabled={!playlistUrl.trim() || !draft.trim()}>{connection ? "Reconnect TV connection" : "Connect TV"}</button>
    {connection && <p className="companion-code" role="status"><span className="hint">Connected to {server}</span></p>}
    {status && <p className="hint" role="status" aria-live="polite">{status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
