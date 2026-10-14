import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "./audit.service";

const auditCreate = vi.fn();

function makeService() {
  return new AuditService({ auditLog: { create: auditCreate } } as never);
}

const input = {
  tenantId: "tenant-a",
  actorType: "STAFF" as const,
  actorId: "staff-a",
  action: "order.payment.confirmed",
  resourceType: "Payment",
  resourceId: "payment-a",
  previousState: { status: "PENDING" },
  newState: { status: "CONFIRMED" },
  source: "payment-confirmation",
  correlationId: "request-a"
};

describe("audit service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditCreate.mockResolvedValue({ id: "audit-a" });
  });

  it("persists audit metadata and state snapshots", async () => {
    await expect(makeService().record(input)).resolves.toEqual({ id: "audit-a" });
    expect(auditCreate).toHaveBeenCalledWith({ data: input });
  });

  it("rejects a blank action before writing", async () => {
    await expect(makeService().record({ ...input, action: " " })).rejects.toThrow("Audit action is required.");
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a blank resource type before writing", async () => {
    await expect(makeService().record({ ...input, resourceType: " " })).rejects.toThrow("Audit resourceType is required.");
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a blank source or correlation ID before writing", async () => {
    await expect(makeService().record({ ...input, source: "" })).rejects.toThrow("Audit source is required.");
    await expect(makeService().record({ ...input, correlationId: " " })).rejects.toThrow("Audit correlationId is required.");
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("normalizes absent optional identifiers and state snapshots", async () => {
    const { previousState: _previousState, newState: _newState, ...record } = input;
    await makeService().record({ ...record, tenantId: null, actorId: null, resourceId: null });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        ...record,
        tenantId: null,
        actorId: null,
        resourceId: null,
        previousState: undefined,
        newState: undefined
      }
    });
  });
});
