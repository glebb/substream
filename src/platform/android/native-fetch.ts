import type { RuntimeFetch } from "../../contracts/repository.ts";
import { androidBridge, postAndroidCommand, subscribeAndroidEvents } from "./bridge.ts";

let nextRequest = 0;

/** Routes HTTP(S) requests directly from the device to their requested origin to avoid WebView CORS. */
export const androidFetch: RuntimeFetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : undefined;
  const url = request ? request.url : input instanceof URL ? input.href : String(input);
  // Bundled/local app resources stay on WebView's ordinary origin.
  if (/^https:\/\/appassets\.androidplatform\.net\//i.test(url)) return globalThis.fetch(input, init);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("Unsupported request URL");
  const bridge = androidBridge();
  if (!bridge) throw new TypeError("Android network bridge unavailable");
  const requestId = `request-${++nextRequest}`;
  const session = "android-transport";
  const headers = new Headers(request?.headers);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  let body: string | undefined;
  if (typeof init.body === "string") body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body instanceof Blob) body = await init.body.text();
  else if (init.body instanceof ArrayBuffer) body = new TextDecoder().decode(init.body);
  else if (ArrayBuffer.isView(init.body)) body = new TextDecoder().decode(init.body as ArrayBufferView);
  else if (request && request.body && init.body === undefined) body = await request.clone().text();
  if (init.signal?.aborted || request?.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); init.signal?.removeEventListener("abort", abort); request?.signal.removeEventListener("abort", abort); callback(); };
    const abort = () => finish(() => reject(new DOMException("The operation was aborted", "AbortError")));
    const unsubscribe = subscribeAndroidEvents(session, (event) => {
      const payload = event.payload ?? {};
      if (event.type === "requestError" && payload.requestId === requestId) finish(() => reject(new TypeError("Network request failed")));
      if (event.type !== "response" || payload.requestId !== requestId) return;
      const status = Number(payload.status);
      const responseHeaders = new Headers();
      if (payload.headers && typeof payload.headers === "object") Object.entries(payload.headers as Record<string, unknown>).forEach(([key, value]) => { if (typeof value === "string") responseHeaders.set(key, value); });
      if (!Number.isInteger(status) || status < 100 || status > 599) { finish(() => reject(new TypeError("Network request failed"))); return; }
      let responseBody: string | ArrayBuffer = typeof payload.body === "string" ? payload.body : "";
      if (typeof payload.bodyBase64 === "string") {
        try {
          const decoded = atob(payload.bodyBase64);
          const bytes = new Uint8Array(decoded.length);
          for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
          const binaryBuffer = new ArrayBuffer(bytes.length);
          new Uint8Array(binaryBuffer).set(bytes);
          responseBody = binaryBuffer;
        } catch { finish(() => reject(new TypeError("Network request failed"))); return; }
      }
      finish(() => resolve(new Response([204, 205, 304].includes(status) ? null : responseBody, { status, headers: responseHeaders })));
    });
    const timer = setTimeout(() => finish(() => reject(new TypeError("Network request timed out"))), 25_000);
    init.signal?.addEventListener("abort", abort, { once: true });
    request?.signal.addEventListener("abort", abort, { once: true });
    try {
      bridge.postMessage(JSON.stringify({ v: 1, id: Date.now(), session, command: "request", payload: {
        requestId, url, method: (init.method ?? request?.method ?? "GET").toUpperCase(),
        headers: Object.fromEntries(headers.entries()), ...(body !== undefined ? { body } : {}),
      } }));
    } catch { finish(() => reject(new TypeError("Network request failed"))); }
  });
};
