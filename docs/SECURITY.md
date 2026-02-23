# Security Guide

MongoKit applies defense-in-depth sanitization to all user-controlled query inputs. This document describes each protection layer and how to configure them.

## Dangerous Operator Blocking

The following MongoDB operators are blocked by default in filters, aggregation `$match` stages, and lookup pipelines:

| Operator | Risk | Blocked In |
|---|---|---|
| `$where` | Arbitrary JavaScript execution | Filters, aggregation, lookups |
| `$function` | Arbitrary JavaScript execution | Filters, aggregation, lookups |
| `$accumulator` | Arbitrary JavaScript execution | Filters, aggregation, lookups |
| `$expr` | Expression injection | Filters, aggregation, lookups |

### Adding Custom Blocked Operators

```typescript
const parser = new QueryParser({
  additionalDangerousOperators: ['$myCustomOp'],
});
```

## Lookup Pipeline Sanitization

When lookup pipelines are parsed from user input (via `QueryParser` or `LookupBuilder`), the following protections apply:

### Blocked Pipeline Stages

These stages are **never allowed** inside `$lookup` pipelines from user input:

- `$out` — writes results to a collection
- `$merge` — merges results into a collection
- `$unionWith` — accesses arbitrary collections
- `$collStats` — exposes collection metadata
- `$currentOp` — exposes server operations
- `$listSessions` — exposes session information

### Expression Sanitization

Inside `$match`, `$addFields`, and `$set` stages within lookup pipelines, all dangerous operators (`$where`, `$function`, `$accumulator`, `$expr`) are recursively blocked.

### Collection Whitelist

Restrict which collections can be used in lookups:

```typescript
const parser = new QueryParser({
  allowedLookupCollections: ['departments', 'categories', 'users'],
});
```

When set, any lookup targeting a collection not in the list is silently rejected.

### Opting Out (Trusted Pipelines)

For server-side pipelines constructed entirely from trusted code (not user input), you can bypass sanitization:

```typescript
const builder = new LookupBuilder('products')
  .pipeline([{ $match: { status: 'active' } }])
  .build(); // sanitized by default

// Or opt out for trusted pipelines:
const lookup = new LookupBuilder('products');
lookup.options.sanitize = false;
```

## ReDoS Protection

All regex patterns from user input are validated against catastrophic backtracking patterns:

- Quantifier patterns (`{n,m}`) are detected and escaped
- Possessive quantifiers (`*+`, `++`, `?+`) are detected and escaped
- Nested quantifiers (`(a+)+`) are detected and escaped
- Backreferences (`\1`, `\2`) are detected and escaped
- Maximum regex length enforced (default: 500 characters)

Configure limits:

```typescript
const parser = new QueryParser({
  maxRegexLength: 200,
});
```

## Filter Security

### Depth Limiting

Nested filter objects are limited to a configurable depth (default: 10) to prevent filter bombs:

```typescript
const parser = new QueryParser({
  maxFilterDepth: 5,
});
```

### Limit Enforcement

Query result limits are capped to prevent resource exhaustion:

```typescript
const parser = new QueryParser({
  maxLimit: 500, // default: 1000
});
```

### Search Length Limiting

Text search queries are truncated to prevent oversized search operations:

```typescript
const parser = new QueryParser({
  maxSearchLength: 100, // default: 200
});
```

## Aggregation Security

Aggregation parsing is disabled by default and must be explicitly opted in:

```typescript
const parser = new QueryParser({
  enableAggregations: true,
});
```

When enabled, only whitelisted stages are accepted from user input: `$group`, `$match`, `$sort`, `$project`. The `$match` stage is recursively sanitized to block dangerous operators.

## Transaction Security

MongoKit v4 uses the MongoDB driver's `session.withTransaction()` which provides:

- Automatic retry on `TransientTransactionError`
- Automatic retry on `UnknownTransactionCommitResult`
- Proper session cleanup on all code paths

For environments without replica set support (e.g., development standalone MongoDB), use the fallback option:

```typescript
await repo.withTransaction(callback, {
  allowFallback: true,
  onFallback: (err) => console.warn('Running without transaction:', err.message),
});
```

## Reporting Security Issues

If you discover a security vulnerability in MongoKit, please report it responsibly by opening a private security advisory on the GitHub repository.
