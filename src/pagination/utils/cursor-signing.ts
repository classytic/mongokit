/**
 * HMAC signing for pagination cursors.
 *
 * ## What this protects, and what it does not
 *
 * A cursor is a POSITION, and the server's own filters decide what a caller may
 * read — so a stolen or shared cursor cannot reach another tenant's rows, and
 * signing is not a substitute for scoping. What an unsigned cursor gives away
 * is the ability to MOVE the position: edit the encoded sort value, re-submit,
 * and the response says whether any row sorts past it. Repeat, and that is a
 * binary search over a column the caller can never read directly — "where do
 * salaries above X start", against a list that only ever showed them names.
 *
 * Signing closes that. It does NOT hide the cursor's contents: the payload is
 * still base64url JSON and still readable by anyone holding the token, field
 * names included. **Signing is integrity, not confidentiality.** A deployment
 * that must not reveal which column it sorts by needs encryption, which this is
 * not.
 *
 * ## The rules that make it worth having
 *
 * - **A configured secret makes a signature REQUIRED.** Accepting an unsigned
 *   token "for compatibility" means an attacker strips the signature and the
 *   protection evaporates while still looking enabled — the exact shape of a
 *   specific instruction defeated by a general default.
 * - **An unusable secret THROWS.** `cursorSecret: ''` (an unset env var read
 *   without a check) would otherwise mean "signing on, key guessable", and
 *   nothing would say so.
 * - **Comparison is timing-safe.** `===` on a signature leaks it byte by byte
 *   to anyone willing to time the responses.
 * - **Rotation takes a list.** Sign with the first, accept any — otherwise
 *   changing the key invalidates every cursor a client is holding.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** One key, or several during a rotation (the FIRST signs; all verify). */
export type CursorSecret = string | readonly string[];

/**
 * Separator between payload and signature.
 *
 * `.` is not in the base64url alphabet, so it cannot appear inside either half
 * — the split is unambiguous without escaping, and the whole token stays
 * URL-safe.
 */
const SEPARATOR = '.';

/**
 * A key shorter than this is not a key. Chosen to match the HMAC-SHA256 block
 * consideration loosely, but the real point is to reject `''`, `'secret'` and
 * `'changeme'` — the values that appear when an env var was never set.
 */
const MIN_SECRET_LENGTH = 16;

/**
 * Normalise a configured secret into the keys that sign and verify.
 *
 * Throws rather than falling back: every failure mode here — an empty string, a
 * list of empty strings, a two-character placeholder — describes a deployment
 * that BELIEVES it is signing cursors. Returning "unsigned" quietly is how it
 * would keep believing that.
 */
export function resolveCursorSecrets(secret: CursorSecret | undefined): string[] | undefined {
  if (secret === undefined || secret === null) return undefined;
  const keys = (Array.isArray(secret) ? secret : [secret as string]).map((k) => String(k ?? ''));
  if (keys.length === 0) {
    throw new Error('cursorSecret: an empty list cannot sign anything — omit it, or supply a key');
  }
  const tooShort = keys.find((k) => k.trim().length < MIN_SECRET_LENGTH);
  if (tooShort !== undefined) {
    throw new Error(
      `cursorSecret: every key must be at least ${MIN_SECRET_LENGTH} characters ` +
        `(got one of length ${tooShort.trim().length}). An unset environment variable reads as ` +
        `an empty string, which would sign every cursor with a key anyone can guess.`,
    );
  }
  return keys;
}

/** The raw HMAC of a payload under one key, base64url. */
function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

/**
 * Append a signature to an encoded payload.
 *
 * Returns the payload unchanged when no secret is configured, so a deployment
 * that does not sign is byte-for-byte unaffected.
 */
export function attachSignature(payload: string, secrets: string[] | undefined): string {
  if (!secrets) return payload;
  return payload + SEPARATOR + sign(payload, secrets[0]);
}

/** Split a token into its payload and signature halves. */
function split(token: string): { payload: string; signature: string | undefined } {
  const at = token.lastIndexOf(SEPARATOR);
  if (at === -1) return { payload: token, signature: undefined };
  return { payload: token.slice(0, at), signature: token.slice(at + 1) };
}

/** Constant-time equality. `timingSafeEqual` throws on a length mismatch, which is itself a leak-free "no". */
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a token and return the payload to decode.
 *
 * - **No secret configured** → any signature present is stripped and ignored.
 *   Turning signing off must not reject the tokens issued while it was on, or
 *   a rollback breaks every client mid-page.
 * - **Secret configured** → a valid signature is mandatory. A missing one and a
 *   wrong one are reported differently ON PURPOSE: they mean different things to
 *   whoever is debugging (a config mismatch versus a rotated key or a tampered
 *   token), and neither message helps anyone forge one.
 */
export function verifySignature(token: string, secrets: string[] | undefined): string {
  const { payload, signature } = split(token);
  if (!secrets) return payload;

  if (signature === undefined) {
    throw new Error(
      'Invalid cursor token: this deployment signs cursors and this one carries no signature',
    );
  }
  for (const key of secrets) {
    if (matches(signature, sign(payload, key))) return payload;
  }
  throw new Error(
    'Invalid cursor token: signature does not verify (tampered, or issued under a retired key)',
  );
}

/**
 * Whether cursor signing is switched on. Callers use it to refuse the shapes
 * that BYPASS signing rather than break it — a bare ObjectId is a perfectly
 * valid position that carries no signature at all.
 */
export function signingRequired(secrets: string[] | undefined): boolean {
  return secrets !== undefined;
}
