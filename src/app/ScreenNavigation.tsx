import { useContext, type Ref } from "react";
import { LanguageContext, Localized } from "./language.tsx";

export type ScreenNavigationProps = {
  onPrevious?: (() => void) | undefined;
  previousLabel?: string | undefined;
  onMainMenu(): void;
  previousRef?: Ref<HTMLButtonElement>;
  mainMenuRef?: Ref<HTMLButtonElement>;
};

/** Shared remote-friendly header actions used by Live TV and VOD screens. */
export function ScreenNavigation({ onPrevious, previousLabel = "Back", onMainMenu, previousRef, mainMenuRef }: ScreenNavigationProps) {
  const { language } = useContext(LanguageContext);
  return <Localized language={language}><nav className="header-actions screen-navigation" aria-label="Screen navigation">
    {onPrevious && <button type="button" ref={previousRef} onClick={onPrevious}>{previousLabel}</button>}
    <button type="button" ref={mainMenuRef} onClick={onMainMenu}>Main menu</button>
  </nav></Localized>;
}
