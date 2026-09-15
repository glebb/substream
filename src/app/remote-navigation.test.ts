import { describe, expect, it } from "vitest";
import { actionRowNavigationTarget, browseGridColumnCount, dashboardControlNavigationTarget, gridNavigationTarget, homeBrowseFocusTarget, isPlayerPlaybackShortcut, playerTextEntryNavigationKey, recentNavigationTarget, resolveAppBackAction, subtitleFocusLayout, titleListNavigationTarget, titleListPageBoundaryTarget } from "./remote-navigation.ts";

describe("remote dashboard navigation", () => {
  it("follows selected home tiles while preserving tab-row focus", () => {
    expect(homeBrowseFocusTarget("tile", true)).toBe("tile");
    expect(homeBrowseFocusTarget("tab", true)).toBe("stay");
    expect(homeBrowseFocusTarget("body", false)).toBe("tab");
    expect(homeBrowseFocusTarget("other", true)).toBe("stay");
  });

  it("moves from the first grid item and stops at row and list boundaries", () => {
    expect(gridNavigationTarget("ArrowRight", 0, 7, 4)).toBe(1);
    expect(gridNavigationTarget("ArrowDown", 0, 7, 4)).toBe(4);
    expect(gridNavigationTarget("ArrowLeft", 0, 7, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowUp", 0, 7, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowRight", 3, 7, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowDown", 4, 7, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowRight", 6, 7, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowDown", 0, 2, 2)).toBeNull();
  });

  it("uses explicit responsive home-grid column counts", () => {
    expect(browseGridColumnCount(false, false)).toBe(4);
    expect(browseGridColumnCount(false, true)).toBe(2);
    expect(browseGridColumnCount(false, true, true)).toBe(1);
    expect(browseGridColumnCount(true, false)).toBe(2);
    expect(browseGridColumnCount(true, true)).toBe(1);
    expect(browseGridColumnCount(true, true, true)).toBe(1);
  });

  it("moves through a narrow one-column home grid", () => {
    expect(gridNavigationTarget("ArrowUp", 0, 5, 1)).toBeNull();
    expect(gridNavigationTarget("ArrowDown", 0, 5, 1)).toBe(1);
    expect(gridNavigationTarget("ArrowDown", 2, 5, 1)).toBe(3);
    expect(gridNavigationTarget("ArrowDown", 4, 5, 1)).toBeNull();
    expect(gridNavigationTarget("ArrowLeft", 2, 5, 1)).toBeNull();
    expect(gridNavigationTarget("ArrowRight", 2, 5, 1)).toBeNull();
  });

  it("moves Continue Watching one title at a time and switches only within each pair", () => {
    expect(recentNavigationTarget("ArrowDown", 0, 6)).toBe(2);
    expect(recentNavigationTarget("ArrowDown", 1, 6)).toBe(3);
    expect(recentNavigationTarget("ArrowUp", 4, 6)).toBe(2);
    expect(recentNavigationTarget("ArrowUp", 5, 6)).toBe(3);
    expect(recentNavigationTarget("ArrowUp", 0, 6)).toBeNull();
    expect(recentNavigationTarget("ArrowUp", 1, 6)).toBeNull();
    expect(recentNavigationTarget("ArrowDown", 4, 6)).toBeNull();
    expect(recentNavigationTarget("ArrowDown", 5, 6)).toBeNull();
    expect(recentNavigationTarget("ArrowRight", 0, 6)).toBe(1);
    expect(recentNavigationTarget("ArrowLeft", 1, 6)).toBe(0);
    expect(recentNavigationTarget("ArrowRight", 1, 6)).toBeNull();
    expect(recentNavigationTarget("ArrowLeft", 0, 6)).toBeNull();
  });

  it("rejects an invalid or incomplete Continue Watching control list", () => {
    expect(recentNavigationTarget("ArrowDown", 0, 0)).toBeNull();
    expect(recentNavigationTarget("ArrowDown", 0, 3)).toBeNull();
    expect(recentNavigationTarget("ArrowDown", -1, 4)).toBeNull();
    expect(recentNavigationTarget("ArrowDown", 4, 4)).toBeNull();
  });

  it("uses compact-list title steps with a one-view vertical stride", () => {
    expect(titleListNavigationTarget("ArrowRight", 0, 20)).toBe(1);
    expect(titleListNavigationTarget("ArrowLeft", 1, 20)).toBe(0);
    expect(titleListNavigationTarget("ArrowUp", 8, 20)).toBe(0);
    expect(titleListNavigationTarget("ArrowDown", 0, 20)).toBe(8);
    expect(titleListNavigationTarget("ArrowLeft", 0, 20)).toBeNull();
    expect(titleListNavigationTarget("ArrowUp", 7, 20)).toBe(0);
    expect(titleListNavigationTarget("ArrowRight", 19, 20)).toBeNull();
    expect(titleListNavigationTarget("ArrowDown", 12, 20)).toBe(19);
    expect(titleListNavigationTarget("ArrowDown", 19, 20)).toBeNull();
    expect(titleListNavigationTarget("ArrowUp", 0, 20)).toBeNull();
    expect(titleListNavigationTarget("ArrowDown", 0, 20, 3)).toBe(3);
  });

  it("continues TV title navigation across pages at the horizontal endpoints", () => {
    expect(titleListPageBoundaryTarget("ArrowRight", 7, 8, 0, 3)).toEqual({ page: 1, focusAtEnd: false });
    expect(titleListPageBoundaryTarget("ArrowLeft", 0, 8, 1, 3)).toEqual({ page: 0, focusAtEnd: true });
    expect(titleListPageBoundaryTarget("ArrowRight", 7, 8, 2, 3)).toBeNull();
    expect(titleListPageBoundaryTarget("ArrowLeft", 1, 8, 1, 3)).toBeNull();
    expect(titleListPageBoundaryTarget("ArrowRight", 6, 8, 0, 3)).toBeNull();
  });

  it("routes between Settings and the browse tabs", () => {
    expect(dashboardControlNavigationTarget("ArrowDown", true)).toBe("tabs");
    expect(dashboardControlNavigationTarget("ArrowDown", false)).toBeNull();
  });

  it("keeps dialog action navigation within the available choices", () => {
    expect(actionRowNavigationTarget("ArrowRight", 0, 3)).toBe(1);
    expect(actionRowNavigationTarget("ArrowDown", 1, 3)).toBe(2);
    expect(actionRowNavigationTarget("ArrowLeft", 0, 3)).toBe(0);
    expect(actionRowNavigationTarget("ArrowUp", 2, 3)).toBe(1);
    expect(actionRowNavigationTarget("Enter", 0, 3)).toBeNull();
  });

  it("uses Up and Down to leave editable player controls without taking text cursor keys", () => {
    expect(playerTextEntryNavigationKey("ArrowUp")).toBe(true);
    expect(playerTextEntryNavigationKey("ArrowDown")).toBe(true);
    expect(playerTextEntryNavigationKey("ArrowLeft")).toBe(false);
    expect(playerTextEntryNavigationKey("ArrowRight")).toBe(false);
  });

  it("toggles playback with web Space only on the video area or in fullscreen", () => {
    const web = { videoActive: true, fullscreen: false, editableTarget: false, tizen: false };
    expect(isPlayerPlaybackShortcut(" ", web)).toBe(true);
    expect(isPlayerPlaybackShortcut("Space", web)).toBe(true);
    expect(isPlayerPlaybackShortcut(" ", { ...web, videoActive: false })).toBe(false);
    expect(isPlayerPlaybackShortcut(" ", { ...web, editableTarget: true })).toBe(false);
    expect(isPlayerPlaybackShortcut(" ", { ...web, fullscreen: true, videoActive: false, editableTarget: true })).toBe(true);
    expect(isPlayerPlaybackShortcut("Enter", web)).toBe(false);
  });

  it("toggles playback with the TV Action/Enter key only on the video area or in fullscreen", () => {
    const tv = { videoActive: true, fullscreen: false, editableTarget: false, tizen: true };
    expect(isPlayerPlaybackShortcut("Enter", tv)).toBe(true);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, videoActive: false })).toBe(false);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, editableTarget: true })).toBe(false);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, fullscreen: true, videoActive: false, editableTarget: true })).toBe(true);
    expect(isPlayerPlaybackShortcut(" ", tv)).toBe(false);
  });

  it("skips absent configured-key setup and lands on the first subtitle result", () => {
    const configured = subtitleFocusLayout({ subtitleAttached: false, timingAvailable: true, apiKeyConfigured: true, apiKeyEditorOpen: false, seriesSearch: false });
    expect(configured.setupKey).toBeNull();
    expect(configured.keyInput).toBeNull();
    expect(configured.find).toBe(configured.search + 2);
    expect(configured.firstResult).toBe(configured.search + 3);
  });

  it("resolves Back from the topmost open screen first", () => {
    const context = {
      settingsConfirmationOpen: true,
      resumeChoiceOpen: true,
      settingsOpen: true,
      playlistFormOpen: false,
      errorFormOpen: false,
      selectedTitle: true,
      playerFullscreen: true,
      activeGroup: true,
      browseLoading: true,
    };
    expect(resolveAppBackAction(context)).toBe("cancel-settings-confirmation");
    expect(resolveAppBackAction({ ...context, settingsConfirmationOpen: false })).toBe("close-resume-choice");
    expect(resolveAppBackAction({ ...context, settingsConfirmationOpen: false, resumeChoiceOpen: false })).toBe("close-settings");
  });

  it("handles fullscreen, player, group, loading, and error-form Back routes", () => {
    const context = {
      settingsConfirmationOpen: false,
      resumeChoiceOpen: false,
      settingsOpen: false,
      playlistFormOpen: false,
      errorFormOpen: false,
      selectedTitle: false,
      playerFullscreen: false,
      activeGroup: false,
      browseLoading: false,
    };
    expect(resolveAppBackAction({ ...context, selectedTitle: true, playerFullscreen: true })).toBe("exit-fullscreen");
    expect(resolveAppBackAction({ ...context, selectedTitle: true })).toBe("close-player");
    expect(resolveAppBackAction({ ...context, activeGroup: true })).toBe("close-group");
    expect(resolveAppBackAction({ ...context, browseLoading: true })).toBe("cancel-browse-loading");
    expect(resolveAppBackAction({ ...context, playlistFormOpen: true })).toBe("close-playlist-form");
    expect(resolveAppBackAction({ ...context, playlistFormOpen: true, errorFormOpen: true })).toBe("close-playlist-form");
    expect(resolveAppBackAction(context)).toBe("stay");
  });
});
