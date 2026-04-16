/**
 * URL policy helpers for the vector plugin media pipeline.
 *
 * Protects callers from passing hostile document URLs straight into an
 * embedding service that may fetch them. The policy is pure / side-effect-
 * free so it can be reused by anyone composing their own embed pipeline.
 */

/**
 * Returns true when the string is a safe media URL under the given policy.
 *
 * - Non-URL strings (data URLs, base64 blobs, relative paths) are accepted —
 *   they never trigger an outbound HTTP fetch, so SSRF isn't a concern.
 * - `data:` URLs are accepted.
 * - `http` / `https` URLs must pass:
 *     a) origin allowlist (if `allowedOrigins` is set)
 *     b) private-IP rejection (if `blockPrivateIpUrls` is true)
 *
 * Any parse failure returns `true` only when strict mode is off — a string
 * that doesn't parse as a URL cannot be used to SSRF either. In strict mode
 * (either option set), unparseable http(s)-looking strings are rejected.
 */
export function isMediaUrlAllowed(
  value: string,
  policy: {
    allowedOrigins?: string[];
    blockPrivateIpUrls?: boolean;
  } = {},
): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('data:')) return true;

  // Only validate URLs we'd actually fetch. Relative paths, base64 blobs,
  // filesystem paths — those are someone else's problem.
  const looksLikeHttpUrl = /^https?:\/\//i.test(value);
  if (!looksLikeHttpUrl) {
    // If strict policy is active and the caller clearly tried to pass a URL,
    // require it to be parseable.
    return true;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (policy.blockPrivateIpUrls && isPrivateOrLocalHost(url.hostname)) {
    return false;
  }

  if (policy.allowedOrigins && policy.allowedOrigins.length > 0) {
    const origin = `${url.protocol}//${url.host}`; // includes :port if present
    const ok = policy.allowedOrigins.some((entry) => matchesOriginEntry(origin, entry, url));
    if (!ok) return false;
  }

  return true;
}

function matchesOriginEntry(origin: string, entry: string, url: URL): boolean {
  if (!entry) return false;

  // Exact origin match: "https://cdn.example.com"
  if (entry === origin) return true;

  // Wildcard host match: "https://*.example.com" — compare protocol then
  // ensure the URL's host ends with the suffix after the star.
  const wildcardMatch = entry.match(/^(https?:)\/\/\*\.(.+)$/i);
  if (wildcardMatch) {
    const [, entryProtocol, suffix] = wildcardMatch;
    if (url.protocol.toLowerCase() !== entryProtocol.toLowerCase()) return false;
    return url.hostname.toLowerCase().endsWith('.' + suffix.toLowerCase());
  }

  return false;
}

/**
 * Literal-IP private/loopback/link-local checks. Does NOT perform DNS
 * resolution — callers who need rebinding-proof behavior must handle that
 * at the HTTP layer.
 */
function isPrivateOrLocalHost(hostname: string): boolean {
  // URL.hostname wraps IPv6 literals in square brackets — strip them before
  // matching (`[::1]` → `::1`).
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv6 loopback / link-local / unique-local.
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  // Localhost aliases.
  if (h === 'localhost' || h === 'localhost.localdomain') return true;

  // IPv4 literal?
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;
  const [a, b] = octets;

  if (a === 10) return true; // RFC1918 10/8
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10

  return false;
}
