import { describe, expect, it } from "vitest";
import { normalizedRemoteKey } from "./remote.ts";

describe("normalizedRemoteKey", () => {
  it("normalizes legacy Samsung direction names and key codes", () => {
    expect(normalizedRemoteKey({ key: "Down", keyCode: 0 } as KeyboardEvent)).toBe("ArrowDown");
    expect(normalizedRemoteKey({ key: "", keyCode: 37 } as KeyboardEvent)).toBe("ArrowLeft");
    expect(normalizedRemoteKey({ key: "Return", keyCode: 0 } as KeyboardEvent)).toBe("Enter");
    expect(normalizedRemoteKey({ key: "", keyCode: 10252 } as KeyboardEvent)).toBe("MediaPlayPause");
    expect(normalizedRemoteKey({ key: "", keyCode: 415 } as KeyboardEvent)).toBe("MediaPlay");
  });
});
