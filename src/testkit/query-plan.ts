/**
 * Query-plan gate for tests: record the commands a call issues, re-run each read with
 * `explain: executionStats`, and fail on a forbidden plan stage or a wrong leading index.
 *
 * The connection must be opened with `monitorCommands: true` (the driver emits no
 * `commandStarted` otherwise); the gate refuses rather than passing on zero commands.
 * `minDocs` makes the plan meaningful: below it the planner may legitimately prefer a scan,
 * so a smaller fixture is refused instead of yielding a vacuous pass.
 */

import type { Connection } from 'mongoose';

export interface RecordedCommand {
  name: string;
  collection: string | undefined;
  command: Record<string, unknown>;
}

const PLANNABLE = new Set(['find', 'aggregate', 'count', 'distinct']);
/**
 * Every command the server can explain. A write command is explained, never run again (an
 * explain does not write), so a captured `findOneAndUpdate` / `updateOne` / `deleteMany` can be
 * planned after the fact.
 */
const EXPLAINABLE = new Set([...PLANNABLE, 'findAndModify', 'update', 'delete']);

function commandSet(names: readonly string[]): Set<string> {
  for (const name of names) {
    if (!EXPLAINABLE.has(name)) {
      throw new Error(
        `[mongokit/testkit] '${name}' cannot be explained (explainable: ${[...EXPLAINABLE].join(', ')})`,
      );
    }
  }
  return new Set(names);
}
/** Session/transport fields the server refuses inside an `explain`. */
const STRIP = new Set([
  'lsid',
  'txnNumber',
  'autocommit',
  'startTransaction',
  'readConcern',
  'maxTimeMS',
]);

function assertMonitored(connection: Connection): void {
  const monitored = (connection.getClient().options as { monitorCommands?: boolean })
    .monitorCommands;
  if (monitored !== true) {
    throw new Error(
      '[mongokit/testkit] the connection was not opened with { monitorCommands: true }: no command can be observed',
    );
  }
}

/** Run `fn` and return every command it started on `connection` (in start order). */
export async function recordCommands<T>(
  connection: Connection,
  fn: () => Promise<T>,
): Promise<{ result: T; commands: RecordedCommand[] }> {
  assertMonitored(connection);
  const client = connection.getClient();
  const commands: RecordedCommand[] = [];
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    const target = event.command[event.commandName];
    commands.push({
      name: event.commandName,
      collection: typeof target === 'string' ? target : undefined,
      command: event.command,
    });
  };
  client.on('commandStarted', listener);
  try {
    const result = await fn();
    return { result, commands };
  } finally {
    client.off('commandStarted', listener);
  }
}

export interface QueryPlanOptions {
  connection: Connection;
  /** Plan stages that fail the gate. Default `['COLLSCAN', 'SORT']` (a scan, an unindexed sort). */
  forbid?: readonly string[];
  /** The examined collection must hold at least this many documents. */
  minDocs: number;
  /** Every index scan must lead with these keys (directly, or after one equality scope field). */
  leadingKeys?: readonly string[];
  /** Only gate commands on these collections (default: every plannable command). */
  collections?: readonly string[];
  /**
   * Command names to gate. Default the reads: `find`, `aggregate`, `count`, `distinct`. Add
   * `findAndModify`, `update` or `delete` to gate a write's match as well (explained, never
   * re-run). Any other name throws.
   */
  commands?: readonly string[];
}

export interface PlannedCommand {
  name: string;
  collection: string;
  stages: string[];
  indexes: string[][];
}

type PlanNode = Record<string, unknown>;

function collectPlanNodes(node: unknown, out: PlanNode[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectPlanNodes(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as PlanNode;
  if (typeof obj.stage === 'string') out.push(obj);
  for (const [key, value] of Object.entries(obj)) {
    // Rejected plans are alternatives the planner did NOT pick.
    if (key === 'rejectedPlans' || key === 'allPlansExecution') continue;
    collectPlanNodes(value, out);
  }
}

function explainable(command: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(command).filter(([k]) => !k.startsWith('$') && !STRIP.has(k)),
  );
}

/**
 * What to send to `explain` for one recorded command. The server explains an `update` / `delete`
 * of ONE statement only, so a bulk command becomes one explain per statement.
 */
function explainTargets(c: RecordedCommand): Record<string, unknown>[] {
  const base = explainable(c.command);
  const list = c.name === 'update' ? 'updates' : c.name === 'delete' ? 'deletes' : undefined;
  if (list === undefined) return [base];
  const statements = Array.isArray(base[list]) ? (base[list] as unknown[]) : [];
  return statements.map((statement) => ({ ...base, [list]: [statement] }));
}

export interface ExplainCommandsOptions {
  connection: Connection;
  /**
   * Command names to explain. Default every explainable one: `find`, `aggregate`, `count`,
   * `distinct`, `findAndModify` (`findOneAndUpdate`, `findOneAndDelete`, ...), `update`,
   * `delete`. Any other name throws.
   */
  commands?: readonly string[];
  /** Only explain commands on these collections (default: every collection). */
  collections?: readonly string[];
  /** Explain verbosity. Default `'executionStats'`. */
  verbosity?: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}

export interface ExplainedCommand extends RecordedCommand {
  collection: string;
  /** The command as handed to `explain`: session fields stripped, one statement for update / delete. */
  explained: Record<string, unknown>;
  /** The server's explain output as returned (`queryPlanner`, `executionStats`, ...). */
  explain: Record<string, unknown>;
}

/**
 * Run `run` and explain the commands it ACTUALLY sent, so a test plans the filter, sort and
 * update a repository method or plugin built (a `leasePlugin` claim, a tenant-scoped read)
 * rather than a copy of it. The explains run after `run` returns and never write. Throws when no
 * command matched, so a renamed collection cannot pass vacuously. The connection must be opened
 * with `{ monitorCommands: true }`.
 *
 * ```ts
 * const { explains } = await explainCommands(() => repo.lease({ leaseFor, leasedBy }), {
 *   connection, commands: ['findAndModify'], collections: ['jobs'],
 * });
 * explains[0].explain.executionStats; // what the claim examined
 * ```
 */
export async function explainCommands<T>(
  run: () => Promise<T>,
  options: ExplainCommandsOptions,
): Promise<{ result: T; explains: ExplainedCommand[] }> {
  const names = commandSet(options.commands ?? [...EXPLAINABLE]);
  const { result, commands } = await recordCommands(options.connection, run);
  const db = options.connection.db;
  if (!db) throw new Error('[mongokit/testkit] connection has no db handle');
  const matched = commands.filter(
    (c) =>
      names.has(c.name) &&
      c.collection !== undefined &&
      (!options.collections || options.collections.includes(c.collection)),
  );
  if (matched.length === 0) {
    throw new Error(
      `[mongokit/testkit] explainCommands saw no matching command (saw: ${commands.map((c) => `${c.name}${c.collection ? `:${c.collection}` : ''}`).join(', ') || 'none'})`,
    );
  }
  const explains: ExplainedCommand[] = [];
  for (const c of matched) {
    for (const target of explainTargets(c)) {
      const explain = (await db.command({
        explain: target,
        verbosity: options.verbosity ?? 'executionStats',
      })) as Record<string, unknown>;
      explains.push({ ...c, collection: c.collection as string, explained: target, explain });
    }
  }
  return { result, explains };
}

/**
 * Run `run`, explain every read it issued and throw on a forbidden stage, a wrong leading index,
 * an undersized fixture, or no plannable command at all. Returns what each command used.
 */
export async function assertQueryPlan<T>(
  run: () => Promise<T>,
  options: QueryPlanOptions,
): Promise<{ result: T; plans: PlannedCommand[] }> {
  const forbid = options.forbid ?? ['COLLSCAN', 'SORT'];
  const gated = commandSet(options.commands ?? [...PLANNABLE]);
  const { result, commands } = await recordCommands(options.connection, run);
  const db = options.connection.db;
  if (!db) throw new Error('[mongokit/testkit] connection has no db handle');
  const plannable = commands.filter(
    (c) =>
      gated.has(c.name) &&
      c.collection !== undefined &&
      (!options.collections || options.collections.includes(c.collection)),
  );
  if (plannable.length === 0) {
    throw new Error(
      `[mongokit/testkit] assertQueryPlan saw no plannable command (saw: ${commands.map((c) => c.name).join(', ') || 'none'})`,
    );
  }
  const plans: PlannedCommand[] = [];
  const failures: string[] = [];
  // A bulk update / delete is explained one statement at a time.
  for (const { c, target } of plannable.flatMap((c) =>
    explainTargets(c).map((target) => ({ c, target })),
  )) {
    const collection = c.collection as string;
    const size = await db.collection(collection).countDocuments({});
    if (size < options.minDocs) {
      throw new Error(
        `[mongokit/testkit] '${collection}' holds ${size} documents, below minDocs ${options.minDocs}: the plan would not be representative`,
      );
    }
    const explained = await db.command({
      explain: target,
      verbosity: 'executionStats',
    });
    const nodes: PlanNode[] = [];
    collectPlanNodes(explained.queryPlanner ?? explained.stages ?? explained, nodes);
    const stages = nodes.map((n) => n.stage as string);
    const indexes = nodes
      .filter((n) => n.keyPattern && typeof n.keyPattern === 'object')
      .map((n) => Object.keys(n.keyPattern as Record<string, unknown>));
    plans.push({ name: c.name, collection, stages, indexes });
    for (const stage of forbid) {
      if (stages.includes(stage))
        failures.push(`${c.name} on '${collection}': plan contains ${stage}`);
    }
    if (options.leadingKeys) {
      const want = options.leadingKeys;
      const leads = (key: string[], at: number) => want.every((k, i) => key[at + i] === k);
      if (indexes.length === 0)
        failures.push(`${c.name} on '${collection}': no index used, expected (${want.join(',')})`);
      for (const key of indexes) {
        if (!leads(key, 0) && !leads(key, 1)) {
          failures.push(
            `${c.name} on '${collection}': index (${key.join(',')}) does not lead with (${want.join(',')})`,
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    const error = new Error(
      `[mongokit/testkit] query plan gate failed:\n  ${failures.join('\n  ')}`,
    );
    Object.assign(error, { code: 'mongokit.testkit.query_plan', plans });
    throw error;
  }
  return { result, plans };
}
