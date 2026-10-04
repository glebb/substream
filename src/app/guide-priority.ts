/** Order guide work so the focused row and its neighbours become ready first. */
export function prioritizeGuideItems<T>(items: T[], focusIndex: number, getIndex: (item: T) => number): T[] {
  return items
    .map((item, order) => ({ item, order, distance: Math.abs(getIndex(item) - focusIndex) }))
    .sort((left, right) => left.distance - right.distance || left.order - right.order)
    .map(({ item }) => item);
}

/** Track cancellable provider requests belonging to one visible guide screen. */
export function createGuideWorkScope() {
  let cancelled = false;
  const controllers = new Set<AbortController>();
  return {
    get cancelled() { return cancelled; },
    track(controller: AbortController | undefined) {
      if (!controller) return;
      if (cancelled) controller.abort();
      else controllers.add(controller);
    },
    release(controller: AbortController | undefined) {
      if (controller) controllers.delete(controller);
    },
    cancel() {
      cancelled = true;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    },
  };
}
