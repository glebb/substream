const TV_INPUT_PRIVILEGE_KEYS = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaRewind", "MediaFastForward", "Info"];

interface TizenInputDevice {
  registerKeyBatch(keys: string[], onSuccess?: () => void, onError?: (error: unknown) => void): void;
  registerKey(key: string): void;
}

interface TizenGlobal {
  tvinputdevice?: TizenInputDevice;
}

export function registerTizenPlaybackKeys(): void {
  const input = (globalThis as typeof globalThis & { tizen?: TizenGlobal }).tizen?.tvinputdevice;
  if (!input) return;
  try {
    input.registerKeyBatch(TV_INPUT_PRIVILEGE_KEYS);
  } catch {
    for (const key of TV_INPUT_PRIVILEGE_KEYS) {
      try { input.registerKey(key); } catch { /* Key support varies by TV model. */ }
    }
  }
}

export function isBackKey(event: KeyboardEvent): boolean {
  return normalizedRemoteKey(event) === "Back";
}

/** Older Samsung web engines use Left/Right/Up/Down and keyCode values. */
export function normalizedRemoteKey(event: KeyboardEvent): string {
  const key = event.key ?? "";
  const code = event.code ?? "";
  const backNames = new Set(["escape", "browserback", "back", "xf86back", "goback"]);
  if (backNames.has(key.toLowerCase()) || backNames.has(code.toLowerCase())
    || event.keyCode === 10009 || event.which === 10009) return "Back";

  const legacyKeys: Record<number, string> = {
    13: "Enter",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    457: "Info",
    19: "MediaPause",
    412: "MediaRewind",
    415: "MediaPlay",
    417: "MediaFastForward",
    10252: "MediaPlayPause",
  };
  const namedKeys: Record<string, string> = {
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Return: "Enter",
    XF86AudioPlay: "MediaPlayPause",
    XF86AudioPause: "MediaPause",
    Info: "Info",
  };
  const legacyKeyCode = event.keyCode || event.which;
  return namedKeys[key] ?? namedKeys[code]
    ?? (key.toLowerCase() === "i" || code === "KeyI" ? "Info" : legacyKeys[legacyKeyCode] ?? (key || code));
}
