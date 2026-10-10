import { describe, expect, it } from "vitest";
import { isBackKey, isRedKey, normalizedRemoteKey } from "./input.ts";

describe("shared input normalization", () => {
  it.each([
    [{ key: "Down", keyCode: 0 }, "ArrowDown"],
    [{ key: "", keyCode: 37 }, "ArrowLeft"],
    [{ key: "Return", keyCode: 0 }, "Enter"],
    [{ key: "", keyCode: 10252 }, "MediaPlayPause"],
    [{ key: "ColorF0Red", keyCode: 0 }, "Red"],
    [{ key: "", keyCode: 10009 }, "Back"],
    [{ key: "", keyCode: 461 }, "Back"],
  ])("normalizes legacy or platform key %j", (event, expected) => {
    expect(normalizedRemoteKey(event as KeyboardEvent)).toBe(expected);
  });

  it("provides shared Back and colour key predicates", () => {
    expect(isBackKey({ key: "BrowserBack", keyCode: 0 } as KeyboardEvent)).toBe(true);
    expect(isRedKey({ key: "", keyCode: 403 } as KeyboardEvent)).toBe(true);
    expect(isRedKey({ key: "Enter", keyCode: 13 } as KeyboardEvent)).toBe(false);
  });
});
