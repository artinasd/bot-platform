import { describe, expect, it } from "vitest";
import { AuditService } from "./audit.service";

describe("audit service", () => {
  it("is exported", () => {
    expect(AuditService).toBeDefined();
  });
});
