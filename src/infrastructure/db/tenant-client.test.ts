import { describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { createTenantClient } from "./tenant-client";

type QueryArgs = Record<string, unknown>;
type OperationHandler = (input: {
  model?: string;
  operation: string;
  args: QueryArgs;
  query: (args: QueryArgs) => Promise<unknown>;
}) => Promise<unknown>;

function createHarness(tenantId = "tenant-a") {
  let handler: OperationHandler | undefined;
  const prisma = {
    $extends(extension: unknown) {
      const value = extension as {
        query: { $allModels: { $allOperations: OperationHandler } };
      };
      handler = value.query.$allModels.$allOperations;
      return {};
    }
  } as unknown as PrismaClient;

  const defineExtensionSpy = vi
    .spyOn(Prisma, "defineExtension")
    .mockImplementation((extension) => extension as never);
  try {
    createTenantClient(prisma, tenantId);
  } finally {
    defineExtensionSpy.mockRestore();
  }
  if (!handler) throw new Error("Tenant query extension was not registered.");
  return handler;
}

describe("tenant-scoped Prisma client", () => {
  it("requires a non-empty tenant identifier", () => {
    const prisma = { $extends: vi.fn() } as unknown as PrismaClient;
    expect(() => createTenantClient(prisma, "  ")).toThrow(/tenant ID/i);
    expect(prisma.$extends).not.toHaveBeenCalled();
  });

  it("adds tenant scope to reads without dropping existing filters", async () => {
    const handler = createHarness();
    const args: QueryArgs = { where: { status: "ACTIVE" } };
    const query = vi.fn(async (received: QueryArgs) => received);

    await handler({ model: "Product", operation: "findMany", args, query });

    expect(args.where).toEqual({
      AND: [{ status: "ACTIVE" }, { tenantId: "tenant-a" }]
    });
    expect(query).toHaveBeenCalledWith(args);
  });

  it("forces the tenant ID on direct creates", async () => {
    const handler = createHarness();
    const args: QueryArgs = { data: { tenantId: "tenant-b", name: "Product" } };

    await handler({
      model: "Product",
      operation: "create",
      args,
      query: async (received) => received
    });

    expect(args.data).toEqual({ tenantId: "tenant-a", name: "Product" });
  });

  it("forces tenant IDs on every createMany row", async () => {
    const handler = createHarness();
    const args: QueryArgs = {
      data: [
        { tenantId: "tenant-b", name: "one" },
        { name: "two" }
      ]
    };

    await handler({
      model: "Product",
      operation: "createMany",
      args,
      query: async (received) => received
    });

    expect(args.data).toEqual([
      { tenantId: "tenant-a", name: "one" },
      { tenantId: "tenant-a", name: "two" }
    ]);
  });

  it("rejects nested relation writes before they can bypass tenant checks", async () => {
    const handler = createHarness();
    const query = vi.fn(async (received: QueryArgs) => received);

    await expect(handler({
      model: "Product",
      operation: "create",
      args: { data: { name: "cross-tenant", tenant: { connect: { id: "tenant-b" } } } },
      query
    })).rejects.toThrow(/nested relation writes/i);

    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unsupported models instead of silently running unscoped", async () => {
    const handler = createHarness();
    const query = vi.fn(async () => "should not run");

    await expect(handler({
      model: "Tenant",
      operation: "findMany",
      args: {},
      query
    })).rejects.toThrow(/unsupported model access/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("adds the tenant selector to unique reads", async () => {
    const handler = createHarness();
    const args: QueryArgs = { where: { id: "product-1" } };

    await handler({
      model: "Product",
      operation: "findUnique",
      args,
      query: async (received) => received
    });

    expect(args.where).toEqual({ id: "product-1", tenantId: "tenant-a" });
  });

  it("adds tenant scope to updateMany and deleteMany filters", async () => {
    const handler = createHarness();

    for (const operation of ["updateMany", "deleteMany"]) {
      const args: QueryArgs = { where: { status: "ACTIVE" } };
      await handler({
        model: "Product",
        operation,
        args,
        query: async (received) => received
      });
      expect(args.where).toEqual({
        AND: [{ status: "ACTIVE" }, { tenantId: "tenant-a" }]
      });
    }
  });

  it("overrides a supplied tenant ID in unique mutations", async () => {
    const handler = createHarness();
    const args: QueryArgs = { where: { id: "product-1", tenantId: "tenant-b" } };

    await handler({
      model: "Product",
      operation: "update",
      args,
      query: async (received) => received
    });

    expect(args.where).toEqual({ id: "product-1", tenantId: "tenant-a" });
  });

  it("forces tenant IDs on both branches of upsert", async () => {
    const handler = createHarness();
    const args: QueryArgs = {
      where: { id: "product-1" },
      create: { tenantId: "tenant-b", name: "created" },
      update: { tenantId: "tenant-b", name: "updated" }
    };

    await handler({
      model: "Product",
      operation: "upsert",
      args,
      query: async (received) => received
    });

    expect(args.where).toEqual({ id: "product-1", tenantId: "tenant-a" });
    expect(args.create).toEqual({ tenantId: "tenant-a", name: "created" });
    expect(args.update).toEqual({ tenantId: "tenant-a", name: "updated" });
  });

  it("rejects missing unique selectors before running a mutation", async () => {
    const handler = createHarness();
    const query = vi.fn(async () => "should not run");

    await expect(handler({
      model: "Product",
      operation: "delete",
      args: {},
      query
    })).rejects.toThrow(/where clause/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unknown Prisma operations before running the query", async () => {
    const handler = createHarness();
    const query = vi.fn(async () => "should not run");

    await expect(handler({
      model: "Product",
      operation: "rawQuery",
      args: {},
      query
    })).rejects.toThrow(/unsupported Prisma operation/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("scopes bulk-return updates and forces tenant IDs on bulk-return creates", async () => {
    const handler = createHarness();
    const updateArgs: QueryArgs = { where: { status: "ACTIVE" }, data: { status: "PAUSED" } };
    await handler({
      model: "Product",
      operation: "updateManyAndReturn",
      args: updateArgs,
      query: async (received) => received
    });
    expect(updateArgs.where).toEqual({
      AND: [{ status: "ACTIVE" }, { tenantId: "tenant-a" }]
    });

    const createArgs: QueryArgs = { data: [{ tenantId: "tenant-b", name: "new" }] };
    await handler({
      model: "Product",
      operation: "createManyAndReturn",
      args: createArgs,
      query: async (received) => received
    });
    expect(createArgs.data).toEqual([{ tenantId: "tenant-a", name: "new" }]);
  });

});
