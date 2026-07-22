/**
 * Change-Log Plugin — capture side of `@classytic/repo-core/sync`.
 *
 * Appends a `ChangeEntry` to a host-provided `ChangeLogStore` on every
 * document write, so offline clients / replicas can pull deltas by cursor
 * (`arc-sync`-style pull/push). The durable sibling of `repo.watch()`:
 * watch() streams live Mongo change events; this plugin writes a REPLAYABLE,
 * storage-agnostic feed with tombstones.
 *
 *   const repo = new Repository(Model, [
 *     changeLogPlugin({ store, scope: 'pos-order' }),
 *   ]);
 *
 * Semantics (contract rules in repo-core/src/sync):
 *   - create/createMany/update → `upsert` entries carrying the full doc
 *   - delete                   → `delete` TOMBSTONE (no doc)
 *   - `context.session` is passed through to `store.append` so a durable
 *     store can persist the entry ATOMICALLY with the business write
 *   - version: `doc[versionField]` (kernels carry `version`) →
 *     `__v` → `updatedAt` epoch — monotonic per document either way
 *
 * Deliberate v1 limits (documented, not silent). Captured verbs are EXACTLY
 * `create` / `createMany` / `update` / `delete`. NOT captured:
 *   - `updateMany` / `deleteMany` / `bulkWrite` — bulk ops return no per-doc
 *     results, so per-document entries cannot be built.
 *   - `findOneAndUpdate` / `claim` / `claimVersion` — CAS verbs may return
 *     PROJECTED (partial) docs via `fields`, and an `upsert` entry must
 *     carry the full doc; capturing a projection would corrupt replicas.
 *   - `getOrCreate` / `restore`, and mongo-operations helpers
 *     (`increment`, `pushToArray`, ...) — not wired in v1.
 * Surfaces meant for offline sync should write through the four captured
 * verbs (POS-style flows do). Honors `skipPlugins: ['changeLog']` for
 * hot-path opt-out, same as auditLog.
 */
import type { ChangeLogStore } from '@classytic/repo-core/sync';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';

const PLUGIN_NAME = 'changeLog';

export interface ChangeLogPluginOptions {
  /** Durable feed implementing the repo-core/sync contract. */
  store: ChangeLogStore;
  /** Logical scope for entries (resource name a client subscribes to). */
  scope: string;
  /** Tenant partition field on docs/context. Default `organizationId`. */
  tenantField?: string;
  /** Monotonic per-doc version field. Default `version` (kernel convention). */
  versionField?: string;
}

function isSkipped(context: RepositoryContext): boolean {
  const list = context.skipPlugins as readonly string[] | undefined;
  return Array.isArray(list) && list.includes(PLUGIN_NAME);
}

export function changeLogPlugin(options: ChangeLogPluginOptions): Plugin {
  const { store, scope, tenantField = 'organizationId', versionField = 'version' } = options;

  const toRecord = (doc: unknown): Record<string, unknown> | null => {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { toObject?: () => Record<string, unknown> };
    return typeof d.toObject === 'function' ? d.toObject() : (doc as Record<string, unknown>);
  };

  const versionOf = (doc: Record<string, unknown>): number => {
    const v = doc[versionField] ?? doc.__v;
    if (typeof v === 'number') return v;
    const updatedAt = doc.updatedAt;
    return updatedAt instanceof Date ? updatedAt.getTime() : 0;
  };

  const tenantOf = (
    doc: Record<string, unknown>,
    context: RepositoryContext,
  ): string | undefined => {
    const raw = doc[tenantField] ?? context.organizationId;
    return raw === undefined || raw === null ? undefined : String(raw);
  };

  const capture = async (
    op: 'upsert' | 'delete',
    doc: unknown,
    context: RepositoryContext,
  ): Promise<void> => {
    const record = toRecord(doc);
    if (!record || record._id === undefined) return;
    const tenantId = tenantOf(record, context);
    await store.append(
      {
        scope,
        docId: String(record._id),
        op,
        version: versionOf(record),
        ...(op === 'upsert' ? { doc: record } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
      context.session !== undefined ? { session: context.session } : undefined,
    );
  };

  return {
    name: PLUGIN_NAME,
    apply(repo: RepositoryInstance): void {
      repo.on(
        'after:create',
        async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context) || !result) return;
          await capture('upsert', result, context);
        },
      );

      repo.on(
        'after:createMany',
        async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context) || !Array.isArray(result)) return;
          for (const doc of result) await capture('upsert', doc, context);
        },
      );

      repo.on(
        'after:update',
        async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context) || !result) return; // null = not found — nothing changed
          await capture('upsert', result, context);
        },
      );

      repo.on(
        'after:delete',
        async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context) || !result) return; // null = not found
          // Delete returns a summary ({ message, id }), not the doc — build the
          // TOMBSTONE from the id. Version on a tombstone is advisory (clients
          // remove unconditionally; deletes don't rebase), so 0 is fine.
          const summary = result as { id?: unknown };
          const ctxId = (context as RepositoryContext & { id?: unknown }).id;
          const docId = summary.id ?? ctxId;
          if (docId === undefined || docId === null) return;
          const tenantRaw = context.organizationId;
          await store.append(
            {
              scope,
              docId: String(docId),
              op: 'delete',
              version: 0,
              ...(tenantRaw !== undefined && tenantRaw !== null
                ? { tenantId: String(tenantRaw) }
                : {}),
            },
            context.session !== undefined ? { session: context.session } : undefined,
          );
        },
      );
    },
  };
}
