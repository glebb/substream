import { describe, expect, it } from "vitest";
import { createGuideWorkScope, prioritizeGuideItems } from "./guide-priority.ts";

describe("guide request scheduling", () => {
  it("loads the focused synthetic channel and nearest rows first with stable ties", () => {
    const channels = [0, 1, 2, 3, 4, 5].map((index) => ({ id: `fixture-${index}`, index }));
    expect(prioritizeGuideItems(channels, 3, (channel) => channel.index).map((channel) => channel.index))
      .toEqual([3, 2, 4, 1, 5, 0]);
  });

  it("aborts in-flight work when a category scope is cancelled and immediately aborts late registrations", () => {
    const scope = createGuideWorkScope();
    const active = new AbortController();
    scope.track(active);
    expect(active.signal.aborted).toBe(false);

    scope.cancel();

    expect(scope.cancelled).toBe(true);
    expect(active.signal.aborted).toBe(true);
    const late = new AbortController();
    scope.track(late);
    expect(late.signal.aborted).toBe(true);
  });
});
