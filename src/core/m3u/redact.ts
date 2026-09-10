const SENSITIVE_QUERY_KEYS = /^(?:auth|api[_-]?key|key|pass|password|token|username|user)$/i;
const CREDENTIAL_PATH_PREFIXES = new Set(["live", "movie", "series"]);

export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "REDACTED";
    if (parsed.password) parsed.password = "REDACTED";

    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) parsed.searchParams.set(key, "REDACTED");
    }

    const segments = parsed.pathname.split("/");
    const prefixIndex = segments.findIndex((segment) => CREDENTIAL_PATH_PREFIXES.has(segment.toLowerCase()));
    if (prefixIndex >= 0 && segments.length > prefixIndex + 2) {
      segments[prefixIndex + 1] = "REDACTED";
      segments[prefixIndex + 2] = "REDACTED";
      parsed.pathname = segments.join("/");
    }

    return parsed.toString();
  } catch {
    return "[invalid or redacted URL]";
  }
}
