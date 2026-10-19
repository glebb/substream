import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { groupLiveCategoriesByCountry, liveCountryLabel, type LiveCategory } from "../core/live/index.ts";
import { liveCacheKey, safeCache } from "../application/live-cache.ts";
import { createDeviceSettings } from "../bootstrap/settings.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { providerRequestUrl } from "../platform/provider-request.ts";
import { pickerGridNavigationTarget, type SettingsControlKey } from "./remote-navigation.ts";
import { isBackKey, normalizedRemoteKey } from "../contracts/input.ts";
import { useRuntime } from "./runtime.tsx";
import { LanguageContext, Localized, translate } from "./language.tsx";

type Props = {
  registerControl: (key: SettingsControlKey, element: HTMLElement | null) => void;
  focusClass: (key: SettingsControlKey) => string;
};

type CountryOption = { country: string; label: string; categoryCount: number };

/** Chooses which provider countries Live TV lists. Provider requests go directly from this device. */
export function LiveCountrySettings({ registerControl, focusClass }: Props) {
  const runtime = useRuntime();
  const { language } = useContext(LanguageContext);
  const settings = useMemo(() => createDeviceSettings(runtime.preferences), [runtime.preferences]);
  const [countries, setCountries] = useState(() => settings.loadLiveCountries());
  const [open, setOpen] = useState(false);
  // Countries selected when the picker opened are listed first and keep their place while it is open.
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [categories, setCategories] = useState<LiveCategory[] | null>(null);
  const [status, setStatus] = useState("");
  const client = useMemo(() => XtreamClient.fromPlaylistUrl(settings.loadPlaylistUrl(), (url, init) => runtime.transport.fetch(providerRequestUrl(url), init)), [settings, runtime.transport]);

  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    const saved = safeCache(runtime.preferences, liveCacheKey(client))?.categories;
    if (saved?.length) setCategories(saved);
    else setStatus("Loading countries from the provider…");
    void client.liveCategories().then((fresh) => {
      if (cancelled) return;
      setCategories(fresh);
      setStatus("");
    }).catch(() => {
      if (!cancelled && !saved?.length) setStatus("Countries could not be loaded. Check the TV network and playlist settings.");
    });
    return () => { cancelled = true; };
  }, [client, open, runtime.preferences]);

  const options = useMemo<CountryOption[]>(() => {
    const available = groupLiveCategoriesByCountry(categories ?? []).map((group) => ({ country: group.country, label: group.label, categoryCount: group.categories.length }));
    // Keep saved countries the provider no longer lists, so they can still be removed.
    const missing = countries.filter((country) => !available.some((option) => option.country === country))
      .map((country) => ({ country, label: liveCountryLabel(country), categoryCount: 0 }));
    const all = [...available, ...missing];
    return [...all.filter((option) => pinned.includes(option.country)), ...all.filter((option) => !pinned.includes(option.country))];
  }, [categories, countries, pinned]);

  const focusItem = (index: number) => {
    setFocusIndex(index);
    itemRefs.current[index]?.focus();
  };
  const openPicker = () => {
    setPinned(countries);
    setFocusIndex(0);
    setOpen(true);
    window.requestAnimationFrame(() => (itemRefs.current[0] ?? doneRef.current)?.focus());
  };
  const closePicker = () => {
    setOpen(false);
    window.requestAnimationFrame(() => openButtonRef.current?.focus());
  };
  // The options wrap to fit the screen, so the column count is read from the rendered first row.
  const columnCount = () => {
    const items = itemRefs.current.filter((item): item is HTMLInputElement => Boolean(item));
    const firstTop = items[0]?.parentElement?.offsetTop;
    const columns = items.filter((item) => item.parentElement?.offsetTop === firstTop).length;
    return Math.max(1, columns);
  };
  // The dialog owns remote keys while open, so Settings navigation never walks the checkboxes.
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const native = event.nativeEvent;
    const key = normalizedRemoteKey(native);
    if (isBackKey(native)) { event.preventDefault(); event.stopPropagation(); closePicker(); return; }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    const active = document.activeElement;
    if (active === doneRef.current) {
      if (key === "Enter") closePicker();
      else if (key === "ArrowDown" && options.length) focusItem(Math.min(focusIndex, options.length - 1));
      return;
    }
    const index = itemRefs.current.indexOf(active as HTMLInputElement);
    if (index < 0) { if (options.length) focusItem(0); else doneRef.current?.focus(); return; }
    if (key === "Enter") { itemRefs.current[index]?.click(); return; }
    const target = pickerGridNavigationTarget(key, index, options.length, columnCount());
    if (target === "header") doneRef.current?.focus();
    else if (target !== null) focusItem(target);
  };

  const toggle = (country: string, enabled: boolean) => {
    const next = enabled ? [...countries.filter((item) => item !== country), country] : countries.filter((item) => item !== country);
    if (!next.length) { setStatus("Choose at least one country."); return; }
    const saved = settings.saveLiveCountries(next);
    setCountries(saved);
    setStatus(saved.join() === next.join() ? "" : "The country selection could not be saved. Device storage may be full.");
  };

  const summary = countries.map((country) => translate(liveCountryLabel(country), language)).join(", ");
  return <Localized language={language}><section className="settings-section live-country-settings" aria-labelledby="live-country-settings-title">
    <h3 id="live-country-settings-title">Live TV countries</h3>
    <p className="hint">{countries.length > 1 ? "Live TV asks you to choose a country first." : "Live TV opens this country's categories directly."}</p>
    <p className="hint">{summary}</p>
    <button className={focusClass("live-countries-edit")} data-settings-focus="live-countries-edit" type="button" aria-haspopup="dialog" disabled={!client} ref={(element) => { openButtonRef.current = element; registerControl("live-countries-edit", element); }} onClick={openPicker}>Choose countries</button>
    {!client && <p className="hint">Live TV requires an Xtream-compatible playlist in Settings.</p>}
    {!open && status && <p className="hint" role="status" aria-live="polite">{status}</p>}
    {open && client && <div className="modal-backdrop"><section className="live-country-dialog modal-panel" role="dialog" aria-modal="true" aria-labelledby="live-country-dialog-title" onKeyDown={onDialogKeyDown}>
      <div className="live-country-dialog-header">
        <div><h3 id="live-country-dialog-title">Live TV countries</h3><p className="hint">{summary}</p></div>
        <button type="button" ref={doneRef} onClick={closePicker}>Done</button>
      </div>
      {status && <p className="hint" role="status" aria-live="polite">{status}</p>}
      <div className="live-country-options">
        {options.map((option, index) => <label key={option.country} className={index === focusIndex ? "is-focused" : ""}><input type="checkbox" checked={countries.includes(option.country)} onFocus={() => setFocusIndex(index)} onChange={(event) => toggle(option.country, event.target.checked)} ref={(element) => { itemRefs.current[index] = element; }} /> <span>{option.label}</span>{option.categoryCount ? ` (${option.categoryCount})` : ""}</label>)}
      </div>
    </section></div>}
  </section></Localized>;
}
