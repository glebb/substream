import { describe, expect, it } from "vitest";
import { actionRowNavigationTarget, browseCollectionFocusIndex, browseCollectionFocusTarget, browseGridColumnCount, dashboardControlNavigationTarget, detailsControlNavigationTarget, focusFallback, fullscreenControlNavigationTarget, gridNavigationTarget, homeBrowseFocusTarget, isPlayerPlaybackShortcut, nestedScreenSettingsTarget, playerTextEntryNavigationKey, recentNavigationTarget, remoteEditableKeyAction, resolveAppBackAction, screenNavigationTarget, settingsControlOrder, shouldHandleHeldTitleKeyRepeat, subtitleFocusLayout } from "./remote-navigation.ts";

describe("remote dashboard navigation", () => {
  it("keeps the subtitle source picker before local files and timing controls", () => {
    const layout = subtitleFocusLayout({ subtitleAttached: true, timingAvailable: true, apiKeyConfigured: true, apiKeyEditorOpen: false, seriesSearch: false, sourcePickerAvailable: true, localSubtitleAvailable: true });
    expect(layout.sourcePicker).toBe(12);
    expect(layout.localSubtitle).toBe(13);
    expect(layout.timingStart).toBe(14);
    expect(layout.search).toBe(18);
  });

  it("keeps Settings navigation in DOM order as conditional editors appear", () => {
    expect(settingsControlOrder({ confirmationOpen: false, apiKeyEditorOpen: false, hasSubtitleKey: false })).toEqual([
      "back", "companion-url", "companion-start", "ui-language", "playlist", "subtitle-language", "api-key-edit",
      "tmdb-token-input", "tmdb-key-input", "tmdb-save", "tmdb-cancel", "clear-catalog", "reset-all",
    ]);
    expect(settingsControlOrder({ confirmationOpen: false, apiKeyEditorOpen: true, hasSubtitleKey: true })).toEqual([
      "back", "companion-url", "companion-start", "ui-language", "playlist", "subtitle-language", "api-key-input", "api-key-save", "api-key-cancel", "remove-api-key",
      "tmdb-token-input", "tmdb-key-input", "tmdb-save", "tmdb-cancel", "clear-catalog", "reset-all",
    ]);
    expect(settingsControlOrder({ confirmationOpen: false, apiKeyEditorOpen: false, hasSubtitleKey: false, liveRelayControlsVisible: true })).toEqual([
      "back", "companion-url", "companion-start", "relay-enabled", "relay-url", "relay-allow-http", "relay-credential", "relay-mappings", "relay-offset", "relay-diagnostics", "relay-save", "relay-remove",
      "ui-language", "playlist", "subtitle-language", "api-key-edit", "tmdb-token-input", "tmdb-key-input", "tmdb-save", "tmdb-cancel", "clear-catalog", "reset-all",
    ]);
    expect(settingsControlOrder({ confirmationOpen: true, apiKeyEditorOpen: true, hasSubtitleKey: true })).toEqual([
      "confirm-cancel", "confirm-confirm",
    ]);
  });

  it("follows selected home tiles while preserving tab-row focus", () => {
    expect(homeBrowseFocusTarget("tile", true)).toBe("tile");
    expect(homeBrowseFocusTarget("tab", true)).toBe("stay");
    expect(homeBrowseFocusTarget("body", true)).toBe("tile");
    expect(homeBrowseFocusTarget("body", false)).toBe("tab");
    expect(homeBrowseFocusTarget("other", true)).toBe("stay");
  });

  it("moves a browse tab to content, then to an empty-state recovery action", () => {
    expect(browseCollectionFocusTarget(true, true)).toBe("content");
    expect(browseCollectionFocusTarget(false, true)).toBe("recovery");
    expect(browseCollectionFocusTarget(false, false)).toBe("tab");
    expect(browseCollectionFocusIndex("content", 2)).toBe(0);
    expect(browseCollectionFocusIndex("content", 2, 99)).toBe(1);
    expect(browseCollectionFocusIndex("recovery", 2)).toBeNull();
    expect(focusFallback([null, "second", "third"], 0)).toBe("second");
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

  it("moves through TV title cards as a four-column grid", () => {
    expect(gridNavigationTarget("ArrowRight", 0, 10, 4)).toBe(1);
    expect(gridNavigationTarget("ArrowDown", 1, 10, 4)).toBe(5);
    expect(gridNavigationTarget("ArrowUp", 5, 10, 4)).toBe(1);
    expect(gridNavigationTarget("ArrowLeft", 4, 10, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowDown", 6, 10, 4)).toBeNull();
    expect(gridNavigationTarget("ArrowRight", 9, 10, 4)).toBeNull();
  });

  it("throttles native held-key repeats and stops accepting them after release", () => {
    const held = { key: "ArrowDown", lastHandledAt: 1_000 };
    expect(shouldHandleHeldTitleKeyRepeat("ArrowDown", 1_050, held, 90)).toBe(false);
    expect(shouldHandleHeldTitleKeyRepeat("ArrowDown", 1_090, held, 90)).toBe(true);
    expect(shouldHandleHeldTitleKeyRepeat("ArrowUp", 1_500, held, 90)).toBe(false);
    expect(shouldHandleHeldTitleKeyRepeat("ArrowLeft", 1_500, held, 90)).toBe(false);
    // keyup clears the held state, so any late repeat event is ignored.
    expect(shouldHandleHeldTitleKeyRepeat("ArrowDown", 1_500, null, 90)).toBe(false);
  });

  it("routes between Settings and the browse tabs", () => {
    expect(dashboardControlNavigationTarget("ArrowDown", true)).toBe("tabs");
    expect(dashboardControlNavigationTarget("ArrowDown", false)).toBeNull();
    expect(nestedScreenSettingsTarget("ArrowUp", 0)).toBe("settings");
    expect(nestedScreenSettingsTarget("ArrowUp", 1)).toBeNull();
    expect(nestedScreenSettingsTarget("ArrowDown", 0)).toBeNull();
  });

  it("matches three-column category geometry on 720p TVs", () => {
    expect(browseGridColumnCount(false, false, false, true)).toBe(3);
    expect(browseGridColumnCount(false, false, false, false)).toBe(4);
    expect(browseGridColumnCount(false, true, false, true)).toBe(2);
    expect(gridNavigationTarget("ArrowDown", 1, 8, 3)).toBe(4);
  });

  it("moves across shared screen navigation from previous to main menu", () => {
    expect(screenNavigationTarget("ArrowRight", "previous", true)).toBe("main-menu");
    expect(screenNavigationTarget("ArrowLeft", "main-menu", true)).toBe("previous");
    expect(screenNavigationTarget("ArrowLeft", "main-menu", false)).toBeNull();
    expect(screenNavigationTarget("ArrowDown", "main-menu", true)).toBeNull();
  });

  it("keeps dialog action navigation within the available choices", () => {
    expect(actionRowNavigationTarget("ArrowRight", 0, 3)).toBe(1);
    expect(actionRowNavigationTarget("ArrowDown", 1, 3)).toBe(2);
    expect(actionRowNavigationTarget("ArrowLeft", 0, 3)).toBe(0);
    expect(actionRowNavigationTarget("ArrowUp", 2, 3)).toBe(1);
    expect(actionRowNavigationTarget("Enter", 0, 3)).toBeNull();
  });

  it("keeps series details navigation reversible after selecting an episode", () => {
    expect(detailsControlNavigationTarget("ArrowDown", 0, 3)).toBe(1);
    expect(detailsControlNavigationTarget("ArrowDown", 1, 3)).toBe(2);
    expect(detailsControlNavigationTarget("ArrowUp", 2, 3)).toBe(1);
    expect(detailsControlNavigationTarget("ArrowUp", 1, 3)).toBe(0);
    expect(detailsControlNavigationTarget("ArrowLeft", 2, 3)).toBe(1);
    expect(detailsControlNavigationTarget("ArrowRight", 1, 3)).toBe(2);
  });

  it("uses Up and Down to leave editable player controls without taking text cursor keys", () => {
    expect(playerTextEntryNavigationKey("ArrowUp")).toBe(true);
    expect(playerTextEntryNavigationKey("ArrowDown")).toBe(true);
    expect(playerTextEntryNavigationKey("ArrowLeft")).toBe(false);
    expect(playerTextEntryNavigationKey("ArrowRight")).toBe(false);
  });

  it("requires explicit Action/Enter to begin remote editing", () => {
    expect(remoteEditableKeyAction("ArrowDown", false)).toBe("navigate");
    expect(remoteEditableKeyAction("Enter", false, true)).toBe("enter-edit");
    expect(remoteEditableKeyAction("ArrowUp", true, true)).toBe("leave-edit");
    expect(remoteEditableKeyAction("Back", true, true)).toBe("leave-edit");
    expect(remoteEditableKeyAction("Enter", true, true)).toBe("ignore");
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

  it("toggles playback with TV Enter on the video area or while fullscreen controls are hidden", () => {
    const tv = { videoActive: true, fullscreen: false, editableTarget: false, tizen: true };
    expect(isPlayerPlaybackShortcut("Enter", tv)).toBe(true);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, videoActive: false })).toBe(false);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, editableTarget: true })).toBe(false);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, fullscreen: true, fullscreenControlsVisible: false, videoActive: false, editableTarget: true })).toBe(true);
    expect(isPlayerPlaybackShortcut("Enter", { ...tv, fullscreen: true, fullscreenControlsVisible: true, videoActive: false, editableTarget: false })).toBe(false);
    expect(isPlayerPlaybackShortcut(" ", tv)).toBe(false);
  });

  it("moves fullscreen focus among visible buttons while skipping the video surface", () => {
    expect(fullscreenControlNavigationTarget("ArrowDown", 1, 7)).toBe(2);
    expect(fullscreenControlNavigationTarget("ArrowUp", 1, 7)).toBe(0);
    expect(fullscreenControlNavigationTarget("ArrowRight", 2, 7)).toBe(3);
    expect(fullscreenControlNavigationTarget("ArrowLeft", 2, 7)).toBe(0);
    expect(fullscreenControlNavigationTarget("ArrowLeft", 0, 7)).toBeNull();
    expect(fullscreenControlNavigationTarget("ArrowRight", 6, 10)).toBe(7);
    expect(fullscreenControlNavigationTarget("ArrowRight", 8, 10)).toBe(9);
    expect(fullscreenControlNavigationTarget("ArrowRight", 9, 10)).toBeNull();
    expect(fullscreenControlNavigationTarget("Enter", 2, 7)).toBeNull();
  });

  it("skips absent configured-key setup and lands on the first subtitle result", () => {
    const configured = subtitleFocusLayout({ subtitleAttached: false, timingAvailable: true, apiKeyConfigured: true, apiKeyEditorOpen: false, seriesSearch: false });
    expect(configured.setupKey).toBeNull();
    expect(configured.keyInput).toBeNull();
    expect(configured.find).toBe(configured.search + 2);
    expect(configured.firstResult).toBe(configured.search + 3);
  });

  it("orders local subtitle controls before timing and keeps series search contiguous", () => {
    for (const controlOffset of [0, 1]) {
      for (const timingAvailable of [false, true]) {
        for (const localSubtitleAvailable of [false, true]) {
          for (const keyState of ["configured", "setup", "editing"]) {
            const layout = subtitleFocusLayout({ subtitleAttached: true, timingAvailable, localSubtitleAvailable, controlOffset, apiKeyConfigured: keyState === "configured", apiKeyEditorOpen: keyState === "editing", seriesSearch: true });
            const firstSubtitleControl = 12 + controlOffset;
            expect(layout.localSubtitle).toBe(localSubtitleAvailable ? firstSubtitleControl : null);
            expect(layout.timingStart).toBe(firstSubtitleControl + (localSubtitleAvailable ? 1 : 0));
            const keyStart = layout.timingStart + (timingAvailable ? 4 : 0);
            expect(layout.setupKey).toBe(keyState === "setup" ? keyStart : null);
            expect(layout.keyInput).toBe(keyState === "editing" ? keyStart : null);
            expect(layout.saveKey).toBe(keyState === "editing" ? keyStart + 1 : null);
            expect(layout.search).toBe(keyStart + (keyState === "configured" ? 0 : keyState === "editing" ? 2 : 1));
            expect(layout.season).toBe(layout.searchType + 1);
            expect(layout.episode).toBe(layout.season + 1);
            expect(layout.find).toBe(layout.episode + 1);
            expect(layout.firstResult).toBe(layout.find + 1);
          }
        }
      }
    }
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
    expect(resolveAppBackAction({ ...context, selectedTitle: true, playerFullscreen: true, playerFullscreenControlsVisible: false })).toBe("exit-fullscreen");
    expect(resolveAppBackAction({ ...context, selectedTitle: true, playerFullscreen: true, playerFullscreenControlsVisible: true })).toBe("hide-fullscreen-controls");
    expect(resolveAppBackAction({ ...context, selectedTitle: true })).toBe("close-player");
    expect(resolveAppBackAction({ ...context, activeGroup: true })).toBe("close-group");
    expect(resolveAppBackAction({ ...context, browseLoading: true })).toBe("cancel-browse-loading");
    expect(resolveAppBackAction({ ...context, playlistFormOpen: true })).toBe("close-playlist-form");
    expect(resolveAppBackAction({ ...context, playlistFormOpen: true, errorFormOpen: true })).toBe("close-playlist-form");
    expect(resolveAppBackAction(context)).toBe("stay");
  });
});
