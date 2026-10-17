import { describe, expect, it } from "vitest";
import { companionLocalPlaybackState, nextCompanionLocalSession } from "./companion-local-state.ts";

describe("companion local playback state", () => {
  it("maps player states to reported states", () => {
    expect(companionLocalPlaybackState("playing")).toBe("playing");
    expect(companionLocalPlaybackState("paused")).toBe("paused");
    expect(companionLocalPlaybackState("ended")).toBe("ended");
    expect(companionLocalPlaybackState("error")).toBe("failed");
    expect(companionLocalPlaybackState("buffering")).toBe("preparing");
    expect(companionLocalPlaybackState("loading")).toBe("preparing");
  });

  it("returns a new session only when the reported state changes", () => {
    const session = { sessionId: "synthetic", playbackState: "preparing" as const };
    const playing = nextCompanionLocalSession(session, "playing");
    expect(playing).toEqual({ sessionId: "synthetic", playbackState: "playing" });
    expect(playing).not.toBe(session);
    // Repeated callbacks during steady playback must not report again.
    expect(nextCompanionLocalSession(playing!, "playing")).toBeNull();
    expect(nextCompanionLocalSession(session, "buffering")).toBeNull();
    expect(nextCompanionLocalSession(playing!, "buffering")).toEqual({ sessionId: "synthetic", playbackState: "preparing" });
  });
});
