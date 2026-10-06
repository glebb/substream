import { isFinnishLiveChannel, providerRelayChannelId } from "../core/live/relay-candidates.ts";
import { relayChannelId, type LiveRelayConfig } from "../platform/live-relay/config.ts";

export type LiveRelayRouteDecision = {
  channelId: string | null;
  evidence: "relay-disabled" | "manual-mapping" | "server-dvb-discovery" | "title-keyword" | "no-match";
};

/** Relay discovers DVB on the same upstream as video; never preflight provider media. */
export function resolveLiveRelayChannel(config: LiveRelayConfig | null, providerStreamId: string | number, name: string): LiveRelayRouteDecision {
  if (!config?.enabled) return { channelId: null, evidence: "relay-disabled" };
  const explicit = config.channelMappings?.[String(providerStreamId)];
  if (explicit) return { channelId: explicit, evidence: "manual-mapping" };
  if (isFinnishLiveChannel(name)) {
    const channelId = providerRelayChannelId(providerStreamId);
    return { channelId, evidence: channelId ? "server-dvb-discovery" : "no-match" };
  }
  const channelId = relayChannelId(config, providerStreamId, name);
  return { channelId, evidence: channelId ? "title-keyword" : "no-match" };
}
