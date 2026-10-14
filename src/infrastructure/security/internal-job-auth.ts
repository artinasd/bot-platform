import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;
const BEARER_PREFIX = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Validates an Authorization header for internal job dispatch.
 * Configure a high-entropy secret of at least 32 characters. Hashing both
 * values to a fixed-size digest allows timingSafeEqual without length leaks.
 */
export function isValidInternalJobAuthorization(
  authorizationHeader: string | null | undefined,
  configuredSecret = process.env.INTERNAL_JOB_SECRET
): boolean {
  if (
    typeof configuredSecret !== "string" ||
    configuredSecret.length < MIN_SECRET_LENGTH ||
    configuredSecret.trim() !== configuredSecret
  ) {
    return false;
  }

  if (
    typeof authorizationHeader !== "string" ||
    !authorizationHeader.startsWith(BEARER_PREFIX)
  ) {
    return false;
  }

  const candidate = authorizationHeader.slice(BEARER_PREFIX.length);
  if (!candidate || candidate.trim() !== candidate) return false;

  return timingSafeEqual(digest(candidate), digest(configuredSecret));
}
