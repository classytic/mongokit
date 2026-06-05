/**
 * Unit tests — `clearActiveOrganizationFromSessions`.
 *
 * The org-delete / member-removal integrity helper. Better Auth never clears
 * `session.activeOrganizationId` when an org is deleted or a member removed, so
 * a stale pointer makes `getActiveMember()` 404 (MEMBER_NOT_FOUND) and hangs
 * frontends that trust it. This helper nulls the pointer.
 *
 * Pure over its `SessionUpdaterLike` input — we assert the exact filter/update
 * it issues (the security-relevant part) with a captured-call fake, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  clearActiveOrganizationFromSessions,
  type SessionUpdaterLike,
} from '../../src/better-auth/index.js';

function fakeUpdater(modifiedCount: number) {
  const calls: Array<{ filter: unknown; update: unknown }> = [];
  const updater: SessionUpdaterLike = {
    updateMany: async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount };
    },
  };
  return { updater, calls };
}

describe('clearActiveOrganizationFromSessions', () => {
  it('org-wide: matches activeOrganizationId (string) and nulls it', async () => {
    const { updater, calls } = fakeUpdater(3);
    const n = await clearActiveOrganizationFromSessions(updater, 'org_123');

    expect(n).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].filter).toEqual({ activeOrganizationId: 'org_123' });
    expect(calls[0].update).toEqual({ $set: { activeOrganizationId: null } });
  });

  it('member-removal: scopes the match to a single user', async () => {
    const { updater, calls } = fakeUpdater(1);
    const userId = { _bsontype: 'ObjectId' }; // opaque — matched verbatim
    const n = await clearActiveOrganizationFromSessions(updater, 'org_123', { userId });

    expect(n).toBe(1);
    expect(calls[0].filter).toEqual({
      activeOrganizationId: 'org_123',
      userId,
    });
  });

  it('does NOT add a userId clause when userId is null/undefined', async () => {
    const { updater, calls } = fakeUpdater(0);
    await clearActiveOrganizationFromSessions(updater, 'org_123', { userId: null });
    await clearActiveOrganizationFromSessions(updater, 'org_123', { userId: undefined });

    for (const c of calls) {
      expect(c.filter).toEqual({ activeOrganizationId: 'org_123' });
      expect(Object.prototype.hasOwnProperty.call(c.filter, 'userId')).toBe(false);
    }
  });

  it('returns 0 when the driver reports no modifiedCount', async () => {
    const updater: SessionUpdaterLike = { updateMany: async () => ({}) };
    expect(await clearActiveOrganizationFromSessions(updater, 'org_123')).toBe(0);
  });
});
