import { describe, it, expect, vi, beforeEach } from "vitest";
import { Repository } from "../src/Repository.js";
import { QueryParser } from "../src/query/QueryParser.js";
import * as logger from "../src/utils/logger.js";

describe("New Pagination and Query Governance", () => {
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
      exec: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    };

    countQuery = {
      session: vi.fn().mockReturnThis(),
      hint: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      read: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(10), // mock the exec method properly
    };

    MockModel = {
      modelName: "TestModel",
      schema: { indexes: () => [["_id_"], [{ name: "text" }]] },
      find: vi.fn().mockReturnValue(mockQuery),
      countDocuments: vi.fn().mockReturnValue(countQuery),
      estimatedDocumentCount: vi.fn().mockResolvedValue(100),
      aggregate: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        hint: vi.fn().mockReturnThis(),
        option: vi.fn().mockReturnThis(),
        read: vi.fn().mockReturnThis(),
        exec: vi
          .fn()
          .mockResolvedValue([{ docs: [{ id: 1 }], total: [{ count: 10 }] }]),
      }),
    };
  });

  it("respects countStrategy: estimated", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.getAll({ mode: "offset", countStrategy: "estimated" });

    expect(MockModel.estimatedDocumentCount).toHaveBeenCalled();
    expect(MockModel.countDocuments).not.toHaveBeenCalled();
  });

  it("respects countStrategy: none", async () => {
    const repo = new Repository(MockModel as any, []);
    const result = (await repo.getAll({
      mode: "offset",
      countStrategy: "none",
    })) as any;

    expect(MockModel.estimatedDocumentCount).not.toHaveBeenCalled();
    expect(MockModel.countDocuments).not.toHaveBeenCalled();
    expect(result.total).toBe(0); // Returns 0 when no count is run
    expect(result.hasNext).toBe(false); // returned 2 items but default limit is higher (so false)
  });

  it("evaluates hasNext correctly under countStrategy: none using limit+1 pattern", async () => {
    const repo = new Repository(MockModel as any, []);

    // Mock returns 2 items. With limit=2, we fetch limit+1=3, get back 2.
    // 2 is NOT > 2, so hasNext=false (correctly: no more items beyond what we asked for)
    const resultExact = (await repo.getAll({
      mode: "offset",
      countStrategy: "none",
      limit: 2,
    })) as any;
    expect(resultExact.hasNext).toBe(false);

    // Mock returns 2 items. With limit=1, we fetch limit+1=2, get back 2.
    // 2 > 1, so hasNext=true (correctly: there are more items)
    const resultMore = (await repo.getAll({
      mode: "offset",
      countStrategy: "none",
      limit: 1,
    })) as any;
    expect(resultMore.hasNext).toBe(true);
    // Should only return `limit` docs, not the extra one
    expect(resultMore.docs).toHaveLength(1);

    // limit 3 is more than the 2 mock items — hasNext=false
    const resultPartial = (await repo.getAll({
      mode: "offset",
      countStrategy: "none",
      limit: 3,
    })) as any;
    expect(resultPartial.hasNext).toBe(false);
  });

  it("passes hint and maxTimeMS to query", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.getAll({ hint: "{ _id: 1 }", maxTimeMS: 50 });

    expect(mockQuery.hint).toHaveBeenCalledWith("{ _id: 1 }");
    expect(mockQuery.maxTimeMS).toHaveBeenCalledWith(50);
  });

  it("drops unallowed sort fields in QueryParser", () => {
    const parser = new QueryParser({ allowedSortFields: ["name"] });
    const parsed = parser.parse({ sort: "name,-description,id" });

    expect(parsed.sort).toEqual({ name: 1 });
  });

  it("returns undefined when all sort fields are blocked", () => {
    const parser = new QueryParser({ allowedSortFields: ["name"] });
    const parsed = parser.parse({ sort: "-description" });

    expect(parsed.sort).toBeUndefined();
  });

  it("drops unallowed sort fields when sort is an object", () => {
    const parser = new QueryParser({ allowedSortFields: ["name"] });
    const parsed = parser.parse({
      sort: { name: "asc", description: "-1", id: "desc" },
    } as any);

    expect(parsed.sort).toEqual({ name: 1 });
  });

  it("returns undefined when all object sort fields are blocked", () => {
    const parser = new QueryParser({ allowedSortFields: ["name"] });
    const parsed = parser.parse({ sort: { description: "-1", id: 1 } } as any);

    expect(parsed.sort).toBeUndefined();
  });

  it("parses comma-separated sort strings in Repository correctly", () => {
    const repo = new Repository(MockModel as any, []);
    const sortObj = repo._parseSort("-createdAt,name");

    expect(sortObj).toEqual({ createdAt: -1, name: 1 });
  });

  it("throws error on search when no text index is present", async () => {
    MockModel.schema.indexes = () => [["_id_"]]; // No text index
    const repo = new Repository(MockModel as any, []);

    await expect(repo.getAll({ search: "test query" })).rejects.toThrow(
      /No text index found/,
    );
  });

  it("attaches code + meta to SEARCH_NOT_CONFIGURED error", async () => {
    MockModel.schema.indexes = () => [["_id_"]]; // No text index
    const repo = new Repository(MockModel as any, []);

    let caught: any;
    try {
      await repo.getAll({ search: "test query" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.status).toBe(400);
    expect(caught.code).toBe("SEARCH_NOT_CONFIGURED");
    expect(caught.meta).toBeDefined();
    expect(caught.meta.model).toBe("TestModel");
    expect(caught.meta.configuredMode).toBe("text");
    expect(caught.meta.availableModes).toEqual(["text", "regex", "auto"]);
    expect(typeof caught.meta.docs).toBe("string");
    // Message should name the model and suggest both fixes
    expect(caught.message).toMatch(/TestModel/);
    expect(caught.message).toMatch(/searchMode: 'regex'/);
    expect(caught.message).toMatch(/searchMode: 'text'/);
  });

  it("warns when nested filter contains reserved pagination key", () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Common typo: ?filters[limit]=5 nests under `filters` instead of going
    // to top-level limit. Without the guard this is silently dropped.
    parser.parse({ filters: { limit: "5", page: "2" } } as any);

    const reservedWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("reserved key"),
    );
    expect(reservedWarns.length).toBe(2);
    expect(String(reservedWarns[0][0])).toMatch(/'limit'/);
    expect(String(reservedWarns[0][0])).toMatch(/filters\.limit/);
    expect(String(reservedWarns[1][0])).toMatch(/'page'/);

    warnSpy.mockRestore();
  });

  it("does NOT warn for legitimate operator keys in nested syntax", () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // ?status[in]=a,b — `in` is an operator, not a reserved key.
    parser.parse({ status: { in: "a,b" }, score: { gt: "10" } } as any);

    const reservedWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("reserved key"),
    );
    expect(reservedWarns.length).toBe(0);

    warnSpy.mockRestore();
  });

  it("applies readPreference to offset pagination queries and counts", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.getAll(
      { mode: "offset", limit: 2 },
      { readPreference: "secondary" },
    );

    // Should apply to primary docs query
    expect(mockQuery.read).toHaveBeenCalledWith("secondary");
    // Should apply to exact count query
    expect(countQuery.read).toHaveBeenCalledWith("secondary");
  });

  it("applies readPreference to keyset pagination stream", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.getAll(
      { mode: "keyset", limit: 2, sort: { _id: 1 } },
      { readPreference: "secondaryPreferred" },
    );

    expect(mockQuery.read).toHaveBeenCalledWith("secondaryPreferred");
  });

  it("applies readPreference to aggregatePaginate queries", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.aggregatePipelinePaginate({
      pipeline: [{ $match: { _id: 1 } }],
      readPreference: "nearest",
    });

    const aggregateMock = MockModel.aggregate.mock.results[0].value;
    expect(aggregateMock.read).toHaveBeenCalledWith("nearest");
  });

  it("prioritizes context.readPreference over options and params", async () => {
    const repo = new Repository(MockModel as any, []);

    // Explicitly add the hook event since a mock object doesn't have .apply
    repo.on("before:getAll", async (context: any) => {
      context.readPreference = "primary";
    });

    await repo.getAll(
      { limit: 2, readPreference: "secondary" }, // params
      { readPreference: "nearest" }, // options
    );

    // Context wins due to the plugin
    expect(mockQuery.read).toHaveBeenCalledWith("primary");
  });

  it("prioritizes options.readPreference over params", async () => {
    const repo = new Repository(MockModel as any, []);
    await repo.getAll(
      { limit: 2, readPreference: "secondary" }, // params
      { readPreference: "nearest" }, // options
    );
    expect(mockQuery.read).toHaveBeenCalledWith("nearest");
  });
});
