/** repo-core `runReadModelPropertyConformance` against mongokit (fast-check). */

import { runReadModelPropertyConformance } from '@classytic/repo-core/testing';
import { beforeAll } from 'vitest';
import { MONGOKIT_CAPABILITIES } from '../../src/index.js';
import { readModelFixture, setupReadModelModels } from '../helpers/read-model-fixtures.js';
import { connectDB } from '../setup.js';

beforeAll(async () => {
  await connectDB();
  await setupReadModelModels();
});

runReadModelPropertyConformance({
  name: 'mongokit',
  features: MONGOKIT_CAPABILITIES,
  fixture: readModelFixture,
  numRuns: 20,
});
