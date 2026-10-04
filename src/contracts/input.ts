/** Stable logical key names shared by browser keyboards and TV remotes. */
export function normalizedRemoteKey(event: Pick<KeyboardEvent, "key" | "code" | "keyCode" | "which">): string {
  const key = event.key ?? "";
  const code = event.code ?? "";
  const backNames = new Set(["escape", "esc", "browserback", "back", "xf86back", "goback"]);
  if (backNames.has(key.toLowerCase()) || backNames.has(code.toLowerCase())
    || event.keyCode === 27 || event.which === 27 || event.keyCode === 10009 || event.which === 10009) return "Back";

  const legacyKeys: Record<number, string> = {
    13: "Enter", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown",
    457: "Info", 19: "MediaPause", 412: "MediaRewind", 415: "MediaPlay", 417: "MediaFastForward",
    10252: "MediaPlayPause", 403: "Red",
  };
  const namedKeys: Record<string, string> = {
    Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Return: "Enter",
    XF86AudioPlay: "MediaPlayPause", XF86AudioPause: "MediaPause", Info: "Info",
    Red: "Red", ColorF0Red: "Red", ColorRed: "Red",
  };
  const legacyKeyCode = event.keyCode || event.which;
  return namedKeys[key] ?? namedKeys[code]
    ?? (key.toLowerCase() === "i" || code === "KeyI" ? "Info" : legacyKeys[legacyKeyCode] ?? (key || code));
}

export function isBackKey(event: Pick<KeyboardEvent, "key" | "code" | "keyCode" | "which">): boolean {
  return normalizedRemoteKey(event) === "Back";
}

export function isRedKey(event: Pick<KeyboardEvent, "key" | "code" | "keyCode" | "which">): boolean {
  return normalizedRemoteKey(event) === "Red";
}
