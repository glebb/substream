import type { CompanionEventWire, CompanionSelectionWire, CompanionLocalMediaWire } from "../core/companion-protocol.mjs";

export type CompanionSelection = CompanionSelectionWire;
export type CompanionEvent = CompanionEventWire;
export type CompanionEventsResult = { protocolVersion: 4; events: CompanionEvent[]; paired: boolean; retentionGap: { throughSequence: number; firstAvailableSequence: number } | null };
export type CompanionDeviceIdentity = { deviceId: string; deviceName: string };
export type CompanionCapabilities = { localMedia: boolean };
export type CompanionConnection = CompanionDeviceIdentity & { tvCredential: string; pairingCode: string; pairingExpiresAt: number; expiresAt: number; sourceFingerprint: string; capabilities: CompanionCapabilities; paired: boolean };
export type ActiveCompanionConnection = CompanionDeviceIdentity & { expiresAt: number; sourceFingerprint: string; capabilities: CompanionCapabilities };
export type BrowserCompanionConnection = ActiveCompanionConnection & { browserCredential: string };
export type CompanionPlaybackSelection = Omit<CompanionSelection, "kind" | "seriesId"> & ({ kind: "movie" } | { kind: "episode"; seriesId: string });
export type CompanionLocalPlayback = CompanionLocalMediaWire;
export type CompanionLocalSubtitle = { version: number; text: string; label: string; language: string; enabled: boolean; offsetSeconds: number };

