import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { normalizeLiveRelayConfig, type NormalizedLiveRelayConfig } from "../platform/live-relay/config.ts";
import type { SettingsControlKey } from "./remote-navigation.ts";
import { RemoteEditable } from "./remote-editable.tsx";
import { normalizedRemoteKey } from "../contracts/input.ts";

type Props = {
  config: NormalizedLiveRelayConfig | null;
  language: "en" | "fi";
  onSave: (config: NormalizedLiveRelayConfig) => void;
  onRemove: () => void;
  registerControl: (key: SettingsControlKey, element: HTMLElement | null) => void;
  focusClass: (key: SettingsControlKey) => string;
};

const labels = {
  en: {
    title: "Live subtitle relay (experimental)",
    description: "Hosted subtitles need a TV playback test. Timing offset is provisional and has not been validated against AVPlay. Relay playback stays off until you enable it.",
    enabled: "Enable hosted live subtitles",
    url: "Relay address",
    lan: "Allow HTTP to a private LAN IPv4 address",
    credential: "Device credential",
    credentialHint: "Saved credential: hidden. Leave blank to keep it, or enter a replacement.",
    mappings: "Channel mappings (JSON)",
    mappingsHint: 'Map provider stream IDs to relay channel IDs, for example: { "123": "channel-123" }',
    offset: "Provisional subtitle offset (ms)",
    diagnostics: "Enable relay diagnostics",
    save: "Save relay settings",
    remove: "Remove saved relay settings",
    configured: "Relay settings saved. Device credential: configured (hidden).",
    removed: "Saved relay settings removed.",
    invalid: "Could not save relay settings. Check the address, device credential, IDs, and timing offset.",
    credentialMissing: "Enter the device credential before the first save.",
  },
  fi: {
    title: "Suoran TV:n tekstitysrelay (kokeellinen)",
    description: "Hosted-tekstitys vaatii testin televisiossa. Ajoitusviivettä ei ole vielä vahvistettu AVPlaylla. Relay-toisto pysyy pois päältä, kunnes otat sen käyttöön.",
    enabled: "Ota käyttöön hosted-suoratekstitys",
    url: "Relayn osoite",
    lan: "Salli HTTP yksityiseen lähiverkon IPv4-osoitteeseen",
    credential: "Laitetunniste",
    credentialHint: "Tallennettu tunniste on piilotettu. Jätä tyhjäksi säilyttääksesi sen tai anna uusi.",
    mappings: "Kanavakytkennät (JSON)",
    mappingsHint: 'Yhdistä palvelun stream-tunniste relayn kanavatunnisteeseen, esim. { "123": "channel-123" }',
    offset: "Alustava tekstityksen viive (ms)",
    diagnostics: "Salli relayn diagnostiikka",
    save: "Tallenna relay-asetukset",
    remove: "Poista tallennetut relay-asetukset",
    configured: "Relay-asetukset tallennettu. Laitetunniste: määritetty (piilotettu).",
    removed: "Tallennetut relay-asetukset poistettu.",
    invalid: "Relay-asetusten tallennus epäonnistui. Tarkista osoite, laitetunniste, tunnisteet ja viive.",
    credentialMissing: "Anna laitetunniste ensimmäistä tallennusta varten.",
  },
} as const;

export function LiveRelaySettings({ config, language, onSave, onRemove, registerControl, focusClass }: Props) {
  const t = labels[language];
  const [enabled, setEnabled] = useState(config?.enabled === true);
  const [serviceUrl, setServiceUrl] = useState(config?.serviceUrl ?? "");
  const [allowLanHttp, setAllowLanHttp] = useState(config?.allowLanHttp === true);
  const [credential, setCredential] = useState("");
  const [mappingText, setMappingText] = useState(JSON.stringify(config?.channelMappings ?? {}, null, 2));
  const [offsetMs, setOffsetMs] = useState(String(config?.offsetMs ?? 0));
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(config?.diagnosticsEnabled !== false);
  const [status, setStatus] = useState("");
  const [editingField, setEditingField] = useState<"url" | "credential" | "mappings" | "offset" | null>(null);

  const editorKeyDown = (event: ReactKeyboardEvent<HTMLElement>, key: "url" | "credential" | "mappings" | "offset") => {
    const keyName = normalizedRemoteKey(event.nativeEvent);
    const leavingWithBack = keyName === "Back";
    if (keyName === "ArrowUp" || keyName === "ArrowDown" || leavingWithBack) {
      if (leavingWithBack) {
        event.preventDefault();
        event.stopPropagation();
      }
      setEditingField(null);
      if (leavingWithBack) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-settings-focus="relay-${key}"]`)?.focus());
    }
  };

  const handleSave = () => {
    if (!config?.deviceCredential && !credential.trim()) {
      setStatus(t.credentialMissing);
      return;
    }
    try {
      const mappings: unknown = JSON.parse(mappingText);
      const normalized = normalizeLiveRelayConfig({
        enabled,
        serviceUrl,
        allowLanHttp,
        deviceCredential: credential.trim() || config?.deviceCredential || "",
        channelMappings: mappings as Record<string, string>,
        offsetMs: Number(offsetMs),
        diagnosticsEnabled,
      });
      onSave(normalized);
      setCredential("");
      setStatus(t.configured);
    } catch {
      setStatus(t.invalid);
    }
  };

  return <section className="settings-section live-relay-settings" aria-labelledby="live-relay-settings-title">
    <h3 id="live-relay-settings-title">{t.title}</h3>
    <p className="hint">{t.description}</p>
    <label><input type="checkbox" data-settings-focus="relay-enabled" className={focusClass("relay-enabled")} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} ref={(element) => registerControl("relay-enabled", element)} /> {t.enabled}</label>
    <RemoteEditable label={t.url} value={serviceUrl} editing={editingField === "url"} className={focusClass("relay-url")} controlRef={(element) => registerControl("relay-url", element)} onBeginEdit={() => { setEditingField("url"); window.requestAnimationFrame(() => document.getElementById("live-relay-url")?.focus()); }} renderEditor={(controlRef) => <label htmlFor="live-relay-url">{t.url}<input id="live-relay-url" data-settings-focus="relay-url" className={focusClass("relay-url")} type="url" value={serviceUrl} placeholder="https://relay.example.test" autoComplete="url" onChange={(event) => setServiceUrl(event.target.value)} onKeyDown={(event) => editorKeyDown(event, "url")} ref={(element) => { registerControl("relay-url", element); controlRef(element); }} /></label>} />
    <label><input type="checkbox" data-settings-focus="relay-allow-http" className={focusClass("relay-allow-http")} checked={allowLanHttp} onChange={(event) => setAllowLanHttp(event.target.checked)} ref={(element) => registerControl("relay-allow-http", element)} /> {t.lan}</label>
    <RemoteEditable label={t.credential} value={credential ? "Entered (hidden)" : config?.deviceCredential ? "Configured (hidden)" : "Not configured"} editing={editingField === "credential"} className={focusClass("relay-credential")} controlRef={(element) => registerControl("relay-credential", element)} onBeginEdit={() => { setEditingField("credential"); window.requestAnimationFrame(() => document.getElementById("live-relay-credential")?.focus()); }} renderEditor={(controlRef) => <label htmlFor="live-relay-credential">{t.credential}<input id="live-relay-credential" data-settings-focus="relay-credential" className={focusClass("relay-credential")} type="password" value={credential} placeholder={config?.deviceCredential ? "•••••••• (saved)" : "64-character device credential"} autoComplete="new-password" onChange={(event) => setCredential(event.target.value)} onKeyDown={(event) => editorKeyDown(event, "credential")} ref={(element) => { registerControl("relay-credential", element); controlRef(element); }} /></label>} />
    <p className="hint">{t.credentialHint}</p>
    <RemoteEditable label={t.mappings} value={mappingText ? "Custom channel mappings" : "No mappings"} editing={editingField === "mappings"} className={focusClass("relay-mappings")} controlRef={(element) => registerControl("relay-mappings", element)} onBeginEdit={() => { setEditingField("mappings"); window.requestAnimationFrame(() => document.getElementById("live-relay-mappings")?.focus()); }} renderEditor={(controlRef) => <label htmlFor="live-relay-mappings">{t.mappings}<textarea id="live-relay-mappings" data-settings-focus="relay-mappings" className={focusClass("relay-mappings")} rows={4} value={mappingText} onChange={(event) => setMappingText(event.target.value)} onKeyDown={(event) => editorKeyDown(event, "mappings")} ref={(element) => { registerControl("relay-mappings", element); controlRef(element); }} /></label>} />
    <p className="hint">{t.mappingsHint}</p>
    <RemoteEditable label={t.offset} value={`${offsetMs} ms`} editing={editingField === "offset"} className={focusClass("relay-offset")} controlRef={(element) => registerControl("relay-offset", element)} onBeginEdit={() => { setEditingField("offset"); window.requestAnimationFrame(() => document.getElementById("live-relay-offset")?.focus()); }} renderEditor={(controlRef) => <label htmlFor="live-relay-offset">{t.offset}<input id="live-relay-offset" data-settings-focus="relay-offset" className={focusClass("relay-offset")} type="number" min="-10000" max="10000" step="100" value={offsetMs} onChange={(event) => setOffsetMs(event.target.value)} onKeyDown={(event) => editorKeyDown(event, "offset")} ref={(element) => { registerControl("relay-offset", element); controlRef(element); }} /></label>} />
    <label><input type="checkbox" data-settings-focus="relay-diagnostics" className={focusClass("relay-diagnostics")} checked={diagnosticsEnabled} onChange={(event) => setDiagnosticsEnabled(event.target.checked)} ref={(element) => registerControl("relay-diagnostics", element)} /> {t.diagnostics}</label>
    <div className="settings-actions">
      <button className={focusClass("relay-save")} data-settings-focus="relay-save" type="button" onClick={handleSave} ref={(element) => registerControl("relay-save", element)}>{t.save}</button>
      <button className={`quiet-danger ${focusClass("relay-remove")}`} data-settings-focus="relay-remove" type="button" onClick={() => { onRemove(); setCredential(""); setStatus(t.removed); }} ref={(element) => registerControl("relay-remove", element)}>{t.remove}</button>
    </div>
    {status && <p className="hint" role="status" aria-live="polite">{status}</p>}
  </section>;
}
