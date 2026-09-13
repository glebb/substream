import { describe, expect, it } from "vitest";
import { isBackKey, normalizedRemoteKey } from "./remote.ts";

describe("normalizedRemoteKey", () => {
  it("normalizes legacy Samsung direction names and key codes", () => {
    expect(normalizedRemoteKey({ key: "Down", keyCode: 0 } as KeyboardEvent)).toBe("ArrowDown");
    expect(normalizedRemoteKey({ key: "", keyCode: 37 } as KeyboardEvent)).toBe("ArrowLeft");
    expect(normalizedRemoteKey({ key: "Return", keyCode: 0 } as KeyboardEvent)).toBe("Enter");
    expect(normalizedRemoteKey({ key: "", keyCode: 10252 } as KeyboardEvent)).toBe("MediaPlayPause");
    expect(normalizedRemoteKey({ key: "", keyCode: 415 } as KeyboardEvent)).toBe("MediaPlay");
    expect(normalizedRemoteKey({ key: "i", keyCode: 0 } as KeyboardEvent)).toBe("Info");
    expect(normalizedRemoteKey({ key: "", keyCode: 457 } as KeyboardEvent)).toBe("Info");
    expect(normalizedRemoteKey({ key: "Info", keyCode: 0 } as KeyboardEvent)).toBe("Info");
  });

  it.each([
    { key: "Escape", code: "", keyCode: 0 },
    { key: "BrowserBack", code: "", keyCode: 0 },
    { key: "Back", code: "", keyCode: 0 },
    { key: "XF86Back", code: "", keyCode: 0 },
    { key: "GoBack", code: "", keyCode: 0 },
    { key: "", code: "XF86Back", keyCode: 0 },
    { key: "", code: "", keyCode: 10009 },
  ])("normalizes Samsung/Tizen Back variant %#", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    expect(normalizedRemoteKey(keyboardEvent)).toBe("Back");
    expect(isBackKey(keyboardEvent)).toBe(true);
  });
});
