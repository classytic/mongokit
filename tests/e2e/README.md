# E2E tests — real Atlas Vector Search

These tests connect to a real MongoDB Atlas cluster to validate the parts of
mongokit that can't run against `mongodb-memory-server`:

- `$vectorSearch` pipeline execution
- Atlas vector-index propagation timing
- Real `$lookup` + `$vectorSearch` composition

**The rest of mongokit is fully covered by `tests/integration/**` on the
shared memory-server** — that suite runs on every commit. The e2e tier is a
smaller plumbing check you run on-demand, not a replacement.

## Safety — read this first

`tests/helpers/e2e-safety.ts` refuses to connect unless the URI passes a hard
check:

- `MONGOKIT_E2E_URI` is set.
- The URI does NOT contain any of: `prod`, `production`, `live`, `bigboss`.
- The database name ends with `-test`, `-e2e`, `-ci`, or `-sandbox`.

These rules are intentional. **Never point the e2e suite at a production
cluster**, even if you think "I'll just read." The tests create collections,
write documents, and drop their own collections on teardown.

If your test cluster's URI doesn't pass the check, rename the DB or widen the
allowlist — the check is there to protect you, not to be clever.

## Setup

### 1. Create a dedicated test cluster (or test DB on a sandbox cluster)

In Atlas:

1. Create a new database user `mongokit_e2e_user` with a strong random
   password.
2. Scope its permissions to exactly one database — e.g. `mongokit-e2e` — and
   nothing else.
3. Allow network access from your dev machine / CI runner IP.

### 2. Create the Vector Search indexes

Atlas → your cluster → Search → Create Search Index → JSON Editor.

Create two indexes. Collection names will have a random prefix from
`e2eCollectionPrefix()` — the index must be defined at the database level on
the pattern `e2e_vector_*_docs` / `e2e_rag_*_chunks`, or recreated per run.
For iterative development, the simplest path is to accept a stable
collection name.

If your Atlas tier supports it, create the indexes against concrete
collection names and adjust the e2e tests to use those names (override
`e2eCollectionPrefix` for a single run). Below are the index specs:

#### Index 1 — `mongokit_e2e_idx` (for `vector-atlas.test.ts`)

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 8,
      "similarity": "cosine"
    }
  ]
}
```

#### Index 2 — `mongokit_rag_idx` (for `rag-atlas.test.ts`)

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 8,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "tenantId"
    }
  ]
}
```

The `tenantId` filter field is required for multi-tenant scoping — Atlas
`$vectorSearch` rejects filters on paths not listed as `filter` fields.

### 3. Configure `.env`

Copy `.env.example` → `.env` and set `MONGOKIT_E2E_URI`:

```bash
MONGOKIT_E2E_URI=mongodb+srv://mongokit_e2e_user:<password>@your-cluster.xxxxxxx.mongodb.net/mongokit-e2e
```

### 4. Run

```bash
# Runs unit + integration (default CI path, no Atlas needed).
npm test

# Runs e2e only. Requires MONGOKIT_E2E_URI + indexes.
npm run test:e2e

# Runs everything.
npm run test:all
```

If the gate is disabled (no URI / unsafe URI / missing suffix), e2e tests
skip with a message describing why — not an error.

## What these tests are NOT for

- **Load testing** — use `scripts/` with k6 or an equivalent.
- **Exhaustive vector behavior** — that's in `tests/integration/vector-*`,
  which runs on every commit without Atlas.
- **Performance benchmarking** — Atlas indexing latency is non-deterministic;
  this tier is correctness-only.

## Rotating credentials

If you ever paste `.env` contents into a chat, a ticket, a PR description,
or anywhere non-private: **rotate the database user password in Atlas
immediately**. Credentials are cheap to rotate; a leaked connection string
into a production cluster is not.
