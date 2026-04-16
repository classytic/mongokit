/**
 * E2E safety helpers.
 *
 * Tests under `tests/e2e/` talk to a real MongoDB deployment (Atlas). This
 * module enforces a hard gate so they can only run against a URI that is
 * demonstrably *not* production.
 *
 * The rule is intentionally conservative:
 *   - MONGOKIT_E2E_URI must be set (tests are skipped otherwise).
 *   - The URI, parsed case-insensitively, must NOT contain any forbidden
 *     substring (`prod`, `production`, `live`, `bigboss`).
 *   - The database path segment must end with one of the approved suffixes
 *     (`-test`, `-e2e`, `-ci`, `-sandbox`).
 *
 * Rotating to bypass this check is a deliberate action: either widen the
 * allowlist intentionally, or rename your test DB to match. The check is
 * there to protect the data, not to be clever.
 */

const FORBIDDEN_SUBSTRINGS = ['prod', 'production', 'live', 'bigboss'];
const APPROVED_DB_SUFFIXES = ['-test', '-e2e', '-ci', '-sandbox'];

export interface E2eGate {
  /** Safe URI to connect with, if available. */
  uri?: string;
  /** True when the env is configured and the URI passed all safety checks. */
  enabled: boolean;
  /** Human-readable reason when disabled — prints on skipIf messages. */
  reason?: string;
}

/**
 * Inspect the current env and return a gate descriptor. Tests should
 * `describe.skipIf(!gate.enabled)` on this so CI that lacks an E2E URI
 * (the default) silently skips without failing.
 *
 * NEVER throws — prod protection is structural, not via exceptions.
 */
export function resolveE2eGate(): E2eGate {
  const raw = process.env.MONGOKIT_E2E_URI;
  if (!raw) {
    return { enabled: false, reason: 'MONGOKIT_E2E_URI is not set' };
  }

  const uri = raw.trim();
  if (uri.length === 0) {
    return { enabled: false, reason: 'MONGOKIT_E2E_URI is empty' };
  }

  const lower = uri.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(needle)) {
      return {
        enabled: false,
        reason: `E2E URI contains forbidden substring "${needle}" — refusing to connect. Point MONGOKIT_E2E_URI at a dedicated test cluster and test database.`,
      };
    }
  }

  // Extract the database name — last path segment before `?`.
  // Accept both mongodb:// and mongodb+srv://.
  const dbMatch = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  const dbName = dbMatch ? dbMatch[1] : undefined;
  if (!dbName) {
    return {
      enabled: false,
      reason: 'E2E URI does not include a database name — expected mongodb(+srv)://host/<dbName>',
    };
  }

  const dbLower = dbName.toLowerCase();
  if (!APPROVED_DB_SUFFIXES.some((s) => dbLower.endsWith(s))) {
    return {
      enabled: false,
      reason: `E2E database name "${dbName}" must end with one of ${APPROVED_DB_SUFFIXES.join(', ')} (got no approved suffix)`,
    };
  }

  return { enabled: true, uri };
}

/**
 * Build a collection-name prefix unique to this test file so parallel e2e
 * runs don't collide on a shared test cluster. Caller passes a short,
 * stable identifier — typically the file subject.
 */
export function e2eCollectionPrefix(subject: string): string {
  const sanitized = subject.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  // A random suffix prevents collisions across CI runs retaining stale state.
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e_${sanitized}_${rand}_`;
}
