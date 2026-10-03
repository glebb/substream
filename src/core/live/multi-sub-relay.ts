/** Provider naming rule shared by personal Tizen builds and relay setup. */
export function classifyMultiSubChannel(name: string, providerStreamId: string): {
  channelId: string | null;
  evidence: { kind: "title-keyword" | "no-match"; value: string };
} {
  const matched = /\bmulti[\s-]*sub\b/i.test(name);
  return matched
    ? { channelId: `stream-${providerStreamId}`, evidence: { kind: "title-keyword", value: name } }
    : { channelId: null, evidence: { kind: "no-match", value: name } };
}
