import { afterEach, describe, expect, it, vi } from "vitest";
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid TTL %s before writing to the cache",
    async (ttlSeconds) => {
      await expect(cache.set("test:cache:invalid-ttl", "value", ttlSeconds)).rejects.toThrow(
        "Cache TTL must be a positive integer number of seconds."
      );
      await expect(cache.setIfAbsent("test:cache:invalid-ttl", "value", ttlSeconds)).rejects.toThrow(
        "Cache TTL must be a positive integer number of seconds."
      );
      await expect(cache.increment("test:cache:invalid-ttl", ttlSeconds)).rejects.toThrow(
        "Cache TTL must be a positive integer number of seconds."
      );
    }
  );

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

  it("does not extend a counter TTL when incrementing an existing key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      expect(await cache.increment("test:cache:ttl-counter", 10)).toBe(1);

      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
      expect(await cache.increment("test:cache:ttl-counter", 10)).toBe(2);

      vi.setSystemTime(new Date("2026-01-01T00:00:10.001Z"));
      await expect(cache.get("test:cache:ttl-counter")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes keys by prefix", async () => {
    await cache.set("test:cache:a", 1);
    await cache.set("test:cache:b", 2);
    const deleted = await cache.deleteByPrefix("test:cache:");

    expect(deleted).toBeGreaterThanOrEqual(2);
    await expect(cache.get("test:cache:a")).resolves.toBeNull();
  });
});
