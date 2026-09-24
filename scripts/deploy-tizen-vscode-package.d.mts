export function readDeviceIp(options: {
  variant: "tizen3" | "tizen6";
  environment?: Record<string, string | undefined>;
  configurationPath: string;
}): string | undefined;

export function validateDeviceIp(value: string | undefined): boolean;

export function runStep(
  command: string,
  arguments_: string[],
  options?: Record<string, unknown>,
): void;
