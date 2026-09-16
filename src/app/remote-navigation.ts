export type AppBackAction =
  | "cancel-settings-confirmation"
  | "close-resume-choice"
  | "close-settings"
  | "close-playlist-form"
  | "exit-fullscreen"
  | "close-player"
  | "close-group"
  | "cancel-browse-loading"
  | "stay";

export interface AppBackContext {
  settingsConfirmationOpen: boolean;
  resumeChoiceOpen: boolean;
  settingsOpen: boolean;
  playlistFormOpen: boolean;
  errorFormOpen: boolean;
  selectedTitle: boolean;
  playerFullscreen: boolean;
  activeGroup: boolean;
  browseLoading: boolean;
}

/** Resolves the topmost app screen that should consume the remote Back action. */
export function resolveAppBackAction(context: AppBackContext): AppBackAction {
  if (context.settingsConfirmationOpen) return "cancel-settings-confirmation";
  if (context.resumeChoiceOpen) return "close-resume-choice";
  if (context.settingsOpen) return "close-settings";
  if (context.selectedTitle) return context.playerFullscreen ? "exit-fullscreen" : "close-player";
  if (context.playlistFormOpen && !context.errorFormOpen) return "close-playlist-form";
  if (context.activeGroup) return "close-group";
  if (context.browseLoading) return "cancel-browse-loading";
  if (context.errorFormOpen) return "close-playlist-form";
  return "stay";
}

/** Down from Settings returns focus to the selected browse tab. */
export function dashboardControlNavigationTarget(key: string, settingsIsFocused: boolean): "tabs" | null {
  return key === "ArrowDown" && settingsIsFocused ? "tabs" : null;
}

/** Keeps keyboard focus synchronized with home-grid movement without stealing it from the tab row. */
export function homeBrowseFocusTarget(activeFocus: "body" | "tab" | "tile" | "other", selectedTileAvailable: boolean): "tab" | "tile" | "stay" {
  // On the initial ready render the browser may still have body focus.  If
  // content is already mounted, put real DOM focus on the same first tile
  // that the remote-selected state paints; otherwise fall back to the tab.
  if (activeFocus === "body") return selectedTileAvailable ? "tile" : "tab";
  if (activeFocus === "tab") return "stay";
  if (activeFocus === "tile" && selectedTileAvailable) return "tile";
  return "stay";
}

/**
 * Resolves the first usable focus target after a browse tab transition.  The
 * returned value is deliberately DOM-agnostic so the same fallback contract
 * can be used by the browser and Tizen renderers.
 */
export function browseCollectionFocusTarget(hasContent: boolean, hasRecoveryAction: boolean): "content" | "recovery" | "tab" {
  if (hasContent) return "content";
  if (hasRecoveryAction) return "recovery";
  return "tab";
}

/** Returns the collection item index represented by a content focus target. */
export function browseCollectionFocusIndex(target: "content" | "recovery" | "tab", itemCount: number, preferredIndex = 0): number | null {
  if (target !== "content" || itemCount <= 0) return null;
  return Math.max(0, Math.min(itemCount - 1, preferredIndex));
}

export type RemoteEditableKeyAction = "enter-edit" | "leave-edit" | "navigate" | "ignore";

/**
 * Stable logical identifiers for the controls on the Settings screen.  The
 * rendered controls are conditional (for example, the OpenSubtitles editor
 * replaces its trigger), so navigation must be keyed by identity rather than
 * by an array slot that can shift between renders.
 */
export type SettingsControlKey =
  | "back"
  | "playlist"
  | "subtitle-language"
  | "api-key-input"
  | "api-key-edit"
  | "api-key-save"
  | "api-key-cancel"
  | "remove-api-key"
  | "tmdb-token-input"
  | "tmdb-key-input"
  | "tmdb-save"
  | "tmdb-cancel"
  | "clear-catalog"
  | "reset-all"
  | "confirm-cancel"
  | "confirm-confirm";

export interface SettingsControlOrderOptions {
  confirmationOpen: boolean;
  apiKeyEditorOpen: boolean;
  hasSubtitleKey: boolean;
}

/** Returns visible Settings controls in their logical DOM order. */
export function settingsControlOrder(options: SettingsControlOrderOptions): SettingsControlKey[] {
  if (options.confirmationOpen) return ["confirm-cancel", "confirm-confirm"];

  return [
    "back",
    "playlist",
    "subtitle-language",
    ...(options.apiKeyEditorOpen ? ["api-key-input", "api-key-save", "api-key-cancel"] as const : ["api-key-edit"] as const),
    ...(options.hasSubtitleKey ? ["remove-api-key"] as const : []),
    "tmdb-token-input",
    "tmdb-key-input",
    "tmdb-save",
    "tmdb-cancel",
    "clear-catalog",
    "reset-all",
  ];
}

/**
 * Directional keys only navigate between remote controls.  Text entry starts
 * explicitly with Action/Enter and Up/Down leave editing without summoning a
 * keyboard as a side effect of merely landing on a field.
 */
export function remoteEditableKeyAction(key: string, editing: boolean, tizen = true): RemoteEditableKeyAction {
  if ((tizen && key === "Enter") || (!tizen && (key === "Enter" || key === " "))) return editing ? "ignore" : "enter-edit";
  if (editing && (key === "ArrowUp" || key === "ArrowDown" || key === "Back")) return "leave-edit";
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return "navigate";
  return "ignore";
}

/** Chooses a focusable fallback while content is loading or conditionally mounted. */
export function focusFallback<T>(controls: readonly (T | null | undefined)[], preferredIndex = 0): T | undefined {
  if (!controls.length) return undefined;
  const bounded = Math.max(0, Math.min(controls.length - 1, preferredIndex));
  return controls[bounded] ?? controls.find((control): control is T => control !== null && control !== undefined);
}

/** Returns a same-row/same-column destination; null means the directional edge was reached. */
export function gridNavigationTarget(key: string, currentIndex: number, itemCount: number, columnCount: number): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount || columnCount <= 0) return null;
  const rowStart = Math.floor(currentIndex / columnCount) * columnCount;
  const rowEnd = Math.min(itemCount - 1, rowStart + columnCount - 1);
  if (key === "ArrowLeft") return currentIndex > rowStart ? currentIndex - 1 : null;
  if (key === "ArrowRight") return currentIndex < rowEnd ? currentIndex + 1 : null;
  if (key === "ArrowUp") return currentIndex >= columnCount ? currentIndex - columnCount : null;
  if (key === "ArrowDown") return currentIndex + columnCount < itemCount ? currentIndex + columnCount : null;
  return null;
}

/** Mirrors the explicit app.css responsive grid breakpoints without parsing computed CSS. */
export function browseGridColumnCount(isTitleGrid: boolean, compactViewport: boolean, narrowViewport = false): number {
  if (isTitleGrid) return compactViewport ? 1 : 2;
  if (narrowViewport) return 1;
  return compactViewport ? 2 : 4;
}

/**
 * Continue-watching movement treats each title's Resume and Remove controls as
 * one logical row. The returned index still addresses the interleaved DOM
 * controls (Resume, Remove, Resume, Remove), so both web and TV can share it.
 */
export function recentNavigationTarget(key: string, currentIndex: number, itemCount: number): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount || itemCount % 2 !== 0) return null;
  const isResume = currentIndex % 2 === 0;
  if (key === "ArrowLeft") return isResume ? null : currentIndex - 1;
  if (key === "ArrowRight") return isResume ? currentIndex + 1 : null;
  if (key === "ArrowUp") return currentIndex >= 2 ? currentIndex - 2 : null;
  if (key === "ArrowDown") return currentIndex + 2 < itemCount ? currentIndex + 2 : null;
  return null;
}

export const TITLE_LIST_PAGE_STRIDE = 8;

/** Title-list movement: horizontal steps visit neighbors; vertical steps advance one visible-page stride. */
export function titleListNavigationTarget(key: string, currentIndex: number, itemCount: number, pageStride = TITLE_LIST_PAGE_STRIDE): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount || pageStride <= 0) return null;
  if (key === "ArrowLeft") return currentIndex > 0 ? currentIndex - 1 : null;
  if (key === "ArrowRight") return currentIndex + 1 < itemCount ? currentIndex + 1 : null;
  if (key === "ArrowUp") return currentIndex > 0 ? Math.max(0, currentIndex - pageStride) : null;
  if (key === "ArrowDown") return currentIndex < itemCount - 1 ? Math.min(itemCount - 1, currentIndex + pageStride) : null;
  return null;
}

export function titleListPageBoundaryTarget(key: string, currentIndex: number, itemCount: number, page: number, pageCount: number): { page: number; focusAtEnd: boolean } | null {
  if (itemCount <= 0 || page < 0 || page >= pageCount) return null;
  if (key === "ArrowRight" && currentIndex === itemCount - 1 && page + 1 < pageCount) return { page: page + 1, focusAtEnd: false };
  if (key === "ArrowLeft" && currentIndex === 0 && page > 0) return { page: page - 1, focusAtEnd: true };
  return null;
}

/** Moves through a row of dialog actions without letting focus escape the dialog. */
export function actionRowNavigationTarget(key: string, currentIndex: number, itemCount: number): number | null {
  if (itemCount <= 0 || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(key)) return null;
  const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
  return Math.max(0, Math.min(itemCount - 1, currentIndex + delta));
}

/** Lets editable player controls retain typing and cursor keys, while Up/Down leave the field on a TV remote. */
export function playerTextEntryNavigationKey(key: string): boolean {
  return key === "ArrowUp" || key === "ArrowDown";
}

export interface PlayerPlaybackShortcutContext {
  /** The video area currently owns player focus. */
  videoActive: boolean;
  /** The player is in its fullscreen presentation. */
  fullscreen: boolean;
  /** An input or select currently owns focus. */
  editableTarget: boolean;
  /** Tizen uses the remote Action/Enter key; web uses the Space key. */
  tizen: boolean;
}

/**
 * Determines whether a player shortcut should toggle playback. Fullscreen
 * intentionally wins over focus so the TV Action key and web Space key still
 * work while the fullscreen controls are visible.
 */
export function isPlayerPlaybackShortcut(key: string, context: PlayerPlaybackShortcutContext): boolean {
  const shortcutKey = context.tizen
    ? key === "Enter"
    : key === " " || key === "Space" || key === "Spacebar";
  if (!shortcutKey) return false;
  if (context.fullscreen) return true;
  return context.videoActive && !context.editableTarget;
}

export interface SubtitleFocusLayoutOptions {
  subtitleAttached: boolean;
  timingAvailable: boolean;
  apiKeyConfigured: boolean;
  apiKeyEditorOpen: boolean;
  seriesSearch: boolean;
}

/** Keeps conditionally rendered player subtitle controls and result indexes aligned. */
export function subtitleFocusLayout(options: SubtitleFocusLayoutOptions) {
  const subtitleToggle = 9;
  const timingStart = subtitleToggle + (options.subtitleAttached ? 1 : 0);
  const keyActionStart = timingStart + (options.timingAvailable ? 4 : 0);
  const keyInput = !options.apiKeyConfigured && options.apiKeyEditorOpen ? keyActionStart : null;
  const saveKey = keyInput === null ? null : keyInput + 1;
  const setupKey = !options.apiKeyConfigured && !options.apiKeyEditorOpen ? keyActionStart : null;
  const search = keyActionStart + (options.apiKeyConfigured ? 0 : options.apiKeyEditorOpen ? 2 : 1);
  const searchType = search + 1;
  const season = searchType + 1;
  const episode = season + 1;
  const find = searchType + 1 + (options.seriesSearch ? 2 : 0);
  return {
    subtitleToggle,
    timingStart,
    keyInput,
    saveKey,
    setupKey,
    search,
    searchType,
    season,
    episode,
    find,
    firstResult: find + 1,
  };
}
