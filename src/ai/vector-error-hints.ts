/**
 * Vector search error translation.
 *
 * `$vectorSearch` is Atlas-only. When it fails, the raw driver message is
 * accurate but not actionable for a first-time user ("Unrecognized pipeline
 * stage" doesn't say anything about Atlas). This module detects a handful
 * of common failure modes and rewraps the error with a short, pointed hint.
 *
 * The original error is preserved under `.cause` so tooling that walks the
 * chain (observability, sentry, etc.) still has the raw Mongo detail.
 */

export interface VectorErrorHint {
  /** Classification — useful for metrics/logging, not for control flow. */
  code:
    | 'NOT_ATLAS'
    | 'INDEX_NOT_FOUND'
    | 'FILTER_FIELD_NOT_INDEXED'
    | 'DIMENSION_MISMATCH'
    | 'MALFORMED_PIPELINE'
    | 'UNKNOWN';
  /** Human-readable summary — a sentence. */
  summary: string;
  /** One-to-three actionable bullets. */
  hints: string[];
}

/**
 * Pure classifier. Takes the raw error and the context the plugin knows
 * (index name, dimensions, filter paths it tried to use) and returns a hint.
 *
 * Returns `{ code: 'UNKNOWN', ... }` when no pattern matches — callers
 * should then fall back to rethrowing the original.
 */
export function classifyVectorSearchError(
  err: unknown,
  ctx: {
    indexName: string;
    dimensions: number;
    filterPaths?: string[];
  },
): VectorErrorHint {
  const msg = extractErrorMessage(err);
  const lower = msg.toLowerCase();

  // ─── Not Atlas (or Atlas tier without Search) ─────────────────────────
  if (
    lower.includes("unrecognized pipeline stage name: '$vectorsearch'") ||
    lower.includes('unrecognized pipeline stage name: "$vectorsearch"') ||
    lower.includes('$vectorsearch is only supported') ||
    lower.includes('$vectorsearch stage is only allowed') ||
    lower.includes('$vectorsearch is only allowed') ||
    lower.includes('unknown top level operator: $vectorsearch') ||
    (lower.includes('$vectorsearch') &&
      lower.includes('atlas') &&
      (lower.includes('only') || lower.includes('require')))
  ) {
    return {
      code: 'NOT_ATLAS',
      summary:
        "MongoDB did not recognize the `$vectorSearch` stage. This stage is Atlas-only — it doesn't exist on standalone MongoDB, self-hosted Community/Enterprise, or mongodb-memory-server.",
      hints: [
        'Run against MongoDB Atlas — create a cluster and point your app at its connection string.',
        "If you're testing locally, use the integration suite that mocks `$vectorSearch` (see tests/integration/vector-*.test.ts) rather than calling `searchSimilar` directly.",
        'Atlas Free tier (M0) supports Vector Search as of late 2024; older free tiers do not.',
      ],
    };
  }

  // ─── Index not found (Atlas reports this a few different ways) ────────
  if (
    (lower.includes('$vectorsearch') && lower.includes('index')) ||
    lower.includes("couldn't find index") ||
    (lower.includes('search index') && lower.includes('not found')) ||
    lower.includes('no such index') ||
    (lower.includes('index') && lower.includes(ctx.indexName.toLowerCase()))
  ) {
    return {
      code: 'INDEX_NOT_FOUND',
      summary: `Atlas reported the vector search index "${ctx.indexName}" is not available on the target collection.`,
      hints: [
        `Verify an index named "${ctx.indexName}" exists on the collection in the Atlas UI (Search → Indexes) or via \`db.collection.listSearchIndexes()\`.`,
        `If you just created the index, wait until it reports \`queryable: true\`. Builds typically take 1–3 minutes on new clusters.`,
        `The index's \`numDimensions\` must match your vector config (${ctx.dimensions}), and \`path\` must match the field name.`,
      ],
    };
  }

  // ─── Filter path not declared in index ────────────────────────────────
  if (
    lower.includes('not a supported filter field') ||
    lower.includes('is not a filter field') ||
    (lower.includes('filter') && lower.includes('path') && lower.includes('not')) ||
    lower.includes('unknown filter path')
  ) {
    const paths = ctx.filterPaths?.length ? ctx.filterPaths.join(', ') : '(none declared)';
    return {
      code: 'FILTER_FIELD_NOT_INDEXED',
      summary:
        'Atlas rejected the `filter` clause because at least one of its paths is not declared as a `filter`-typed field in the vector search index.',
      hints: [
        `Add every path you filter on as \`{ type: "filter", path: "<field>" }\` in the index definition.`,
        `Paths passed in this call: ${paths}.`,
        `Example for multi-tenant: index must include \`{ type: "filter", path: "tenantId" }\` when you call \`searchSimilar({ filter: { tenantId: "..." } })\`.`,
      ],
    };
  }

  // ─── Dimension mismatch reported by Atlas (we also pre-check in the plugin) ──
  if (lower.includes('dimension') && (lower.includes('mismatch') || lower.includes('expected'))) {
    return {
      code: 'DIMENSION_MISMATCH',
      summary: 'Atlas rejected the query vector — its length does not match the index definition.',
      hints: [
        `Your vectorPlugin config says \`dimensions: ${ctx.dimensions}\`. The Atlas index for "${ctx.indexName}" must declare the same \`numDimensions\`.`,
        `If the index was created with a different dimension count, re-create it with the correct value (indexes are immutable for dimensions).`,
      ],
    };
  }

  // ─── Malformed pipeline (usually a plugin bug, not user error) ────────
  if (
    lower.includes('vectorsearch') &&
    (lower.includes('requires') || lower.includes('expected') || lower.includes('missing'))
  ) {
    return {
      code: 'MALFORMED_PIPELINE',
      summary:
        'The `$vectorSearch` stage is missing a required argument. This is almost always a mongokit bug — please file an issue with the full error text.',
      hints: ['Capture the original error (`err.cause`) and attach it to the bug report.'],
    };
  }

  return {
    code: 'UNKNOWN',
    summary: '',
    hints: [],
  };
}

/**
 * Wrap an error-producing promise so known-recognizable failures become
 * mongokit errors with hint context. On unrecognized errors, rethrows the
 * original untouched.
 */
export async function withVectorErrorHints<T>(
  op: () => Promise<T>,
  ctx: {
    indexName: string;
    dimensions: number;
    filterPaths?: string[];
  },
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const hint = classifyVectorSearchError(err, ctx);
    if (hint.code === 'UNKNOWN') throw err;

    const message =
      `[mongokit:vector] ${hint.summary}\n` + hint.hints.map((h) => `  • ${h}`).join('\n');

    const wrapped = new Error(message, { cause: err });
    (wrapped as Error & { code?: string }).code = hint.code;
    throw wrapped;
  }
}

// ── internal ─────────────────────────────────────────────────────────────

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; errmsg?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.errmsg === 'string') return e.errmsg;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
