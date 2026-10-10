import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeployment } from "./deploy.mjs";
import { deployPersonalWebos } from "./webos.mjs";

afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

describe("deployment dispatch", () => {
  it("keeps Tizen signing targets and selects a registered LG target or .env default", () => {
    expect(resolveDeployment(["tizen6"], {})).toEqual({ platform: "tizen", args: ["tizen6"] });
    expect(resolveDeployment(["tizen3", "192.0.2.10"], {})).toEqual({ platform: "tizen", args: ["tizen3", "192.0.2.10"] });
    expect(resolveDeployment(["lg-tv-example"], {})).toEqual({ platform: "webos", device: "lg-tv-example" });
    expect(resolveDeployment([], { LG_WEBOS_DEVICE: "lg-default" })).toEqual({ platform: "webos", device: "lg-default" });
    expect(resolveDeployment(["lg-explicit"], { LG_WEBOS_DEVICE: "lg-default" }).device).toBe("lg-explicit");
  });

  it("rejects missing targets, options and extra arguments without echoing private inputs", () => {
    for (const args of [[], ["--device"], ["lg-example", "private-secret"], ["lg-example;touch-file"]]) {
      expect(() => resolveDeployment(args, {})).toThrow(/Usage/);
      try { resolveDeployment(args, {}); } catch (error) { expect(error.message).not.toContain("private-secret"); }
    }
  });
});

describe("personal LG deployment", () => {
  function steps(packagePath = "/synthetic/private.ipk") {
    return { packageApp: vi.fn(() => packagePath), closeApp: vi.fn(), cliRun: vi.fn(() => true) };
  }

  it("builds a fresh personal package before closing, installing and launching the app", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hooks = steps();
    expect(deployPersonalWebos("lg-example", hooks)).toBe(true);
    expect(hooks.packageApp).toHaveBeenCalledWith(true);
    expect(hooks.cliRun.mock.calls).toEqual([
      ["ares-install", ["--device", "lg-example", "/synthetic/private.ipk"]],
      ["ares-launch", ["--device", "lg-example", "org.substream.app"]],
    ]);
    expect(hooks.packageApp.mock.invocationCallOrder[0]).toBeLessThan(hooks.closeApp.mock.invocationCallOrder[0]);
    expect(hooks.closeApp.mock.invocationCallOrder[0]).toBeLessThan(hooks.cliRun.mock.invocationCallOrder[0]);
  });

  it("does not touch the TV after packaging failure or launch after installation failure", () => {
    const failedBuild = steps(undefined);
    // Explicitly replace the default fixture with the failed package result.
    failedBuild.packageApp.mockReturnValue(undefined);
    expect(deployPersonalWebos("lg-example", failedBuild)).toBe(false);
    expect(failedBuild.closeApp).not.toHaveBeenCalled();
    expect(failedBuild.cliRun).not.toHaveBeenCalled();
    const failedInstall = steps();
    failedInstall.cliRun.mockReturnValue(false);
    expect(deployPersonalWebos("lg-example", failedInstall)).toBe(false);
    expect(failedInstall.cliRun).toHaveBeenCalledOnce();
  });

  it("rejects unsafe device arguments before building anything", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = steps();
    expect(deployPersonalWebos("--unexpected", hooks)).toBe(false);
    expect(hooks.packageApp).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
