/** Touch taps should not leave keyboard focus or simulated hover painted on screen. */
export function installTouchNavigationStyles(document: Document): () => void {
  const setTouch = () => document.documentElement.classList.add("touch-navigation");
  const onKeyDown = () => document.documentElement.classList.remove("touch-navigation");
  setTouch();
  document.addEventListener("touchstart", setTouch, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("touchstart", setTouch, true);
    document.removeEventListener("keydown", onKeyDown, true);
    onKeyDown();
  };
}
