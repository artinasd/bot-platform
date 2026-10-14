import { ProductType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CatalogService } from "./catalog.service";

describe("catalog service validation", () => {
  it("rejects invalid product slugs before database access", async () => {
    const service = new CatalogService({} as never);
    await expect(service.createProduct({
      tenantId: "tenant",
      slug: "Invalid Slug",
      name: "Example",
      type: ProductType.DIGITAL,
      priceMinor: 100n
    })).rejects.toThrow(/Slug/);
  });

  it("rejects negative prices before database access", async () => {
    const service = new CatalogService({} as never);
    await expect(service.createProduct({
      tenantId: "tenant",
      slug: "valid-product",
      name: "Example",
      type: ProductType.DIGITAL,
      priceMinor: -1n
    })).rejects.toThrow(/negative/);
  });
});
