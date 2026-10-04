import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { LanguageContext, Localized, translate } from "./language.tsx";

export interface RemoteEditableProps {
  label: string;
  value: string;
  /** Provider titles and user text must stay verbatim. */
  translateValue?: boolean;
  editing: boolean;
  className?: string;
  controlRef: (element: HTMLElement | null) => void;
  /** Keep native controls directly editable in a browser while gating them on TV. */
  remoteMode?: boolean;
  onBeginEdit: () => void;
  renderEditor: (ref: (element: HTMLElement | null) => void) => ReactNode;
}

/**
 * A stable remote destination for an input-like value.  Directional focus
 * lands on the button; the native editor is mounted only after an explicit
 * Action/Enter, which prevents Samsung's IME from opening during navigation.
 */
export function RemoteEditable({ label, value, translateValue = true, editing, className = "", controlRef, remoteMode = true, onBeginEdit, renderEditor }: RemoteEditableProps) {
  const { language } = useContext(LanguageContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const previousEditingRef = useRef(editing);
  const registerControl = (element: HTMLElement | null) => {
    elementRef.current = element;
    controlRef(element);
  };
  useLayoutEffect(() => {
    const changed = previousEditingRef.current !== editing;
    previousEditingRef.current = editing;
    // Swapping a trigger for its editor removes the focused DOM node. Restore
    // focus after React mounts its replacement, preserving an arrow's move
    // to another control when the user leaves editing that way.
    if (remoteMode && changed && (editing || document.activeElement === document.body)) elementRef.current?.focus();
  }, [editing, remoteMode]);
  if (!remoteMode) return <Localized language={language}>{renderEditor(controlRef)}</Localized>;
  if (editing) return <Localized language={language}>{renderEditor(registerControl)}</Localized>;
  return <Localized language={language}><button
    className={`remote-editable-trigger ${className}`.trim()}
    type="button"
    aria-label={`${translate("Edit", language)} ${translate(label, language)}${value ? `, ${translate("current value", language)} ${translateValue ? translate(value, language) : value}` : ""}`}
    ref={registerControl}
    onClick={onBeginEdit}
  >{label}: {value ? <span translate={translateValue ? undefined : "no"}>{value}</span> : "Not set"}</button></Localized>;
}
