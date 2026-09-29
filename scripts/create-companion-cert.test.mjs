import { describe, expect, it } from "vitest";
import { validCertificateHost } from "./create-companion-cert.mjs";

describe("companion certificate host validation", () => {
  it("accepts a single DNS name or IP address", () => {
    expect(validCertificateHost("relay.home.arpa")).toBe(true);
    expect(validCertificateHost("192.0.2.10")).toBe(true);
    expect(validCertificateHost("2001:db8::10")).toBe(true);
  });

  it("rejects paths, whitespace, and malformed hostnames", () => {
    expect(validCertificateHost("relay.home.arpa/other")).toBe(false);
    expect(validCertificateHost("relay home.arpa")).toBe(false);
    expect(validCertificateHost("-relay.home.arpa")).toBe(false);
    expect(validCertificateHost("..")).toBe(false);
  });
});
