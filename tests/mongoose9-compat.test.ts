import { describe, it, expect } from 'vitest';
import * as updateActions from '../src/actions/update.js';

describe('Mongoose 9 compatibility guards', () => {
  it('throws on update pipeline arrays unless updatePipeline=true (updateMany)', async () => {
    const Model = {} as any;

    await expect(
      updateActions.updateMany(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any)
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('allows update pipeline arrays when updatePipeline=true (updateMany)', async () => {
    const Model = {
      updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    } as any;

    await expect(
      updateActions.updateMany(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any, { updatePipeline: true })
    ).resolves.toEqual({ matchedCount: 1, modifiedCount: 1 });
  });

  it('throws on update pipeline arrays unless updatePipeline=true (updateByQuery)', async () => {
    const Model = {
      findOneAndUpdate: () => {
        throw new Error('should not be called');
      },
    } as any;

    await expect(
      updateActions.updateByQuery(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any)
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

