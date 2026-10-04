import type { PreferencesRepository, TransportRepository } from "../../contracts/repository.ts";
import { browserStorage, preferencesStorage } from "../web/preferences-storage.ts";
import { CompanionController } from "../../application/companion-controller.ts";
import { createAbortController } from "../abort-controller.ts";
import { XtreamClient } from "../xtream/client.ts";
import { acknowledgeCompanionEvents, companionDeviceIdentity, companionEvents, companionSelectionTitle, connectCompanionService, resetCompanionPairing, storedCompanionTvCredential, storeCompanionTvCredential } from "./client.ts";

export function createCompanionController(playlistUrl: () => string, runtime?: { preferences: PreferencesRepository; transport: TransportRepository }): CompanionController {
  const storage = runtime ? preferencesStorage(runtime.preferences) : browserStorage();
  const request = runtime?.transport.fetch ?? fetch;
  return new CompanionController({
    identity: () => companionDeviceIdentity(storage),
    connect: (server, fingerprint, identity, credential) => connectCompanionService(server, fingerprint, identity, credential, request),
    events: (server, credential, after, signal) => companionEvents(server, credential, after, { ...(signal ? { signal } : {}), request }),
    acknowledge: (server, credential, sequence) => acknowledgeCompanionEvents(server, credential, sequence, request),
    reset: (server, credential) => resetCompanionPairing(server, credential, request),
    loadCredential: (server) => storedCompanionTvCredential(server, storage),
    saveCredential: (server, credential) => storeCompanionTvCredential(server, credential, storage),
    resolveSelection: (selection) => {
      const client = XtreamClient.fromPlaylistUrl(playlistUrl());
      if (!client || selection.sourceFingerprint !== client.pairingFingerprint()) return null;
      const title = companionSelectionTitle(selection);
      if (!title) return null;
      title.streamUrl = client.streamUrlFor(title.contentType === "movie" ? "movie" : "series", selection.id, selection.extension);
      return title;
    },
    createAbortController,
    now: Date.now,
  });
}
