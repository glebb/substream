/** Calculate a scroll delta that leaves room for the TV remote focus ring. */
export function titleListScrollDelta(viewportTop: number, viewportHeight: number, itemTop: number, itemBottom: number, inset = 14): number {
  const visibleTop = viewportTop + inset;
  const visibleBottom = viewportTop + viewportHeight - inset;
  if (itemTop < visibleTop) return itemTop - visibleTop;
  if (itemBottom > visibleBottom) return itemBottom - visibleBottom;
  return 0;
}

/** Focus a TV title without allowing Chromium 47 to scroll the whole page. */
export function focusTitleListItem(element: HTMLElement | null, viewport: HTMLElement | null): void {
  if (!element || !viewport) return;
  const scrollPositions: Array<{ element: HTMLElement; top: number; left: number }> = [];
  let ancestor: HTMLElement | null = viewport;
  while (ancestor) {
    scrollPositions.push({ element: ancestor, top: ancestor.scrollTop, left: ancestor.scrollLeft });
    ancestor = ancestor.parentElement;
  }
  const pageX = window.pageXOffset || document.documentElement.scrollLeft || 0;
  const pageY = window.pageYOffset || document.documentElement.scrollTop || 0;

  if (document.activeElement !== element) element.focus();

  // focus() can scroll the list, its parents, or the whole page in older TV
  // browsers. Restore that movement, then adjust only the bounded list pane.
  for (const position of scrollPositions) {
    position.element.scrollTop = position.top;
    position.element.scrollLeft = position.left;
  }
  if ((window.pageXOffset || 0) !== pageX || (window.pageYOffset || 0) !== pageY) window.scrollTo(pageX, pageY);

  const viewportRect = viewport.getBoundingClientRect();
  const itemRect = element.getBoundingClientRect();
  viewport.scrollTop += titleListScrollDelta(
    viewportRect.top + viewport.clientTop,
    viewport.clientHeight,
    itemRect.top,
    itemRect.bottom,
  );
}
