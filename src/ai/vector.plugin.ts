/**
 * Vector Search Plugin
 *
 * Adds semantic similarity search to any repository using MongoDB Atlas Vector Search.
 * Supports auto-embedding on write, text-to-vector search, and scored results.
 *
 * **Requires MongoDB Atlas** — `$vectorSearch` is an Atlas-only aggregation stage.
 * Running on standalone or self-hosted MongoDB will throw an
 * `Unrecognized pipeline stage name: '$vectorSearch'` error.
 *
 * @example
 * ```typescript
 * import { vectorPlugin } from '@classytic/mongokit/ai';
 *
 * // Text-only (OpenAI)
 * const repo = new Repository(Product, [
 *   methodRegistryPlugin(),
 *   vectorPlugin({
 *     fields: [{ path: 'embedding', index: 'vec_idx', dimensions: 1536, similarity: 'cosine', sourceFields: ['title', 'description'] }],
 *     embedFn: async ({ text }) => openai.embeddings.create({ input: text!, model: 'text-embedding-3-small' }).then(r => r.data[0].embedding),
 *     autoEmbed: true,
 *   }),
 * ]);
 *
 * // Multimodal (Jina CLIP v3 — text + images in one call)
 * const repo = new Repository(Product, [
 *   methodRegistryPlugin(),
 *   vectorPlugin({
 *     fields: [{ path: 'embedding', index: 'vec_idx', dimensions: 1024, similarity: 'cosine', sourceFields: ['title'], mediaFields: ['imageUrl'] }],
 *     embedFn: async ({ text, image }) => jina.embed({ input: [{ text, image }] }).then(r => r.data[0].embedding),
 *     autoEmbed: true,
 *   }),
 * ]);
 *
 * // Search by text
 * const results = await repo.searchSimilar({ query: 'running shoes', limit: 10 });
 *
 * // Search by image + text (multimodal)
 * const results = await repo.searchSimilar({ query: { text: 'red sneakers', image: 'https://...' }, limit: 10 });
 *
 * // Search by vector directly
 * const results = await repo.searchSimilar({ query: [0.1, 0.2, ...], limit: 5 });
 * ```
 */

import type { PipelineStage } from 'mongoose';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';
import type {
  EmbeddingInput,
  ScoredResult,
  VectorFieldConfig,
  VectorPluginOptions,
  VectorSearchParams,
} from './types.js';

/** Maximum numCandidates allowed by Atlas Vector Search */
const MAX_NUM_CANDIDATES = 10_000;

export interface VectorMethods {
  searchSimilar<T = Record<string, unknown>>(
    params: VectorSearchParams,
  ): Promise<ScoredResult<T>[]>;
  embed(input: EmbeddingInput | string): Promise<number[]>;
}

/**
 * Resolves which vector field config to use
 */
function resolveField(fields: VectorFieldConfig[], fieldPath?: string): VectorFieldConfig {
  if (fieldPath) {
    const found = fields.find((f) => f.path === fieldPath);
    if (!found) throw new Error(`[mongokit] Vector field '${fieldPath}' not configured`);
    return found;
  }
  return fields[0];
}

/**
 * Normalizes query input to EmbeddingInput
 */
function toEmbeddingInput(query: string | EmbeddingInput): EmbeddingInput {
  return typeof query === 'string' ? { text: query } : query;
}

/**
 * Resolves a potentially dot-notated path from an object (e.g. 'metadata.title')
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path]; // fast path for flat fields
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur != null && typeof cur === 'object') return (cur as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * Builds EmbeddingInput from document source fields
 */
function buildInputFromDoc(
  data: Record<string, unknown>,
  field: VectorFieldConfig,
): EmbeddingInput {
  const input: EmbeddingInput = {};

  if (field.sourceFields?.length) {
    const text = field.sourceFields
      .map((f) => getNestedValue(data, f))
      .filter(Boolean)
      .join(' ');
    if (text.trim()) input.text = text;
  }

  if (field.mediaFields?.length) {
    const firstImageField = field.mediaFields[0];
    const imageValue = getNestedValue(data, firstImageField);
    if (typeof imageValue === 'string') input.image = imageValue;

    // Additional media fields go into the media bag
    if (field.mediaFields.length > 1) {
      input.media = {};
      for (const mf of field.mediaFields) {
        const val = getNestedValue(data, mf);
        if (val != null) input.media[mf] = val;
      }
    }
  }

  return input;
}

/**
 * Checks if an EmbeddingInput has any content worth embedding
 */
function hasContent(input: EmbeddingInput): boolean {
  return !!(
    input.text?.trim() ||
    input.image ||
    input.audio ||
    (input.media && Object.keys(input.media).length)
  );
}

/**
 * Builds the $vectorSearch pipeline stage
 */
function buildVectorSearchPipeline(
  field: VectorFieldConfig,
  queryVector: number[],
  params: VectorSearchParams,
): PipelineStage[] {
  const limit = params.limit ?? 10;
  const stages: PipelineStage[] = [];

  // Clamp numCandidates: minimum = limit, maximum = 10,000 (Atlas limit)
  const rawCandidates = params.numCandidates ?? Math.max(limit * 10, 100);
  const numCandidates = Math.min(Math.max(rawCandidates, limit), MAX_NUM_CANDIDATES);

  // $vectorSearch must be first stage
  stages.push({
    $vectorSearch: {
      index: field.index,
      path: field.path,
      queryVector,
      numCandidates,
      limit,
      ...(params.filter && { filter: params.filter }),
      ...(params.exact && { exact: true }),
    },
  } as unknown as PipelineStage);

  // Add score — auto-enable when minScore is set (otherwise minScore would match nothing)
  const needsScore = params.includeScore !== false || params.minScore != null;
  if (needsScore) {
    stages.push({
      $addFields: { _score: { $meta: 'vectorSearchScore' } },
    } as unknown as PipelineStage);
  }

  // Filter by minimum score
  if (params.minScore != null) {
    stages.push({ $match: { _score: { $gte: params.minScore } } });
  }

  // Project fields
  if (params.project) {
    stages.push({ $project: { ...params.project, _score: 1 } });
  }

  // Additional pipeline stages
  if (params.postPipeline?.length) {
    stages.push(...params.postPipeline);
  }

  return stages;
}

/**
 * Creates the vector search plugin
 */
export function vectorPlugin(options: VectorPluginOptions): Plugin {
  const { fields, autoEmbed = false } = options;

  if (!fields?.length) {
    throw new Error('[mongokit] vectorPlugin requires at least one field config');
  }

  const { embedFn, batchEmbedFn } = options;

  return {
    name: 'vector',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error('[mongokit] vectorPlugin requires methodRegistryPlugin');
      }

      // ── searchSimilar ────────────────────────────────────────────
      repo.registerMethod('searchSimilar', async function searchSimilar<
        T = Record<string, unknown>,
      >(params: VectorSearchParams): Promise<ScoredResult<T>[]> {
        const field = resolveField(fields, params.field);

        // Resolve query to vector
        let queryVector: number[];
        if (Array.isArray(params.query)) {
          queryVector = params.query;
        } else {
          if (!embedFn) {
            throw new Error(
              '[mongokit] Non-vector queries require embedFn in vectorPlugin options',
            );
          }
          const input = toEmbeddingInput(params.query);
          queryVector = await embedFn(input);
        }

        // Validate dimensions
        if (queryVector.length !== field.dimensions) {
          throw new Error(
            `[mongokit] Query vector has ${queryVector.length} dimensions, expected ${field.dimensions}`,
          );
        }

        const pipeline = buildVectorSearchPipeline(field, queryVector, params);
        const agg = repo.Model.aggregate<T & { _score: number }>(pipeline);
        if (params.session) agg.session(params.session);

        const results = await agg.exec();

        return results.map((doc) => {
          const score = (doc as any)._score ?? 0;
          const { _score, ...rest } = doc as any;
          return { doc: rest as T, score };
        });
      });

      // ── embed — unified single-item embedding ────────────────────
      repo.registerMethod('embed', async function embed(input: EmbeddingInput | string): Promise<
        number[]
      > {
        if (!embedFn) {
          throw new Error('[mongokit] embed requires embedFn in vectorPlugin options');
        }
        return embedFn(typeof input === 'string' ? { text: input } : input);
      });

      // ── Auto-embed on create/update ──────────────────────────────
      if (autoEmbed && embedFn) {
        const { onEmbedError } = options;

        const safeEmbed = async (
          input: EmbeddingInput,
          doc: Record<string, unknown>,
        ): Promise<number[] | null> => {
          try {
            return await embedFn(input);
          } catch (err) {
            if (onEmbedError) {
              onEmbedError(err as Error, doc);
              return null;
            }
            throw err;
          }
        };

        const embedFromSource = async (
          data: Record<string, unknown>,
          field: VectorFieldConfig,
        ): Promise<void> => {
          // Skip if vector already provided
          if (data[field.path] && Array.isArray(data[field.path])) return;

          const input = buildInputFromDoc(data, field);
          if (!hasContent(input)) return;
          const vector = await safeEmbed(input, data);
          if (vector) data[field.path] = vector;
        };

        const embedBatchFromSource = async (
          dataArray: Record<string, unknown>[],
          field: VectorFieldConfig,
        ): Promise<void> => {
          const toEmbed: { idx: number; input: EmbeddingInput }[] = [];

          for (let i = 0; i < dataArray.length; i++) {
            const data = dataArray[i];
            if (data[field.path] && Array.isArray(data[field.path])) continue;

            const input = buildInputFromDoc(data, field);
            if (hasContent(input)) toEmbed.push({ idx: i, input });
          }

          if (!toEmbed.length) return;

          // Use batch fn if available, otherwise sequential
          if (batchEmbedFn) {
            try {
              const vectors = await batchEmbedFn(toEmbed.map((e) => e.input));
              for (let i = 0; i < toEmbed.length; i++) {
                dataArray[toEmbed[i].idx][field.path] = vectors[i];
              }
            } catch (err) {
              if (onEmbedError) {
                onEmbedError(err as Error, dataArray);
                return;
              }
              throw err;
            }
          } else {
            for (const entry of toEmbed) {
              const vector = await safeEmbed(entry.input, dataArray[entry.idx]);
              if (vector) dataArray[entry.idx][field.path] = vector;
            }
          }
        };

        // Hook into create — before:* hooks receive context directly
        repo.on('before:create', async (context: RepositoryContext) => {
          if (!context.data) return;
          for (const field of fields) {
            await embedFromSource(context.data, field);
          }
        });

        // Hook into createMany
        repo.on('before:createMany', async (context: RepositoryContext) => {
          if (!context.dataArray?.length) return;
          for (const field of fields) {
            await embedBatchFromSource(context.dataArray, field);
          }
        });

        // Hook into update — fetch full doc so embedding uses all source fields
        repo.on('before:update', async (context: RepositoryContext) => {
          if (!context.data) return;

          // Determine which fields need re-embedding
          const contextData = context.data;
          const fieldsToEmbed = fields.filter((field) => {
            const allFields = [...(field.sourceFields ?? []), ...(field.mediaFields ?? [])];
            return allFields.length > 0 && contextData && allFields.some((f) => f in contextData);
          });
          if (!fieldsToEmbed.length) return;

          // Single DB fetch for all fields (avoids N+1)
          const existing = await repo.Model.findById(context.id)
            .lean()
            .session(context.session ?? null);
          if (!existing) return;

          for (const field of fieldsToEmbed) {
            // Merge: existing doc + update data (update wins)
            const merged = { ...(existing as Record<string, unknown>), ...context.data };
            delete merged[field.path]; // force re-embed
            const input = buildInputFromDoc(merged, field);
            if (!hasContent(input)) continue;
            const vector = await safeEmbed(input, merged);
            if (vector) context.data[field.path] = vector;
          }
        });
      }
    },
  };
}

export { buildVectorSearchPipeline };
