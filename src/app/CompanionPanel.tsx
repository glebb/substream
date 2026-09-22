import { useEffect, useRef, useState } from "react";
import { XtreamClient } from "../platform/xtream/client.ts";
import { companionEvents, companionSelectionTitle, companionServerUrl, connectCompanionService, type CompanionConnection } from "../platform/companion/client.ts";
import type { VodCatalogItem } from "../core/catalog/index.ts";
import type { SettingsControlKey } from "./remote-navigation.ts";
import { RemoteEditable } from "./remote-editable.tsx";

type CompanionPanelProps = {
  playlistUrl: string;
  onSelected: (title: VodCatalogItem) => void;
  editingServer: boolean;
  onEditingServerChange: (editing: boolean) => void;
  remoteMode: boolean;
  registerControl?: (key: SettingsControlKey, element: HTMLElement | null) => void;
  focusClass?: (key: SettingsControlKey) => string;
};

/** TV-side LAN companion connection. Only a provider item ID crosses back from the companion. */
export function CompanionPanel({ playlistUrl, onSelected, editingServer, onEditingServerChange, remoteMode, registerControl, focusClass = () => "" }: CompanionPanelProps) {
  const [server, setServer] = useState(companionServerUrl());
  const [draft, setDraft] = useState(companionServerUrl());
  const [connection, setConnection] = useState<CompanionConnection | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const events = await companionEvents(server, connection.sessionId, sequence.current);
        for (const event of events) {
          sequence.current = Math.max(sequence.current, event.sequence);
          const client = XtreamClient.fromPlaylistUrl(playlistUrl);
          if (!client || event.selection.sourceFingerprint !== client.sourceFingerprint()) {
            setError("The selected title belongs to a different provider connection.");
            continue;
          }
          const candidate = companionSelectionTitle(event.selection);
          if (!candidate) continue;
          if (candidate.contentType === "movie") candidate.streamUrl = client.streamUrlFor("movie", event.selection.id, event.selection.extension);
          setStatus(`${candidate.title} received from companion.`);
          onSelected(candidate);
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Companion service connection failed."); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connection, onSelected, playlistUrl, server]);

  const connect = async (silent = false) => {
    if (!silent) { setError(""); setStatus("Connecting to companion service…"); }
    try {
      const normalized = new URL(draft.trim()).origin;
      const result = await connectCompanionService(normalized, playlistUrl);
      setServer(normalized); setConnection(result); sequence.current = 0;
      setStatus("Companion service connected. Open its address on a phone or computer.");
    } catch (cause) { if (!silent) { setStatus(""); setError(cause instanceof Error ? cause.message : "Companion service connection failed."); } }
  };

  useEffect(() => {
    if (server && playlistUrl.trim()) void connect(true);
  // Startup is deliberately best-effort: Settings provides the manual retry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <section className="settings-section companion-panel">
    <h3>Companion search</h3>
    <p className="hint">Search the full Xtream catalogue from a phone or computer. Credentials and stream URLs stay local to this TV and LAN service.</p>
    <RemoteEditable
      label="LAN companion address"
      value={draft}
      editing={editingServer}
      remoteMode={remoteMode}
      className={focusClass("companion-url")}
      controlRef={(element) => registerControl?.("companion-url", element)}
      onBeginEdit={() => onEditingServerChange(true)}
      renderEditor={(controlRef) => <label htmlFor="companion-url">LAN companion address<input className={focusClass("companion-url")} data-settings-focus="companion-url" id="companion-url" type="url" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="http://192.168.1.50:8787" autoComplete="off" ref={(element) => { controlRef(element); registerControl?.("companion-url", element); }} /></label>}
    />
    <button className={focusClass("companion-start")} data-settings-focus="companion-start" type="button" ref={(element) => registerControl?.("companion-start", element)} onClick={() => void connect()} disabled={!playlistUrl.trim() || !draft.trim()}>{connection ? "Reconnect companion service" : "Connect companion service"}</button>
    {connection && <p className="companion-code" role="status"><span className="hint">Companion: {server}/companion.html</span></p>}
    {status && <p className="hint" role="status" aria-live="polite">{status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
