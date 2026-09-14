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
  if (activeFocus === "body") return "tab";
  if (activeFocus === "tab") return "stay";
  if (activeFocus === "tile" && selectedTileAvailable) return "tile";
  return "stay";
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
export function browseGridColumnCount(isTitleGrid: boolean, compactViewport: boolean): number {
  if (isTitleGrid) return compactViewport ? 1 : 2;
  return compactViewport ? 2 : 4;
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
