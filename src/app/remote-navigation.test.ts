import { describe, expect, it } from "vitest";
import { dashboardControlNavigationTarget, homeGridNavigationTarget, resolveAppBackAction } from "./remote-navigation.ts";

describe("remote dashboard navigation", () => {
  it("routes Up from the first home-grid row to Settings and Down back to the grid", () => {
    expect(homeGridNavigationTarget("ArrowUp", 0)).toBe("settings");
    expect(homeGridNavigationTarget("ArrowUp", 3)).toBe("settings");
    expect(homeGridNavigationTarget("ArrowUp", 4)).toBeNull();
    expect(dashboardControlNavigationTarget("ArrowDown", true)).toBe("grid");
    expect(dashboardControlNavigationTarget("ArrowDown", false)).toBeNull();
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
