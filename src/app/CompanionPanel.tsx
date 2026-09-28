import { useEffect, useRef, useState } from "react";
import { XtreamClient } from "../platform/xtream/client.ts";
import { acknowledgeCompanionEvents, companionEvents, companionSelectionTitle, companionServerUrl, connectCompanionService, type CompanionConnection } from "../platform/companion/client.ts";
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
  const [paired, setPaired] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const renewalInFlight = useRef(false);
  const retryRenewalAt = useRef(0);
  const connectInFlight = useRef(false);
  const onPlayRef = useRef(onPlay);
  const onSelectedRef = useRef(onSelected);
  const sourceFingerprint = XtreamClient.fromPlaylistUrl(playlistUrl)?.pairingFingerprint() ?? "";
  onPlayRef.current = onPlay;
  onSelectedRef.current = onSelected;

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let resolveRetry: (() => void) | undefined;
    let failures = 0;
    const pause = (ms: number) => new Promise<void>((resolve) => {
      resolveRetry = resolve;
      retryTimer = window.setTimeout(() => { retryTimer = undefined; resolveRetry = undefined; resolve(); }, ms);
    });
    const poll = async () => {
      while (!cancelled) {
        try {
          if (Date.now() >= connection.expiresAt - 120_000 && Date.now() >= retryRenewalAt.current && !renewalInFlight.current) {
            renewalInFlight.current = true;
            retryRenewalAt.current = Date.now() + 10_000;
            try { await connect(true); } finally { renewalInFlight.current = false; }
            if (!cancelled) await pause(500);
            continue;
          }
          if (!paired && Date.now() >= connection.pairingExpiresAt) {
            await connect(true);
            if (!cancelled) await pause(2_000);
            continue;
          }
          const response = await companionEvents(server, connection.tvCredential, sequence.current, { signal: controller.signal });
          failures = 0;
          setPaired(response.paired);
          if (response.retentionGap) {
            const { throughSequence, firstAvailableSequence } = response.retentionGap;
            await acknowledgeCompanionEvents(server, connection.tvCredential, throughSequence);
            sequence.current = throughSequence;
          }
          let processedThrough = sequence.current;
          for (const event of response.events) {
            const client = XtreamClient.fromPlaylistUrl(playlistUrl);
            if (!client || event.selection.sourceFingerprint !== client.pairingFingerprint()) {
              setError("The selected title belongs to a different provider connection.");
              processedThrough = event.sequence;
              continue;
            }
            const candidate = companionSelectionTitle(event.selection);
            if (!candidate) { processedThrough = event.sequence; continue; }
            const streamKind = candidate.contentType === "movie" ? "movie" : "series";
            candidate.streamUrl = client.streamUrlFor(streamKind, event.selection.id, event.selection.extension);
            if (event.action === "play") {
              setStatus(`${candidate.title} sent to TV playback.`);
              onPlayRef.current(candidate);
            } else if (onSelectedRef.current) {
              setStatus(`${candidate.title} received from companion.`);
              onSelectedRef.current(candidate);
            }
            processedThrough = event.sequence;
          }
          if (processedThrough > sequence.current) {
            await acknowledgeCompanionEvents(server, connection.tvCredential, processedThrough);
            sequence.current = processedThrough;
          }
          if (response.retentionGap) {
            setStatus(`Relay queue gap: commands through sequence ${response.retentionGap.throughSequence} expired; replay resumed at ${response.retentionGap.firstAvailableSequence}.`);
          }
        } catch (cause) {
          if (cancelled || controller.signal.aborted) break;
          failures += 1;
          const message = cause instanceof Error && cause.message === "Companion connection expired."
            ? cause.message
            : "TV connection was interrupted. Reconnecting…";
          setError(message);
          if (message === "Companion connection expired." && !renewalInFlight.current) {
            renewalInFlight.current = true;
            retryRenewalAt.current = Date.now() + 10_000;
            await pause(5_000);
            if (!cancelled) await connect(true).finally(() => { renewalInFlight.current = false; });
            continue;
          }
          await pause(companionRetryDelay(failures - 1));
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      resolveRetry?.();
    };
  }, [connection, paired, playlistUrl, server]);

  const connect = async (silent = false) => {
    if (connectInFlight.current) return;
    connectInFlight.current = true;
    if (!silent) { setError(""); setStatus("Connecting to companion service…"); }
    try {
      const normalized = new URL((silent ? server : draft).trim()).origin;
      const result = await connectCompanionService(normalized, sourceFingerprint, connection?.tvCredential);
      setServer(normalized); setConnection(result); sequence.current = 0; setPaired(false);
      setStatus("Pair this TV in the web app using the code below.");
    } catch (cause) { if (!silent) { setStatus(""); setError(cause instanceof Error ? cause.message : "Companion service connection failed."); } }
    finally { connectInFlight.current = false; }
  };

  useEffect(() => {
    if (connection || !server.trim() || !sourceFingerprint) return;
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
  }, [connection, sourceFingerprint, server]);

  return <section className="settings-section companion-panel">
    <h3>TV connection</h3>
    <p className="hint">Connect this TV, then enter its one-time pairing code in the web app to enable remote search and playback. Stream URLs stay on this TV.</p>
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
    <button className={focusClass("companion-start")} data-settings-focus="companion-start" type="button" ref={(element) => registerControl?.("companion-start", element)} onClick={() => void connect()} disabled={!sourceFingerprint || !draft.trim()}>{connection ? "Reconnect TV connection" : "Connect TV"}</button>
    {connection && <p className="companion-code" role="status"><span className="hint">Connected to {server}.{paired ? " Browser paired successfully." : " Enter this one-time code in the web app before it expires:"}</span>{!paired && <><br /><strong aria-label={`Pairing code ${connection.pairingCode}`}>{connection.pairingCode}</strong></>}</p>}
    {status && <p className="hint" role="status" aria-live="polite">{status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
