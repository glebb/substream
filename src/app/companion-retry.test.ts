import { describe, expect, it } from "vitest";
import { companionRetryDelay } from "./CompanionPanel.tsx";

describe("TV connection retry schedule", () => {
  it("backs off between attempts and caps the wait", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(companionRetryDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});
