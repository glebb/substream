import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export type FixedListRowPolicy = { minHeight: number; maxHeight: number; spacing: number };

/** Expand short, finite lists into spare viewport space while keeping rows bounded. */
export function fixedListRowHeight(availableHeight: number, itemCount: number, policy: FixedListRowPolicy = { minHeight: 72, maxHeight: 160, spacing: 8 }): number | null {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0 || !Number.isFinite(itemCount) || itemCount <= 0) return null;
  const { minHeight, maxHeight, spacing } = policy;
  if (minHeight <= 0 || maxHeight < minHeight || spacing < 0) return null;
  const height = Math.floor((availableHeight - spacing * Math.max(0, itemCount - 1)) / itemCount);
  return height > minHeight ? Math.min(height, maxHeight) : null;
}

/** Measures a flex-sized list viewport and returns a row minimum for short lists. */
export function useFixedListRowHeight<T extends HTMLElement>(viewportRef: RefObject<T | null>, itemCount: number, policy?: FixedListRowPolicy, measurementKey?: string | number | boolean): CSSProperties | undefined {
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) { setRowHeight(null); return; }
    let frame = 0;
    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const computed = window.getComputedStyle(viewport);
        const verticalPadding = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
        setRowHeight(fixedListRowHeight(Math.max(0, viewport.clientHeight - verticalPadding), itemCount, policy));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [itemCount, measurementKey, policy?.maxHeight, policy?.minHeight, policy?.spacing, viewportRef]);
  return rowHeight === null ? undefined : { minHeight: `${rowHeight}px` };
}
