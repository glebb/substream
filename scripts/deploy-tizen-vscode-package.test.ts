import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDeviceIp, validateDeviceIp } from "./deploy-tizen-vscode-package.mjs";

describe("Tizen VS Code deploy configuration", () => {
  it("reads the matching device IP and ignores comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "substream-tizen-devices-"));
    const configurationPath = join(directory, ".tizen-devices.local");
    writeFileSync(configurationPath, "# TVs\nTIZEN3_TV_IP=192.168.1.39\nTIZEN6_TV_IP=192.168.1.108\n");

    expect(readDeviceIp({ variant: "tizen3", environment: {}, configurationPath })).toBe("192.168.1.39");
    expect(readDeviceIp({ variant: "tizen6", environment: {}, configurationPath })).toBe("192.168.1.108");
  });

  it("lets an environment value override the local file", () => {
    expect(readDeviceIp({
      variant: "tizen6",
      environment: { TIZEN6_TV_IP: "10.0.0.8" },
      configurationPath: "/missing",
    })).toBe("10.0.0.8");
  });

  it("accepts valid IPv4 addresses and rejects unsafe values", () => {
    expect(validateDeviceIp("192.168.1.108")).toBe(true);
    expect(validateDeviceIp("192.168.1.999")).toBe(false);
    expect(validateDeviceIp("192.168.1.108; echo nope")).toBe(false);
  });
});
