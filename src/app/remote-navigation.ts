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

/** Settings sits above the home dashboard and is the Up destination of its first row. */
export function homeGridNavigationTarget(key: string, focusIndex: number): "settings" | null {
  return key === "ArrowUp" && focusIndex >= 0 && focusIndex < 4 ? "settings" : null;
}

/** Down from the Settings control returns focus to the dashboard grid. */
export function dashboardControlNavigationTarget(key: string, settingsIsFocused: boolean): "grid" | null {
  return key === "ArrowDown" && settingsIsFocused ? "grid" : null;
}
