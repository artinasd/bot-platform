import { afterEach, describe, expect, it } from "vitest";
import { cache } from "./redis";

describe("cache local fallback", () => {
  afterEach(async () => {
    await cache.deleteByPrefix("test:cache:");
  });

  it("stores and reads JSON values", async () => {
    const value = { count: 3, label: "catalog" };
    await cache.set("test:cache:value", value, 60);

    await expect(cache.get("test:cache:value")).resolves.toEqual(value);
  });

  it("returns null for missing keys", async () => {
    await expect(cache.get("test:cache:missing")).resolves.toBeNull();
  });

  it("only allows the first set-if-absent operation", async () => {
    const first = await cache.setIfAbsent("test:cache:once", { accepted: true }, 60);
    const second = await cache.setIfAbsent("test:cache:once", { accepted: false }, 60);

    expect(first).toBe(true);
    expect(second).toBe(false);
    await expect(cache.get("test:cache:once")).resolves.toEqual({ accepted: true });
  });

  it("increments counters", async () => {
    expect(await cache.increment("test:cache:counter", 60)).toBe(1);
    expect(await cache.increment("test:cache:counter", 60)).toBe(2);
  });

  it("deletes keys by prefix", async () => {
    await cache.set("test:cache:a", 1);
    await cache.set("test:cache:b", 2);
    const deleted = await cache.deleteByPrefix("test:cache:");

    expect(deleted).toBeGreaterThanOrEqual(2);
    await expect(cache.get("test:cache:a")).resolves.toBeNull();
  });
});
