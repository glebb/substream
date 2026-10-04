import type { PreferencesRepository } from "../contracts/repository.ts";
import { preferencesStorage } from "../platform/web/preferences-storage.ts";
import * as playlist from "../platform/browser/playlist-config.ts";
import * as subtitles from "../platform/browser/subtitle-preferences.ts";
import * as timing from "../platform/browser/subtitle-timing-config.ts";
import * as favourites from "../platform/browser/favourites-config.ts";
import * as progress from "../platform/browser/playback-progress-config.ts";
import * as catalog from "../platform/browser/catalog-preferences.ts";
import * as opensubtitles from "../platform/browser/opensubtitles-config.ts";
import * as tmdb from "../platform/browser/tmdb-config.ts";
import * as companion from "../platform/companion/client.ts";
import * as relay from "../platform/live-relay/config.ts";
import { loadUiLanguage, saveUiLanguage } from "../platform/web/ui-language-config.ts";

/** Binds existing preference policies to the runtime's device-owned persistence. */
export function createDeviceSettings(preferences: PreferencesRepository) {
  const storage = preferencesStorage(preferences);
  return {
    companionServerUrl: () => companion.companionServerUrl(storage),
    saveCompanionServerUrl: (value: string) => companion.saveCompanionServerUrl(value, storage),
    companionDeviceLabel: (id: string, fallback: string) => companion.companionDeviceLabel(id, fallback, storage),
    saveCompanionDeviceLabel: (id: string, label: string) => companion.saveCompanionDeviceLabel(id, label, storage),
    loadPlaylistUrl: () => playlist.loadPlaylistUrl(storage),
    savePlaylistUrl: (url: string) => playlist.savePlaylistUrl(url, storage),
    clearSavedPlaylistUrl: () => playlist.clearSavedPlaylistUrl(storage),
    loadUiLanguage: () => loadUiLanguage(storage),
    saveUiLanguage: (language: Parameters<typeof saveUiLanguage>[0]) => saveUiLanguage(language, storage),
    loadOpenSubtitlesApiKey: () => opensubtitles.loadOpenSubtitlesApiKey(storage),
    saveOpenSubtitlesApiKey: (value: string) => opensubtitles.saveOpenSubtitlesApiKey(value, storage),
    clearSavedOpenSubtitlesSettings: () => opensubtitles.clearSavedOpenSubtitlesSettings(storage),
    loadTmdbCredentials: () => tmdb.loadTmdbCredentials(storage),
    saveTmdbCredentials: (value: Parameters<typeof tmdb.saveTmdbCredentials>[0]) => tmdb.saveTmdbCredentials(value, storage),
    clearSavedTmdbCredentials: () => tmdb.clearSavedTmdbCredentials(storage),
    loadSubtitlePreferences: () => subtitles.loadSubtitlePreferences(storage),
    saveSubtitleLanguagePreference: (value: Parameters<typeof subtitles.saveSubtitleLanguagePreference>[0]) => subtitles.saveSubtitleLanguagePreference(value, storage),
    saveLastSubtitleLanguage: (value: string) => subtitles.saveLastSubtitleLanguage(value, storage),
    saveSubtitleFontSize: (value: number) => subtitles.saveSubtitleFontSize(value, storage),
    clearSubtitlePreferences: () => subtitles.clearSubtitlePreferences(storage),
    loadSubtitleTimingOffset: (id: string) => timing.loadSubtitleTimingOffset(id, storage),
    saveSubtitleTimingOffset: (id: string, seconds: number) => timing.saveSubtitleTimingOffset(id, seconds, storage),
    clearSubtitleTimingOffsets: () => timing.clearSubtitleTimingOffsets(storage),
    loadFavouriteGroupIds: () => favourites.loadFavouriteGroupIds(storage),
    hasSavedFavouriteGroupIds: () => favourites.hasSavedFavouriteGroupIds(storage),
    saveFavouriteGroupIds: (ids: readonly string[]) => favourites.saveFavouriteGroupIds(ids, storage),
    setFavouriteGroup: (id: string, enabled: boolean) => favourites.setFavouriteGroup(id, enabled, storage),
    clearFavouriteGroups: () => favourites.clearFavouriteGroups(storage),
    loadPlaybackHistory: () => progress.loadPlaybackHistory(storage),
    savePlaybackProgress: (item: Parameters<typeof progress.savePlaybackProgress>[0]) => progress.savePlaybackProgress(item, storage),
    removePlaybackProgress: (id: string) => progress.removePlaybackProgress(id, storage),
    clearPlaybackProgress: () => progress.clearPlaybackProgress(storage),
    wasCatalogCleared: () => catalog.wasCatalogCleared(storage),
    markCatalogCleared: () => catalog.markCatalogCleared(storage),
    clearCatalogClearedMarker: () => catalog.clearCatalogClearedMarker(storage),
    loadLiveRelayConfig: () => relay.loadLiveRelayConfig(storage),
    saveLiveRelayConfig: (config: Parameters<typeof relay.saveLiveRelayConfig>[0]) => relay.saveLiveRelayConfig(config, storage),
    clearLiveRelayConfig: () => relay.clearLiveRelayConfig(storage),
  };
}
