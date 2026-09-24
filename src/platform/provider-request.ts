declare const __SUBSTREAM_LOCAL_PROVIDER_PROXY__: boolean;

/** Route provider fetches through the isolated local browser preview when enabled. */
export function providerRequestUrl(url: string): string {
  if (typeof __SUBSTREAM_LOCAL_PROVIDER_PROXY__ === "undefined" || !__SUBSTREAM_LOCAL_PROVIDER_PROXY__) return url;
  return "/__provider-proxy?url=" + encodeURIComponent(url);
}
