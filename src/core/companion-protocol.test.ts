import { describe, expect, it } from "vitest";
import { COMPANION_PROTOCOL_VERSION, parseCompanionEvent, parseCompanionEventsPayload, parseCompanionSelection, supportsCompanionProtocolVersion } from "./companion-protocol.mjs";

describe("companion protocol", () => {
  const selection = { kind: "episode", id: 42, seriesId: "7", title: "  Example  ", year: 2024, season: 1, episode: 2, extension: "MKV", sourceFingerprint: "vod_test" };

  it("normalizes selections into an allow-listed safe v4 shape", () => {
    const parsed = parseCompanionSelection({ ...selection, streamUrl: "https://private.invalid/token=secret", browserCredential: "secret", password: "secret" });
    expect(parsed).toEqual({ kind: "episode", id: "42", seriesId: "7", title: "Example", year: 2024, season: 1, episode: 2, extension: "mkv", sourceFingerprint: "vod_test" });
    expect(JSON.stringify(parsed)).not.toMatch(/streamUrl|credential|password|private\.invalid/);
  });

  it("rejects missing required selection data and keeps malformed optional metadata safe", () => {
    expect(parseCompanionSelection({ ...selection, title: "  " })).toBeNull();
    expect(parseCompanionSelection({ ...selection, id: "../secret" })).toBeNull();
    expect(parseCompanionSelection({ ...selection, year: 1.5, season: 0, extension: "?" })).toMatchObject({ year: null, season: null, extension: "mp4" });
  });

  it("validates versioned events and rejects unsupported versions or malformed events", () => {
    expect(COMPANION_PROTOCOL_VERSION).toBe(4);
    expect(supportsCompanionProtocolVersion(undefined)).toBe(false);
    expect(supportsCompanionProtocolVersion(1)).toBe(false);
    expect(supportsCompanionProtocolVersion(2)).toBe(false);
    expect(supportsCompanionProtocolVersion(4)).toBe(true);
    const event = parseCompanionEvent({ sequence: 3, action: "play", selection, debug: "discard me" });
    expect(event).toMatchObject({ sequence: 3, action: "play", selection: { id: "42" } });
    expect(event).not.toHaveProperty("debug");
    expect(parseCompanionEvent({ sequence: 0, selection })).toBeNull();
    expect(parseCompanionEvent({ sequence: 3, action: "launch", selection })).toBeNull();
    expect(parseCompanionEventsPayload({ protocolVersion: 1, events: [], paired: true })).toBeNull();
    expect(parseCompanionEventsPayload({ protocolVersion: 4, events: [{ sequence: -1, selection }], paired: true })).toBeNull();
    expect(parseCompanionEventsPayload({ protocolVersion: 4, events: [], paired: true, retentionGap: { throughSequence: 2, firstAvailableSequence: 3 } }))
      .toMatchObject({ retentionGap: { throughSequence: 2, firstAvailableSequence: 3 } });
    expect(parseCompanionEventsPayload({ protocolVersion: 4, events: [], paired: true, retentionGap: { throughSequence: 3, firstAvailableSequence: 3 } })).toBeNull();
  });

  it("accepts local playback commands and stop commands without provider data", () => {
    const play = parseCompanionEvent({ sequence: 5, action: "play-local", localMedia: {
      sessionId: "a".repeat(32), ticket: "b".repeat(64), title: "Local file", searchTitle: "Local file",
      year: null, season: null, episode: null, contentType: "unknown", mediaType: "video/mp4", size: 1024,
      streamUrl: "https://unsafe.invalid/token=secret",
    } });
    expect(play).toMatchObject({ action: "play-local", localMedia: { sessionId: "a".repeat(32), size: 1024 } });
    expect(JSON.stringify(play)).not.toMatch(/streamUrl|unsafe\.invalid|secret/);
    expect(parseCompanionEvent({ sequence: 6, action: "stop-local", sessionId: "c".repeat(32), browserCredential: "secret" }))
      .toEqual({ sequence: 6, action: "stop-local", sessionId: "c".repeat(32) });
    expect(parseCompanionEvent({ sequence: 7, action: "stop-local", sessionId: "invalid" })).toBeNull();
  });
});
