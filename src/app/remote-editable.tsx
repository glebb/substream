import { useContext, type ReactNode } from "react";
import { LanguageContext, Localized } from "./language.tsx";

export interface RemoteEditableProps {
  label: string;
  value: string;
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
export function RemoteEditable({ label, value, editing, className = "", controlRef, remoteMode = true, onBeginEdit, renderEditor }: RemoteEditableProps) {
  const { language } = useContext(LanguageContext);
  if (!remoteMode) return <Localized language={language}>{renderEditor(controlRef)}</Localized>;
  if (editing) return <Localized language={language}>{renderEditor(controlRef)}</Localized>;
  return <Localized language={language}><button
    className={`remote-editable-trigger ${className}`.trim()}
    type="button"
    aria-label={`Edit ${label}${value ? `, current value ${value}` : ""}`}
    ref={controlRef}
    onClick={onBeginEdit}
  >{label}: {value || "Not set"}</button></Localized>;
}
