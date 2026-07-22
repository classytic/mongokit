/**
 * Sort + select parsing — `?sort=-createdAt,name` and `?select=name,-password`.
 */

import type { ParserRuntime } from './runtime.js';
import type { SortSpec } from './types.js';

/** Parse a sort spec (string or object form), honoring `allowedSortFields`. */
export function parseSort(
  rt: ParserRuntime,
  sort: string | SortSpec | undefined,
): SortSpec | undefined {
  if (!sort) return undefined;
  if (typeof sort === 'object') {
    const sortObj: SortSpec = {};
    for (const [key, value] of Object.entries(sort)) {
      if (rt.options.allowedSortFields && !rt.options.allowedSortFields.includes(key)) {
        rt.reject(`Blocked sort field not in allowlist: ${key}`, { field: key });
        continue;
      }

      // Normalize "asc", "desc", "1", "-1" to 1 or -1
      const strVal = String(value).toLowerCase();
      sortObj[key] = strVal === 'desc' || strVal === '-1' || value === -1 ? -1 : 1;
    }
    return Object.keys(sortObj).length > 0 ? sortObj : undefined;
  }

  const sortObj: SortSpec = {};
  const fields = sort.split(',').map((s) => s.trim());

  for (const field of fields) {
    if (!field) continue;
    const cleanField = field.startsWith('-') ? field.substring(1) : field;

    if (rt.options.allowedSortFields && !rt.options.allowedSortFields.includes(cleanField)) {
      rt.reject(`Blocked sort field not in allowlist: ${cleanField}`, { field: cleanField });
      continue;
    }

    if (field.startsWith('-')) {
      sortObj[field.substring(1)] = -1;
    } else {
      sortObj[field] = 1;
    }
  }

  return Object.keys(sortObj).length > 0 ? sortObj : undefined;
}

/**
 * Parse select/project fields.
 *
 * @example
 * ```typescript
 * // URL: ?select=name,email,-password
 * // Returns: { name: 1, email: 1, password: 0 }
 * ```
 */
export function parseSelect(select: unknown): Record<string, 0 | 1> | undefined {
  if (!select) return undefined;

  if (typeof select === 'string') {
    const projection: Record<string, 0 | 1> = {};
    const fields = select.split(',').map((f) => f.trim());

    for (const field of fields) {
      if (field.startsWith('-')) {
        projection[field.substring(1)] = 0;
      } else {
        projection[field] = 1;
      }
    }

    return projection;
  }

  if (typeof select === 'object' && select !== null) {
    return select as Record<string, 0 | 1>;
  }

  return undefined;
}
