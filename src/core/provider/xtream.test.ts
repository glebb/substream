import { describe, expect, it } from "vitest";
import { xtreamConnectionMetadata } from "./xtream.ts";

describe("Xtream connection metadata", () => {
  it("derives endpoint paths and credential-free identities", () => {
    const metadata = xtreamConnectionMetadata({
      origin: "https://iptv.example",
      pathname: "/portal/get.php",
      username: "alice",
      password: "secret",
    });
    expect(metadata).toEqual({
      apiUrl: "https://iptv.example/portal/player_api.php",
      streamBaseUrl: "https://iptv.example/portal/",
      sourceFingerprint: expect.stringMatching(/^vod_[a-z0-9]+$/),
      pairingFingerprint: expect.stringMatching(/^vod_[a-z0-9]+$/),
    });
    expect(JSON.stringify(metadata)).not.toContain("alice");
    expect(JSON.stringify(metadata)).not.toContain("secret");
  });

  it("separates server identity from account identity and ignores password rotation", () => {
    const make = (username: string, password: string) => xtreamConnectionMetadata({
      origin: "https://iptv.example", pathname: "/get.php", username, password,
    })!;
    expect(make("alice", "secret").sourceFingerprint).toBe(make("bob", "other").sourceFingerprint);
    expect(make("alice", "secret").pairingFingerprint).not.toBe(make("bob", "other").pairingFingerprint);
    expect(make("alice", "secret").pairingFingerprint).toBe(make("alice", "rotated").pairingFingerprint);
  });

  it("rejects incomplete credentials and non-Xtream paths", () => {
    const base = { origin: "https://iptv.example", pathname: "/get.php", username: "u", password: "p" };
    expect(xtreamConnectionMetadata({ ...base, pathname: "/playlist.m3u" })).toBeNull();
    expect(xtreamConnectionMetadata({ ...base, username: "" })).toBeNull();
    expect(xtreamConnectionMetadata({ ...base, password: "" })).toBeNull();
  });
});
