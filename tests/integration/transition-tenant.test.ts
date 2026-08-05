/**
 * `applyTransition` under `multiTenantPlugin` — a wrong tenant must FAIL EXPLICITLY.
 *
 * ## Why this file exists
 *
 * `tests/integration/transition.test.ts` covers four of the five CAS-miss outcomes: illegal move
 * (machine error pre-flight), race-loss where the current state forbids the move (machine error with
 * an accurate `from`), race-loss where the move is still legal (409 `TRANSITION_RACE_LOST`), and a
 * missing row (404 `TRANSITION_TARGET_MISSING`). It has NO tenant coverage at all.
 *
 * That gap matters more than the others, because the tenant case is the one where a caller can be
 * confidently wrong: a transition addressed to the right id in the WRONG tenant is not a race and
 * not an illegal move — it is a scope mistake, and the only acceptable outcome is an explicit
 * failure. A silent no-op there would let a cross-tenant write report success, and the caller would
 * have no signal to retry or reject.
 *
 * The scenario that prompted it: a carrier webhook resolved a fulfilment, derived the wrong
 * organization, and transitioned. We needed to know whether a zero-match CAS could return stale
 * state as success. It cannot — this pins that.
 */
import { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { multiTenantPlugin, Repository, type TransitionMachine } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ITenantWo {
  _id: Types.ObjectId;
  organizationId?: Types.ObjectId | string;
  status: 'draft' | 'planned' | 'done';
  statusHistory?: Array<{ status: string; occurredAt: Date }>;
}

const TABLE: Record<string, string[]> = { draft: ['planned'], planned: ['done'], done: [] };

/** Hand-built, matching `transition.test.ts` — these tests prove no primitives import is needed. */
class IllegalMove extends Error {
  constructor(entityId: string, from: string, to: string) {
    super(`illegal ${from} -> ${to} on ${entityId}`);
    this.name = 'IllegalMove';
  }
}
const MACHINE: TransitionMachine = {
  name: 'tenant_wo',
  assertTransition(entityId, from, to) {
    if (!TABLE[from]?.includes(to)) throw new IllegalMove(entityId, from, to);
  },
};

const ORG_A = '6a70000000000000000000a1';
const ORG_B = '6a70000000000000000000b2';

describe('applyTransition + multiTenantPlugin', () => {
  let repo: Repository<ITenantWo>;

  beforeAll(async () => {
    await connectDB();
    const model = await createTestModel(
      'TransitionTenantWo',
      new Schema<ITenantWo>({
        organizationId: { type: Schema.Types.ObjectId },
        status: { type: String, required: true },
        statusHistory: {
          type: [new Schema({ status: String, occurredAt: Date }, { _id: false })],
          default: [],
        },
      }),
    );
    repo = new Repository<ITenantWo>(model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: false, fieldType: 'objectId' }),
    ]);
  });
  afterAll(async () => {
    await disconnectDB();
  });

  const mk = (organizationId: string) =>
    repo.create(
      { organizationId, status: 'draft', statusHistory: [{ status: 'draft', occurredAt: new Date() }] },
      { organizationId },
    );

  it('transitions in the OWNING tenant', async () => {
    const wo = await mk(ORG_A);
    const updated = await repo.applyTransition(
      String(wo._id),
      MACHINE,
      { from: 'draft', to: 'planned' },
      { organizationId: ORG_A },
    );
    expect(updated.status).toBe('planned');
  });

  it('THE GAP: a WRONG tenant fails explicitly — never a silent no-op, never stale-as-success', async () => {
    const wo = await mk(ORG_A);

    /**
     * The row exists and the move is legal; only the tenant is wrong. `applyTransition` must not
     * return the unchanged document — a caller that received it would treat a cross-tenant miss as a
     * completed transition.
     *
     * It surfaces as `TRANSITION_TARGET_MISSING` (404) rather than a tenant-specific code because
     * from inside the tenant scope the row genuinely does not exist, which is the honest answer.
     */
    const err = await repo
      .applyTransition(String(wo._id), MACHINE, { from: 'draft', to: 'planned' }, { organizationId: ORG_B })
      .then(
        (doc) => ({ threw: false as const, doc }),
        (e: unknown) => ({ threw: true as const, e: e as { code?: string; statusCode?: number } }),
      );

    expect(err.threw, 'a wrong-tenant transition returned instead of throwing').toBe(true);
    if (err.threw) {
      expect(err.e.code).toBe('TRANSITION_TARGET_MISSING');
    }

    // And the row is UNTOUCHED in its real tenant — the failed call wrote nothing.
    const still = await repo.getById(String(wo._id), { organizationId: ORG_A });
    expect(still?.status).toBe('draft');
  });

  it('is idempotent-convergent on REPLAY: the second identical transition throws, it does not silently pass', async () => {
    const wo = await mk(ORG_A);
    await repo.applyTransition(
      String(wo._id),
      MACHINE,
      { from: 'draft', to: 'planned' },
      { organizationId: ORG_A },
    );

    /**
     * A replay is `draft → planned` against a row already at `planned`. The machine has no
     * `planned → planned` edge, so this must raise rather than report a second success — a caller
     * needing idempotence checks the CURRENT state first (which is what the carrier-webhook applier
     * does) instead of relying on a forgiving CAS.
     */
    const replay = await repo
      .applyTransition(String(wo._id), MACHINE, { from: 'draft', to: 'planned' }, { organizationId: ORG_A })
      .then(
        () => ({ threw: false as const }),
        () => ({ threw: true as const }),
      );
    expect(replay.threw).toBe(true);

    const after = await repo.getById(String(wo._id), { organizationId: ORG_A });
    expect(after?.status).toBe('planned');
  });
});
