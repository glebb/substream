import { stableId } from "../catalog/normalize.ts";

/** URL fields extracted by a platform adapter. Credentials are inputs only. */
export type XtreamPlaylistParts = {
  origin: string;
  pathname: string;
  username: string;
  password: string;
};

/** Credential-free provider metadata that is safe to retain or exchange. */
export type XtreamConnectionMetadata = {
  apiUrl: string;
  streamBaseUrl: string;
  sourceFingerprint: string;
  pairingFingerprint: string;
};

/**
 * Derive the shared connection endpoints and identities from URL parts already
 * parsed by a platform adapter. Usernames and passwords are never returned.
 */
export function xtreamConnectionMetadata(parts: XtreamPlaylistParts): XtreamConnectionMetadata | null {
  const { origin, pathname, username, password } = parts;
  if (!origin || !pathname || !username || !password || !/\/get\.php$/i.test(pathname)) return null;
  const apiPath = pathname.replace(/get\.php$/i, "player_api.php");
  const identity = origin + apiPath;
  return {
    apiUrl: identity,
    streamBaseUrl: origin + pathname.slice(0, pathname.lastIndexOf("/") + 1),
    sourceFingerprint: stableId(identity),
    pairingFingerprint: stableId(identity + "\0" + username),
  };
}
