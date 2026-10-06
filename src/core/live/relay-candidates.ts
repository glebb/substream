/** Finnish provider naming scope; this is eligibility, not subtitle evidence. */
export function isFinnishLiveChannel(name: string): boolean {
  return /^\s*(?:FI|FIN|FINLAND)\s*:/i.test(name);
}

/** Stable server-owned ID. Never pass a provider URL to the relay. */
export function providerRelayChannelId(providerStreamId: string | number): string | null {
  const id = String(providerStreamId);
  return /^\d{1,20}$/.test(id) ? `stream-${id}` : null;
}
