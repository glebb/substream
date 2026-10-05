import { expect, it, vi } from "vitest";
import { installTouchNavigationStyles } from "./touch-interaction.ts";

it("suppresses touch focus styling, restores keyboard focus, and removes listeners on cleanup", () => {
  const classes = new Set<string>();
  const listeners = new Map<string, () => void>();
  const document = {
    documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
    addEventListener: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  };
  const cleanup = installTouchNavigationStyles(document as unknown as Document);
  expect(classes.has("touch-navigation")).toBe(true);
  listeners.get("keydown")!();
  expect(classes.has("touch-navigation")).toBe(false);
  listeners.get("touchstart")!();
  expect(classes.has("touch-navigation")).toBe(true);
  cleanup();
  expect(classes.has("touch-navigation")).toBe(false);
  expect(listeners.size).toBe(0);
  expect(document.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
});
