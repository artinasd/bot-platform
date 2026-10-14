import { Redis } from "@upstash/redis";

type CacheEntry = {
  value: string;
  expiresAt: number | null;
};

const localStore = new Map<string, CacheEntry>();
const DEFAULT_TTL_SECONDS = 300;

function validateTtlSeconds(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Cache TTL must be a positive integer number of seconds.");
  }
}

let redisClient: Redis | null | undefined;

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    redisClient = null;
    return redisClient;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function localGet(key: string): string | null {
  const entry = localStore.get(key);
  if (!entry) return null;

  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    localStore.delete(key);
    return null;
  }

  return entry.value;
}

function localSet(key: string, value: string, ttlSeconds?: number): void {
  localStore.set(key, {
    value,
    expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
  });
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const redis = getRedisClient();
    const raw = redis ? await redis.get<string>(key) : localGet(key);

    if (raw === null || raw === undefined) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
    validateTtlSeconds(ttlSeconds);
    const serialized = JSON.stringify(value);
    const redis = getRedisClient();

    if (redis) {
      await redis.set(key, serialized, { ex: ttlSeconds });
      return;
    }

    localSet(key, serialized, ttlSeconds);
  },

  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    validateTtlSeconds(ttlSeconds);
    const serialized = JSON.stringify(value);
    const redis = getRedisClient();

    if (redis) {
      const result = await redis.set(key, serialized, { ex: ttlSeconds, nx: true });
      return result === "OK";
    }

    if (localGet(key) !== null) return false;
    localSet(key, serialized, ttlSeconds);
    return true;
  },

  async delete(key: string): Promise<void> {
    const redis = getRedisClient();
    if (redis) {
      await redis.del(key);
      return;
    }
    localStore.delete(key);
  },

  async deleteByPrefix(prefix: string): Promise<number> {
    const redis = getRedisClient();

    if (redis) {
      let cursor = 0;
      let deleted = 0;

      do {
        const [nextCursor, keys] = await redis.scan(cursor, {
          match: `${prefix}*`,
          count: 100
        });
        cursor = Number(nextCursor);

        if (keys.length > 0) {
          deleted += await redis.del(...keys);
        }
      } while (cursor !== 0);

      return deleted;
    }

    let deleted = 0;
    for (const key of localStore.keys()) {
      if (key.startsWith(prefix)) {
        localStore.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  },

  async increment(key: string, ttlSeconds: number): Promise<number> {
    validateTtlSeconds(ttlSeconds);
    const redis = getRedisClient();

    if (redis) {
      const value = await redis.incr(key);
      if (value === 1) await redis.expire(key, ttlSeconds);
      return value;
    }

    const existingValue = localGet(key);
    const existingEntry = existingValue === null ? undefined : localStore.get(key);
    const current = Number(existingValue ?? "0") + 1;
    localStore.set(key, {
      value: String(current),
      expiresAt: existingEntry?.expiresAt ?? Date.now() + ttlSeconds * 1000
    });
    return current;
  },

  async isAvailable(): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis) return false;

    try {
      await redis.ping();
      return true;
    } catch {
      return false;
    }
  },

  get mode(): "upstash" | "memory" {
    return getRedisClient() ? "upstash" : "memory";
  }
};

export function cacheKeys(tenantId: string) {
  return {
    config: `tenant:${tenantId}:config`,
    catalog: `tenant:${tenantId}:catalog`,
    session: (telegramId: string) => `session:${tenantId}:${telegramId}`,
    configPrefix: `tenant:${tenantId}:`,
    catalogPrefix: `tenant:${tenantId}:catalog:`
  };
}
