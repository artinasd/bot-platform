import { PrismaClient, RecordStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken, SessionService } from "./session.service";

describe("session token hashing", () => {
  it("stores a fixed-length digest instead of the raw session token", () => {
    const token = "random-opaque-session-token";
    const digest = hashSessionToken(token);
    expect(digest).not.toBe(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces stable hashes for token lookup", () => {
    expect(hashSessionToken("same-token")).toBe(hashSessionToken("same-token"));
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
  });
});

const sessionRecord = {
  id: "session-1",
  userId: "user-1",
  tenantId: "tenant-a",
  expiresAt: new Date(Date.now() + 60_000),
  user: {
    id: "user-1",
    email: "person@example.com",
    phone: null,
    displayName: "Person",
    status: RecordStatus.ACTIVE,
    tenantId: null
  }
};

function makeDb() {
  return {
    session: {
      findFirst: vi.fn().mockResolvedValue(sessionRecord),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    staffMember: { findFirst: vi.fn().mockResolvedValue(null) },
    customer: { findFirst: vi.fn().mockResolvedValue(null) }
  };
}

describe("session tenant membership validation", () => {
  let db: ReturnType<typeof makeDb>;
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    service = new SessionService(db as unknown as PrismaClient);
  });

  it("revokes a tenant session when the user no longer has active membership", async () => {
    const result = await service.resolve("valid-session-token");

    expect(result).toBeNull();
    expect(db.staffMember.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant-a", status: RecordStatus.ACTIVE },
      select: { id: true }
    });
    expect(db.customer.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant-a", status: RecordStatus.ACTIVE },
      select: { id: true }
    });
    expect(db.session.updateMany).toHaveBeenCalledTimes(1);
    const update = db.session.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "session-1", revokedAt: null });
    expect(update.data.revokedAt).toBeInstanceOf(Date);
    expect(update.data).not.toHaveProperty("lastSeenAt");
  });

  it("keeps the session valid when active staff membership remains", async () => {
    db.staffMember.findFirst.mockResolvedValue({ id: "staff-1" });

    const result = await service.resolve("valid-session-token");

    expect(result).toEqual(sessionRecord);
    expect(db.session.updateMany).toHaveBeenCalledTimes(1);
    const update = db.session.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({
      id: "session-1",
      revokedAt: null,
      expiresAt: { gt: expect.any(Date) }
    });
    expect(update.data.lastSeenAt).toBeInstanceOf(Date);
    expect(update.data).not.toHaveProperty("revokedAt");
  });
});
