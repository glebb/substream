import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validCertificateHost(value) {
  if (typeof value !== "string" || value.length > 253 || /[\s/\\]/.test(value)) return false;
  if (isIP(value)) return true;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function createCompanionCertificate(host, directory = ".companion-certs") {
  if (!validCertificateHost(host)) throw new Error("Enter one LAN hostname or IP address for the certificate.");
  const outputDir = resolve(directory);
  const certPath = resolve(outputDir, "companion-cert.pem");
  const keyPath = resolve(outputDir, "companion-key.pem");
  if (existsSync(certPath) || existsSync(keyPath)) throw new Error("Certificate files already exist; move them aside before generating replacements.");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const sanType = isIP(host) ? "IP" : "DNS";
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "365",
    "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=${sanType}:${host}`,
  ], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  if (result.error || result.status !== 0) throw new Error("OpenSSL could not create the certificate. Install OpenSSL and try again.");
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o644);
  return { certPath, keyPath };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const host = process.argv[2] || "";
    const { certPath, keyPath } = createCompanionCertificate(host);
    console.log(`Created self-signed certificate for ${host}.`);
    console.log(`Set COMPANION_TLS_CERT=${certPath}`);
    console.log(`Set COMPANION_TLS_KEY=${keyPath}`);
    console.log("Clients must trust this certificate before HTTPS requests will work.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Certificate generation failed.");
    process.exitCode = 1;
  }
}
