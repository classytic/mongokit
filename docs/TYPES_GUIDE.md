# MongoKit Type Organization

This document describes the type organization in MongoKit to maintain consistency and prevent type drift.

## Type Architecture

### Single Source of Truth: `src/types.ts`

All **public** types are defined and exported from `src/types.ts`. This is the canonical source for:
- Core types (ObjectId, AnyDocument, Sort/Select/Populate specs)
- Pagination types (configs, options, results)
- Repository operation types
- Plugin types
- Event/Hook types
- Context types
- Cursor types
- Error types
- Utility types (field selection, JSON schema)

### Type Organization in types.ts

The file is organized into logical sections:

```typescript
// Core Types (lines 19-44)
- ObjectId, AnyDocument, AnyModel
- SortDirection, SortSpec
- PopulateSpec, SelectSpec
- FilterQuery<T>

// Pagination Types (lines 46-172)
- PaginationConfig
- BasePaginationOptions
- OffsetPaginationOptions, KeysetPaginationOptions, AggregatePaginationOptions
- OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult
- PaginationResult union

// Repository Types (lines 174-252)
- OperationOptions
- CreateOptions, UpdateOptions, DeleteOptions
- CreateResult, UpdateWithValidationResult, DeleteResult, etc.

// Plugin Types (lines 254-280)
- Plugin interface
- PluginFunction type
- PluginType union

// Event Types (lines 282-308)
- RepositoryEvent
- EventMap, EventPayload

// Context Types (lines 310-340)
- RepositoryContext
- OperationContext, QueryContext

// Cursor Types (lines 454-485)
- ValueType (NEW - prevents duplication)
- CursorPayload
- DecodedCursor

// Error Types (lines 487-495)
- HttpError interface

// Utility Types (lines 497-574)
- FieldPreset, JsonSchema, etc.
```

## Rules for Type Definitions

### 1. Export Public Types from types.ts Only

✅ **CORRECT**:
```typescript
// src/types.ts
export interface MyPublicType {
  field: string;
}

// src/some-module.ts
import type { MyPublicType } from './types.js';
```

❌ **INCORRECT**:
```typescript
// src/some-module.ts
export interface MyPublicType {  // Don't export from modules
  field: string;
}
```

### 2. Keep Module-Specific Types Internal

✅ **CORRECT**:
```typescript
// src/actions/update.ts
interface ValidationOptions {  // Internal, not exported
  buildConstraints?: ...
  validateUpdate?: ...
}
```

### 3. Never Duplicate Type Definitions

❌ **INCORRECT**:
```typescript
// src/types.ts
export interface CursorPayload { ... }

// src/pagination/utils/cursor.ts
interface CursorPayload { ... }  // DUPLICATION - will cause drift!
```

✅ **CORRECT**:
```typescript
// src/types.ts
export interface CursorPayload { ... }

// src/pagination/utils/cursor.ts
import type { CursorPayload } from '../../types.js';
```

### 4. Plugin Extension Interfaces

Plugin-specific repository extensions are the **only exception** - they can be defined in plugin files:

```typescript
// src/plugins/method-registry.plugin.ts
export interface MethodRegistryRepository extends RepositoryInstance {
  registerMethod<T>(name: string, handler: Function): void;
}
```

## Type Safety Best Practices

### Use Strict Typing Where Possible

Prefer specific types over `Record<string, unknown>`:

```typescript
// Less safe
function query(filters: Record<string, unknown>) { ... }

// More safe (when possible)
function query(filters: FilterQuery<MyDocument>) { ... }
```

### Export Helper Types

When multiple modules need the same type narrowing, export it:

```typescript
// types.ts
export type ValueType = 'date' | 'objectid' | 'boolean' | 'number' | 'string' | 'unknown';

// Used in cursor.ts, validators.ts, etc.
import type { ValueType } from '../types.js';
```

## Migration Checklist

When adding new types:

- [ ] Is this type used in multiple files? → Add to `types.ts`
- [ ] Is this type part of the public API? → Export from `types.ts`
- [ ] Is this type module-specific? → Keep internal (no export)
- [ ] Does a similar type already exist? → Reuse existing type
- [ ] Add JSDoc comments for clarity
- [ ] Add to appropriate section in `types.ts`

## Future Refactoring (Optional)

When `types.ts` exceeds 800 lines, consider splitting into domain files:

```
src/types/
  ├── index.ts          # Barrel export
  ├── core.ts           # ObjectId, AnyDocument, Sort/Select/Populate
  ├── pagination.ts     # All pagination types
  ├── repository.ts     # Operation results, options
  ├── plugins.ts        # Plugin interfaces
  ├── events.ts         # Event types
  ├── context.ts        # Context types
  ├── cursor.ts         # Cursor types
  └── utils.ts          # Utility types
```

Then re-export everything from `src/types/index.ts` to maintain backward compatibility.

## Verification

To check for type duplications:

```bash
# Find duplicate interface/type names
grep -r "^export interface\|^interface\|^export type\|^type " src/ | \
  grep -v ".d.ts" | \
  awk '{print $2}' | \
  sort | uniq -d
```

## Recent Fixes

### Fixed: CursorPayload Duplication (2024)

**Problem**: `CursorPayload` was defined in both `src/types.ts` and `src/pagination/utils/cursor.ts`, causing potential drift.

**Solution**:
1. Added `ValueType` export to `src/types.ts`
2. Updated `CursorPayload` to use `ValueType` instead of string literal unions
3. Removed duplicate definition from `cursor.ts`
4. Import both `CursorPayload` and `ValueType` from `types.ts`

**Files Changed**:
- `src/types.ts`: Added `ValueType` export, updated `CursorPayload`
- `src/pagination/utils/cursor.ts`: Removed duplicates, added imports
