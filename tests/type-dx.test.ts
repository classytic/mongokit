/**
 * Type DX Tests
 *
 * Validates that type improvements provide correct inference,
 * autocomplete-friendly APIs, and proper type hierarchy.
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { Document, Types } from 'mongoose';
import { Repository, HOOK_PRIORITY } from '../src/Repository.js';
import { QueryParser } from '../src/query/QueryParser.js';
import type {
  SessionOptions,
  ReadOptions,
  CacheableOptions,
  AggregateOptions,
  CreateOptions,
  UpdateOptions,
  OperationOptions,
  LookupPopulateOptions,
  LookupPopulateResult,
  DocField,
  AllPluginMethods,
  WithPlugins,
  RepositoryEvent,
  OffsetPaginationResult,
  KeysetPaginationResult,
  SoftDeleteRepository,
  DeleteResult,
  CollationOptions,
} from '../src/types.js';

// ============================================================================
// Test Document Types
// ============================================================================

interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  age: number;
  status: 'active' | 'inactive';
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Type Hierarchy Tests (compile-time assertions)
// ============================================================================

describe('Type Hierarchy', () => {
  it('SessionOptions is the base with only session', () => {
    expectTypeOf<SessionOptions>().toHaveProperty('session');
    // Should NOT have readPreference, select, etc.
    expectTypeOf<SessionOptions>().not.toHaveProperty('readPreference');
    expectTypeOf<SessionOptions>().not.toHaveProperty('select');
  });

  it('ReadOptions extends SessionOptions with readPreference', () => {
    expectTypeOf<ReadOptions>().toHaveProperty('session');
    expectTypeOf<ReadOptions>().toHaveProperty('readPreference');
    // ReadOptions should be assignable to SessionOptions
    expectTypeOf<ReadOptions>().toMatchTypeOf<SessionOptions>();
  });

  it('OperationOptions extends ReadOptions with select/populate/lean', () => {
    expectTypeOf<OperationOptions>().toHaveProperty('session');
    expectTypeOf<OperationOptions>().toHaveProperty('readPreference');
    expectTypeOf<OperationOptions>().toHaveProperty('select');
    expectTypeOf<OperationOptions>().toHaveProperty('populate');
    expectTypeOf<OperationOptions>().toHaveProperty('populateOptions');
    expectTypeOf<OperationOptions>().toHaveProperty('lean');
    expectTypeOf<OperationOptions>().toHaveProperty('throwOnNotFound');
    // OperationOptions should be assignable to ReadOptions
    expectTypeOf<OperationOptions>().toMatchTypeOf<ReadOptions>();
  });

  it('CacheableOptions extends OperationOptions with cache controls', () => {
    expectTypeOf<CacheableOptions>().toHaveProperty('skipCache');
    expectTypeOf<CacheableOptions>().toHaveProperty('cacheTtl');
    // Should inherit all OperationOptions
    expectTypeOf<CacheableOptions>().toHaveProperty('select');
    expectTypeOf<CacheableOptions>().toHaveProperty('populate');
    expectTypeOf<CacheableOptions>().toHaveProperty('session');
    expectTypeOf<CacheableOptions>().toMatchTypeOf<OperationOptions>();
  });

  it('UpdateOptions extends OperationOptions with update-specific fields', () => {
    expectTypeOf<UpdateOptions>().toHaveProperty('updatePipeline');
    expectTypeOf<UpdateOptions>().toHaveProperty('arrayFilters');
    expectTypeOf<UpdateOptions>().toMatchTypeOf<OperationOptions>();
  });

  it('AggregateOptions extends ReadOptions with aggregate-specific fields', () => {
    expectTypeOf<AggregateOptions>().toHaveProperty('allowDiskUse');
    expectTypeOf<AggregateOptions>().toHaveProperty('comment');
    expectTypeOf<AggregateOptions>().toHaveProperty('maxTimeMS');
    expectTypeOf<AggregateOptions>().toHaveProperty('collation');
    expectTypeOf<AggregateOptions>().toHaveProperty('maxPipelineStages');
    expectTypeOf<AggregateOptions>().toMatchTypeOf<ReadOptions>();
  });

  it('AggregateOptions.collation uses CollationOptions, not Record<string, unknown>', () => {
    expectTypeOf<AggregateOptions['collation']>().toEqualTypeOf<CollationOptions | undefined>();
  });

  it('CreateOptions extends SessionOptions', () => {
    expectTypeOf<CreateOptions>().toHaveProperty('session');
    expectTypeOf<CreateOptions>().toHaveProperty('ordered');
    expectTypeOf<CreateOptions>().toMatchTypeOf<SessionOptions>();
  });

  it('LookupPopulateOptions extends ReadOptions', () => {
    expectTypeOf<LookupPopulateOptions>().toHaveProperty('lookups');
    expectTypeOf<LookupPopulateOptions>().toHaveProperty('filters');
    expectTypeOf<LookupPopulateOptions>().toHaveProperty('sort');
    expectTypeOf<LookupPopulateOptions>().toHaveProperty('collation');
    expectTypeOf<LookupPopulateOptions>().toMatchTypeOf<ReadOptions>();
  });
});

// ============================================================================
// DocField<TDoc> Autocomplete Tests
// ============================================================================

describe('DocField<TDoc> type', () => {
  it('includes known keys from document type', () => {
    type UserField = DocField<IUser>;
    // Known keys should be assignable
    expectTypeOf<'name'>().toMatchTypeOf<UserField>();
    expectTypeOf<'email'>().toMatchTypeOf<UserField>();
    expectTypeOf<'age'>().toMatchTypeOf<UserField>();
    expectTypeOf<'tags'>().toMatchTypeOf<UserField>();
  });

  it('still accepts arbitrary strings for nested paths', () => {
    type UserField = DocField<IUser>;
    // Arbitrary strings should also work (for nested paths like 'address.city')
    const nestedPath: UserField = 'address.city';
    expect(nestedPath).toBe('address.city');
  });

  it('provides autocomplete in AllPluginMethods', () => {
    type Methods = AllPluginMethods<IUser>;
    // increment's field param should accept IUser keys
    type IncrementField = Parameters<Methods['increment']>[1];
    expectTypeOf<'age'>().toMatchTypeOf<IncrementField>();
    expectTypeOf<'name'>().toMatchTypeOf<IncrementField>();
    // But also arbitrary strings for flexibility
    const nested: IncrementField = 'nested.count';
    expect(nested).toBe('nested.count');
  });

  it('works with subdocument method paths', () => {
    type Methods = AllPluginMethods<IUser>;
    type SubdocPath = Parameters<Methods['addSubdocument']>[1];
    expectTypeOf<'tags'>().toMatchTypeOf<SubdocPath>();
  });

  it('works with aggregate helper fields', () => {
    type Methods = AllPluginMethods<IUser>;
    type GroupByField = Parameters<Methods['groupBy']>[0];
    expectTypeOf<'status'>().toMatchTypeOf<GroupByField>();
    expectTypeOf<'age'>().toMatchTypeOf<GroupByField>();
  });
});

// ============================================================================
// Repository Method Signature Tests
// ============================================================================

describe('Repository method signatures use shared types', () => {
  let MockModel: any;
  let mockQuery: any;
  let countQuery: any;

  beforeEach(() => {
    mockQuery = {
      find: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      hint: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      read: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: '1', name: 'test' }]),
    };

    countQuery = {
      session: vi.fn().mockReturnThis(),
      hint: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      read: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(10),
    };

    const sessionableQuery = () => ({
      ...mockQuery,
      session: vi.fn().mockReturnValue(mockQuery),
    });

    // MockModel needs to be callable as constructor for `new Model(data)`
    MockModel = vi.fn().mockImplementation((data: any) => ({
      ...data,
      _id: '1',
      save: vi.fn().mockResolvedValue({ ...data, _id: '1' }),
      toObject: vi.fn().mockReturnValue({ ...data, _id: '1' }),
    }));
    Object.assign(MockModel, {
      modelName: 'User',
      schema: { indexes: () => [['_id_'], [{ name: 'text' }]] },
      find: vi.fn().mockReturnValue(mockQuery),
      findById: vi.fn().mockReturnValue(mockQuery),
      findOne: vi.fn().mockReturnValue(mockQuery),
      create: vi.fn().mockResolvedValue({ _id: '1', name: 'test' }),
      insertMany: vi.fn().mockResolvedValue([{ _id: '1', name: 'test' }]),
      findByIdAndUpdate: vi.fn().mockReturnValue(mockQuery),
      findByIdAndDelete: vi.fn().mockReturnValue(sessionableQuery()),
      findOneAndDelete: vi.fn().mockReturnValue(sessionableQuery()),
      countDocuments: vi.fn().mockReturnValue(countQuery),
      estimatedDocumentCount: vi.fn().mockResolvedValue(100),
      exists: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        read: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({ _id: '1' }),
      }),
      distinct: vi.fn().mockResolvedValue(['a', 'b']),
      aggregate: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        hint: vi.fn().mockReturnThis(),
        option: vi.fn().mockReturnThis(),
        read: vi.fn().mockReturnThis(),
        allowDiskUse: vi.fn().mockReturnThis(),
        collation: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  it('create() accepts CreateOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: CreateOptions = { session: undefined };
    const result = await repo.create({ name: 'test' }, opts);
    expect(result).toBeDefined();
    expectTypeOf(result).toEqualTypeOf<IUser>();
  });

  it('createMany() accepts CreateOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: CreateOptions = { ordered: false };
    const result = await repo.createMany([{ name: 'a' }], opts);
    expect(result).toBeDefined();
    expectTypeOf(result).toEqualTypeOf<IUser[]>();
  });

  it('getById() accepts CacheableOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    mockQuery.exec.mockResolvedValue({ _id: '1', name: 'test' });
    const opts: CacheableOptions = {
      select: 'name email',
      lean: true,
      skipCache: true,
      readPreference: 'secondaryPreferred',
    };
    const result = await repo.getById('507f1f77bcf86cd799439011', opts);
    // Return type should be TDoc | null
    expectTypeOf(result).toEqualTypeOf<IUser | null>();
  });

  it('getByQuery() accepts CacheableOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    mockQuery.exec.mockResolvedValue({ _id: '1', name: 'test' });
    const opts: CacheableOptions = { populate: 'department', cacheTtl: 120 };
    const result = await repo.getByQuery({ status: 'active' }, opts);
    expectTypeOf(result).toEqualTypeOf<IUser | null>();
  });

  it('count() accepts ReadOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: ReadOptions = { readPreference: 'secondary' };
    const result = await repo.count({ status: 'active' }, opts);
    expectTypeOf(result).toEqualTypeOf<number>();
  });

  it('exists() accepts ReadOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: ReadOptions = { session: undefined, readPreference: 'nearest' };
    await repo.exists({ email: 'test@test.com' }, opts);
    expect(MockModel.exists).toHaveBeenCalled();
  });

  it('delete() accepts SessionOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    mockQuery.exec.mockResolvedValue({ _id: '1' });
    const opts: SessionOptions = { session: undefined };
    const result = await repo.delete('1', opts);
    expectTypeOf(result).toEqualTypeOf<DeleteResult>();
  });

  it('aggregate() accepts AggregateOptions with typed collation', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: AggregateOptions = {
      allowDiskUse: true,
      collation: { locale: 'en', strength: 2 },
      maxTimeMS: 5000,
      maxPipelineStages: 20,
    };
    await repo.aggregate([{ $match: { status: 'active' } }], opts);
    const aggMock = MockModel.aggregate.mock.results[0].value;
    expect(aggMock.allowDiskUse).toHaveBeenCalledWith(true);
  });

  it('getAll() second arg accepts CacheableOptions', async () => {
    const repo = new Repository<IUser>(MockModel as any, []);
    const opts: CacheableOptions = { skipCache: true, lean: false };
    const result = await repo.getAll({ filters: { status: 'active' } }, opts);
    // Return type should be union of pagination results
    expectTypeOf(result).toEqualTypeOf<
      OffsetPaginationResult<IUser> | KeysetPaginationResult<IUser>
    >();
  });
});

// ============================================================================
// RepositoryEvent Autocomplete Tests
// ============================================================================

describe('RepositoryEvent type', () => {
  it('includes all lifecycle events', () => {
    // These should all be valid RepositoryEvent values
    const events: RepositoryEvent[] = [
      'before:create',
      'after:create',
      'error:create',
      'before:update',
      'after:update',
      'error:update',
      'before:delete',
      'after:delete',
      'error:delete',
      'before:getById',
      'after:getById',
      'error:getById',
      'before:getAll',
      'after:getAll',
      'error:getAll',
      'before:aggregate',
      'after:aggregate',
      'method:registered',
      'error:hook',
    ];
    expect(events).toHaveLength(19);
  });

  it('Repository.on() accepts RepositoryEvent', () => {
    const MockModel = { modelName: 'Test', schema: { indexes: () => [] } } as any;
    const repo = new Repository(MockModel, []);
    // Should compile without error — typed event names
    repo.on('before:create', (ctx) => {});
    repo.on('after:update', (payload) => {});
    repo.on('error:delete', (payload) => {});
    // Still accepts custom string events (for extensibility)
    repo.on('custom:event', (data) => {});
    expect(repo._hooks.size).toBe(4);
  });
});

// ============================================================================
// SoftDeleteRepository Generic Tests
// ============================================================================

describe('SoftDeleteRepository<TDoc>', () => {
  it('restore returns typed document', () => {
    type TypedSoftDelete = SoftDeleteRepository<IUser>;
    type RestoreReturn = ReturnType<TypedSoftDelete['restore']>;
    expectTypeOf<RestoreReturn>().toEqualTypeOf<Promise<IUser>>();
  });

  it('getDeleted returns typed pagination result', () => {
    type TypedSoftDelete = SoftDeleteRepository<IUser>;
    type GetDeletedReturn = ReturnType<TypedSoftDelete['getDeleted']>;
    expectTypeOf<GetDeletedReturn>().toEqualTypeOf<Promise<OffsetPaginationResult<IUser>>>();
  });
});

// ============================================================================
// LookupPopulateResult Generic Tests
// ============================================================================

describe('LookupPopulateResult<T>', () => {
  it('data array is typed', () => {
    type Result = LookupPopulateResult<IUser>;
    expectTypeOf<Result['data']>().toEqualTypeOf<IUser[]>();
  });

  it('has proper pagination fields', () => {
    expectTypeOf<LookupPopulateResult>().toHaveProperty('total');
    expectTypeOf<LookupPopulateResult>().toHaveProperty('limit');
    expectTypeOf<LookupPopulateResult>().toHaveProperty('page');
    expectTypeOf<LookupPopulateResult>().toHaveProperty('next');
    expectTypeOf<LookupPopulateResult>().toHaveProperty('hasMore');
  });
});

// ============================================================================
// WithPlugins Composition Tests
// ============================================================================

describe('WithPlugins type composition', () => {
  it('combines repository methods with plugin methods', () => {
    type UserRepoWithPlugins = WithPlugins<IUser, Repository<IUser>>;
    // Core repo methods
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('create');
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('getById');
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('update');
    // Plugin methods
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('increment');
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('restore');
    expectTypeOf<UserRepoWithPlugins>().toHaveProperty('bulkWrite');
  });
});

// ============================================================================
// QueryParser Getter Tests
// ============================================================================

describe('QueryParser getters', () => {
  it('allowedFilterFields returns configured fields', () => {
    const parser = new QueryParser({ allowedFilterFields: ['status', 'name'] });
    expect(parser.allowedFilterFields).toEqual(['status', 'name']);
  });

  it('allowedFilterFields returns undefined when not configured', () => {
    const parser = new QueryParser();
    expect(parser.allowedFilterFields).toBeUndefined();
  });

  it('allowedSortFields returns configured fields', () => {
    const parser = new QueryParser({ allowedSortFields: ['createdAt'] });
    expect(parser.allowedSortFields).toEqual(['createdAt']);
  });

  it('allowedSortFields returns undefined when not configured', () => {
    const parser = new QueryParser();
    expect(parser.allowedSortFields).toBeUndefined();
  });

  it('allowedOperators returns configured operators', () => {
    const parser = new QueryParser({ allowedOperators: ['eq', 'ne', 'in'] });
    expect(parser.allowedOperators).toEqual(['eq', 'ne', 'in']);
  });

  it('allowedOperators returns undefined when not configured', () => {
    const parser = new QueryParser();
    expect(parser.allowedOperators).toBeUndefined();
  });
});
