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
 * Run `run`, explain every read it issued and throw on a forbidden stage, a wrong leading index,
 * an undersized fixture, or no plannable command at all. Returns what each command used.
 */
export async function assertQueryPlan<T>(
  run: () => Promise<T>,
  options: QueryPlanOptions,
): Promise<{ result: T; plans: PlannedCommand[] }> {
  const forbid = options.forbid ?? ['COLLSCAN', 'SORT'];
  const { result, commands } = await recordCommands(options.connection, run);
  const db = options.connection.db;
  if (!db) throw new Error('[mongokit/testkit] connection has no db handle');
  const plannable = commands.filter(
    (c) =>
      PLANNABLE.has(c.name) &&
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
  for (const c of plannable) {
    const collection = c.collection as string;
    const size = await db.collection(collection).countDocuments({});
    if (size < options.minDocs) {
      throw new Error(
        `[mongokit/testkit] '${collection}' holds ${size} documents, below minDocs ${options.minDocs}: the plan would not be representative`,
      );
    }
    const explained = await db.command({
      explain: explainable(c.command),
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
