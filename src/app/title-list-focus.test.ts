import { afterEach, describe, expect, it, vi } from "vitest";
import { focusTitleListItem, titleListScrollDelta } from "./title-list-focus.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Tizen title-list focus scrolling", () => {
  it("keeps a focused row inside the list with room for the yellow focus ring", () => {
    expect(titleListScrollDelta(100, 200, 120, 160)).toBe(0);
    expect(titleListScrollDelta(100, 200, 80, 120)).toBe(-34);
    expect(titleListScrollDelta(100, 200, 270, 300)).toBe(14);
  });

  it("restores ancestor and page scroll, then moves only the bounded list viewport", () => {
    const fakeWindow = {
      pageXOffset: 5,
      pageYOffset: 60,
      scrollTo(x: number, y: number) { this.pageXOffset = x; this.pageYOffset = y; },
    };
    const html = { parentElement: null, scrollTop: 0, scrollLeft: 0 };
    const body = { parentElement: html, scrollTop: 23, scrollLeft: 4 };
    const fakeDocument: { activeElement: unknown; documentElement: typeof html } = { activeElement: null, documentElement: html };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);

    const viewport = {
      parentElement: body,
      scrollTop: 20,
      scrollLeft: 0,
      clientTop: 1,
      clientHeight: 180,
      getBoundingClientRect: () => ({ top: 100 }),
    } as unknown as HTMLElement;
    const item = {
      focus() {
        fakeDocument.activeElement = item;
        fakeWindow.pageYOffset = 999;
        viewport.scrollTop = 400;
        body.scrollTop = 900;
      },
      getBoundingClientRect: () => ({ top: 290, bottom: 320 }),
    } as unknown as HTMLElement;

    focusTitleListItem(item, viewport);

    expect(fakeDocument.activeElement).toBe(item);
    expect(fakeWindow.pageXOffset).toBe(5);
    expect(fakeWindow.pageYOffset).toBe(60);
    expect(body.scrollTop).toBe(23);
    expect(viewport.scrollTop).toBe(73);
  });
});
