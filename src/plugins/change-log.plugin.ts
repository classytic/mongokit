/**
 * Change-Log Plugin — capture side of `@classytic/repo-core/sync`. Every write through the
 * repository appends a `ChangeEntry` to the host's `ChangeLogStore`, in the write's session when it
 * has one, so offline clients pull exact deltas by cursor.
 *
 *   const repo = new Repository(Model, [changeLogPlugin({ store, scope: 'pos-order' })]);
 *
 * Every verb that changes documents is captured — a feed that misses a verb hands every replica a
 * plausible, stale copy:
 *   - create / createMany / update (and the `increment`-style helpers, which route through update)
 *     → `upsert` with the full document
 *   - claim / claimVersion / findOneAndUpdate / getOrCreate / restore → the document re-read by id
 *     in the same session (these verbs may return a projection; an entry must carry the whole doc)
 *   - updateMany / bulkWrite → each target document, its ids taken before the write and re-read
 *     after; deleteMany → tombstones (an upsert when a soft delete leaves the document)
 *   - delete → `delete` tombstone
 *   - purge's anonymize (`after:anonymize`) → each anonymised document, re-read
 *
 * For exact many-document capture run the write in a transaction: ids are read before the write,
 * and only a transaction keeps another writer from matching in between. Honors
 * `skipPlugins: ['changeLog']`.
 */
import type { ChangeLogStore } from '@classytic/repo-core/sync';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';

const PLUGIN_NAME = 'changeLog';
/** Marks a repository already captured: the store and scope it writes to. */
const CAPTURED = Symbol.for('mongokit.changeLog.capture');
/** Where `before:updateMany` / `before:deleteMany` leave the ids they matched for the after hook. */
const MATCHED_IDS = Symbol('changeLog.matchedIds');

export interface ChangeLogPluginOptions {
  /** Durable feed implementing the repo-core/sync contract. */
  store: ChangeLogStore;
  /** Logical scope for entries (resource name a client subscribes to). */
  scope: string;
  /** Tenant partition field on docs/context. Default `organizationId`. */
  tenantField?: string;
  /** Monotonic per-doc version field. Default `version` (kernel convention). */
  versionField?: string;
  /**
   * The document as a subscriber may see it — fields picked, secrets (a cost price) dropped. Tenant
   * and version are still read from the whole document. Default: the whole document.
   */
  project?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

type Ctx = RepositoryContext & { [MATCHED_IDS]?: unknown[] };

function isSkipped(context: RepositoryContext): boolean {
  const list = context.skipPlugins as readonly string[] | undefined;
  return Array.isArray(list) && list.includes(PLUGIN_NAME);
}

export function changeLogPlugin(options: ChangeLogPluginOptions): Plugin {
  const { store, scope, tenantField = 'organizationId', versionField = 'version', project } = options;

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

  const tenantOf = (doc: Record<string, unknown> | null, context: RepositoryContext): string | undefined => {
    const raw = doc?.[tenantField] ?? context.organizationId;
    return raw === undefined || raw === null ? undefined : String(raw);
  };

  const appendOptions = (context: RepositoryContext) =>
    context.session !== undefined ? { session: context.session } : undefined;

  const upsert = async (doc: unknown, context: RepositoryContext): Promise<void> => {
    const record = toRecord(doc);
    if (!record || record._id === undefined) return;
    const tenantId = tenantOf(record, context);
    await store.append(
      {
        scope,
        docId: String(record._id),
        op: 'upsert',
        version: versionOf(record),
        doc: project ? project(record) : record,
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
      appendOptions(context),
    );
  };

  const tombstone = async (docId: unknown, context: RepositoryContext): Promise<void> => {
    if (docId === undefined || docId === null) return;
    const tenantId = tenantOf(null, context);
    // A tombstone's version is advisory: clients remove unconditionally.
    await store.append({ scope, docId: String(docId), op: 'delete', version: 0, ...(tenantId !== undefined ? { tenantId } : {}) }, appendOptions(context));
  };

  return {
    name: PLUGIN_NAME,
    apply(repo: RepositoryInstance): void {
      // A second capture on one repository writes every change twice — refuse it. The SAME capture
      // again (an app booted twice over a memoised repository) is already in place.
      const marked = repo as RepositoryInstance & { [CAPTURED]?: { store: ChangeLogStore; scope: string } };
      const existing = marked[CAPTURED];
      if (existing) {
        if (existing.store === store && existing.scope === scope) return;
        throw new Error(`[mongokit] changeLogPlugin is already capturing this repository as "${existing.scope}"`);
      }
      marked[CAPTURED] = { store, scope };
      /** The whole document as committed in this session — never a projection. */
      const reread = async (id: unknown, context: RepositoryContext) => {
        const query = repo.Model.findById(id).lean();
        if (context.session !== undefined) query.session(context.session as never);
        return query.exec();
      };
      const matchingIds = async (context: RepositoryContext, filter: unknown): Promise<unknown[]> => {
        const query = repo.Model.find((filter as Record<string, unknown>) ?? {}).select({ _id: 1 }).lean();
        if (context.session !== undefined) query.session(context.session as never);
        return ((await query.exec()) as { _id: unknown }[]).map((d) => d._id);
      };

      repo.on('after:create', async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        if (!isSkipped(context) && result) await upsert(result, context);
      });
      repo.on('after:createMany', async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        if (isSkipped(context) || !Array.isArray(result)) return;
        for (const doc of result) await upsert(doc, context);
      });
      repo.on('after:update', async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        if (!isSkipped(context) && result) await upsert(result, context); // null = not found
      });

      for (const op of ['claim', 'claimVersion', 'findOneAndUpdate', 'getOrCreate', 'restore'] as const) {
        repo.on(`after:${op}`, async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context)) return;
          const id = toRecord(result)?._id;
          if (id === undefined) return; // no match, a lost CAS, or nothing returned: nothing changed here
          const doc = await reread(id, context);
          if (doc) await upsert(doc, context);
          else await tombstone(id, context);
        });
      }

      for (const op of ['updateMany', 'deleteMany'] as const) {
        repo.on(`before:${op}`, async (context: Ctx) => {
          if (!isSkipped(context)) context[MATCHED_IDS] = await matchingIds(context, context.query);
        });
      }
      /** Each re-read document as an upsert, or a tombstone where it is gone. */
      const capture = async (ids: readonly unknown[], context: RepositoryContext) => {
        for (const id of ids) {
          const doc = await reread(id, context);
          if (doc) await upsert(doc, context);
          else await tombstone(id, context);
        }
      };
      repo.on('after:updateMany', async ({ context }: { context: Ctx }) => {
        if (!isSkipped(context)) await capture(context[MATCHED_IDS] ?? [], context);
      });
      repo.on('after:anonymize', async ({ context, result }: { context: RepositoryContext; result: { ids: unknown[] } }) => {
        if (!isSkipped(context)) await capture(result.ids, context);
      });
      // A soft delete leaves the document in place: it travels as an upsert carrying its flag.
      repo.on('after:deleteMany', async ({ context }: { context: Ctx }) => {
        if (!isSkipped(context)) await capture(context[MATCHED_IDS] ?? [], context);
      });

      repo.on('after:delete', async ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        if (isSkipped(context) || !result) return; // null = not found
        // Delete returns a summary ({ message, id }), not the doc — the tombstone is built from the id.
        const summary = result as { id?: unknown };
        await tombstone(summary.id ?? (context as RepositoryContext & { id?: unknown }).id, context);
      });

      // Every target of every operation, before the write: inserts by their _id, the rest by filter.
      repo.on('before:bulkWrite', async (context: Ctx) => {
        if (isSkipped(context)) return;
        const ids: unknown[] = [];
        for (const op of (context.operations as Record<string, Record<string, unknown>>[] | undefined) ?? []) {
          const [kind, spec] = Object.entries(op)[0] ?? [];
          if (!kind || !spec) continue;
          if (kind === 'insertOne') ids.push((spec.document as { _id?: unknown } | undefined)?._id);
          else ids.push(...(await matchingIds(context, spec.filter as Record<string, unknown>)));
        }
        context[MATCHED_IDS] = ids.filter((id) => id !== undefined);
      });
      repo.on('after:bulkWrite', async ({ context, result }: { context: Ctx; result: { upsertedIds?: Record<string, unknown> } }) => {
        if (isSkipped(context)) return;
        await capture([...(context[MATCHED_IDS] ?? []), ...Object.values(result?.upsertedIds ?? {})], context);
      });
    },
  };
}
