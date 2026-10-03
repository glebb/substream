import { describe, expect, it } from "vitest";
import { classifyMultiSubChannel } from "./multi-sub-relay.ts";

describe("Multi-Sub relay channel rule", () => {
  it("routes title variants to the stable provider stream channel ID", () => {
    expect(classifyMultiSubChannel("Sports Multi-Sub HD", "42")).toMatchObject({ channelId: "stream-42", evidence: { kind: "title-keyword" } });
    expect(classifyMultiSubChannel("Drama multi sub", "x7").channelId).toBe("stream-x7");
    expect(classifyMultiSubChannel("MULTI-SUB Movies", "9").channelId).toBe("stream-9");
  });

  it("leaves unrelated titles unrouted and records the inspected title", () => {
    expect(classifyMultiSubChannel("Sports HD", "42")).toEqual({ channelId: null, evidence: { kind: "no-match", value: "Sports HD" } });
    expect(classifyMultiSubChannel("Multisubmarine documentary", "42").channelId).toBeNull();
  });
});
