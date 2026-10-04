import { useContext, useState } from "react";
import type { SettingsControlKey } from "./remote-navigation.ts";
import { RemoteEditable } from "./remote-editable.tsx";
import { LanguageContext, Localized } from "./language.tsx";
import { useCompanion, useCompanionSnapshot } from "./companion.tsx";

export { companionRetryDelay } from "../application/companion-controller.ts";

type CompanionPanelProps = {
  editingServer: boolean;
  onEditingServerChange: (editing: boolean) => void;
  remoteMode: boolean;
  registerControl?: (key: SettingsControlKey, element: HTMLElement | null) => void;
  focusClass?: (key: SettingsControlKey) => string;
};

/** Settings view only; the application owns registration, polling and commands. */
export function CompanionPanel({ editingServer, onEditingServerChange, remoteMode, registerControl, focusClass = () => "" }: CompanionPanelProps) {
  const { language } = useContext(LanguageContext);
  const companion = useCompanion();
  const snapshot = useCompanionSnapshot();
  const [draft, setDraft] = useState(snapshot.server);
  const [error, setError] = useState("");
  const connect = () => {
    try { companion.connect(draft); setError(""); }
    catch { setError("Enter a valid companion service address without credentials."); }
  };
  return <Localized language={language}><section className="settings-section companion-panel">
    <h3>TV connection</h3>
    <p className="hint">Connect this TV, then pair its one-time code in the web app. The companion is optional for ordinary TV playback.</p>
    <label><input type="checkbox" checked={companion.enabled} onChange={(event) => companion.setEnabled(event.target.checked)}
      className={focusClass("companion-enabled")} data-settings-focus="companion-enabled"
      ref={(element) => registerControl?.("companion-enabled", element)} /> Enable companion connection</label>
    <RemoteEditable label="LAN service address" value={draft} editing={editingServer} remoteMode={remoteMode}
      className={focusClass("companion-url")} controlRef={(element) => registerControl?.("companion-url", element)}
      onBeginEdit={() => onEditingServerChange(true)}
      renderEditor={(controlRef) => <label htmlFor="companion-url">LAN service address<input className={focusClass("companion-url")}
        data-settings-focus="companion-url" type="url" id="companion-url" value={draft} onChange={(event) => setDraft(event.target.value)}
        placeholder="http://192.168.1.50:8787" autoComplete="off" ref={(element) => { controlRef(element); registerControl?.("companion-url", element); }} /></label>} />
    <button className={focusClass("companion-start")} data-settings-focus="companion-start" type="button"
      ref={(element) => registerControl?.("companion-start", element)}
      onClick={() => void (snapshot.paired && snapshot.state === "available" ? companion.controller.resetPairing() : connect())}
      disabled={!draft.trim()}>{snapshot.state === "available" ? snapshot.paired ? "Reset browser pairing" : "Reconnect TV connection" : "Connect TV"}</button>
    {snapshot.state === "available" && <p className="companion-code" role="status"><span className="hint">Connected to {snapshot.server}.{snapshot.paired ? " Browser paired successfully." : " Enter this one-time code in the web app before it expires:"}</span>
      {!snapshot.paired && <><br /><strong aria-label={`Pairing code ${snapshot.pairingCode}`}>{snapshot.pairingCode}</strong></>}</p>}
    {snapshot.status && <p className="hint" role="status" aria-live="polite">{snapshot.status}</p>}
    {(error || snapshot.error) && <p className="error" role="alert">{error || snapshot.error}</p>}
  </section></Localized>;
}
