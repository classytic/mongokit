/**
 * A pre-8.0 server answers `bulkWrite` with CommandNotFound (59): bulkUpsert maps it to the closed
 * `repo.bulk_upsert.unsupported`; any other error passes through untouched.
 */

import { BULK_UPSERT_ERROR_CODES } from '@classytic/repo-core/repository';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { throwIfUnsupported } from '../../src/actions/bulk-upsert.js';

describe('bulkUpsert on a server without client bulkWrite', () => {
  it('CommandNotFound becomes the closed unsupported code', () => {
    const err = new mongoose.mongo.MongoServerError({ message: 'no such command: bulkWrite', code: 59 });
    expect(() => throwIfUnsupported(err)).toThrow(expect.objectContaining({ code: BULK_UPSERT_ERROR_CODES.UNSUPPORTED }));
  });

  it('other errors are left alone', () => {
    expect(() => throwIfUnsupported(new mongoose.mongo.MongoServerError({ message: 'x', code: 11000 }))).not.toThrow();
    expect(() => throwIfUnsupported(new Error('net'))).not.toThrow();
  });
});
