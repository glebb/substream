import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../package-defaults.ts", () => ({ packageDefaults: {
  companionServerUrl: "http://192.0.2.44:8787",
} }));

import { companionSelectionTitle, companionServerUrl } from "./client.ts";

describe("companion client", () => {
  it("uses the non-secret companion address embedded from local configuration", () => {
    expect(companionServerUrl()).toBe("http://192.0.2.44:8787");
  });

  it("turns a safe selection into a local provider title without a stream URL", () => {
    const title = companionSelectionTitle({ kind: "movie", id: "42", title: "Example (2024)", year: 2024, extension: "mkv", sourceFingerprint: "vod_x" });
    expect(title).toMatchObject({ id: "xtream:movie:42", title: "Example", year: 2024, streamUrl: "" });
  });

  it("rejects malformed provider IDs", () => {
    expect(companionSelectionTitle({ kind: "movie", id: "42/secret", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_x" })).toBeNull();
  });
});
