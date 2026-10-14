import { randomBytes } from "node:crypto";
import { RecordStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../../infrastructure/security/credential-encryption";
import { ProviderConnectionCredentialsService } from "./provider-connection-credentials.service";

const mocks = vi.hoisted(() => ({
  findConnection: vi.fn()
}));

const db = {
  providerConnection: { findFirst: mocks.findConnection }
};

const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

describe("provider connection credentials service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    mocks.findConnection.mockImplementation(async () => ({
      id: "connection-a",
      providerType: "example-provider",
      credentialCiphertext: encryptCredential("provider-secret"),
      config: { region: "eu" }
    }));
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
  });

  it("loads only an active connection owned by the requested tenant and decrypts its credentials", async () => {
    const result = await new ProviderConnectionCredentialsService(db as never)
      .getActiveCredentials("tenant-a", "connection-a");

    expect(mocks.findConnection).toHaveBeenCalledWith({
      where: { id: "connection-a", tenantId: "tenant-a", status: RecordStatus.ACTIVE },
      select: { id: true, providerType: true, credentialCiphertext: true, config: true }
    });
    expect(result).toEqual({
      connectionId: "connection-a",
      providerType: "example-provider",
      credentials: "provider-secret",
      config: { region: "eu" }
    });
  });

  it("does not return credentials when the connection is absent, inactive, or belongs to another tenant", async () => {
    mocks.findConnection.mockResolvedValue(null);
    await expect(new ProviderConnectionCredentialsService(db as never)
      .getActiveCredentials("tenant-a", "connection-a"))
      .rejects.toThrow(/not found in this tenant/);
  });

  it("requires tenant and connection IDs before querying", async () => {
    const service = new ProviderConnectionCredentialsService(db as never);
    await expect(service.getActiveCredentials(" ", "connection-a")).rejects.toThrow(/Tenant ID is required/);
    await expect(service.getActiveCredentials("tenant-a", " ")).rejects.toThrow(/Provider connection ID is required/);
    expect(mocks.findConnection).not.toHaveBeenCalled();
  });

  it("fails closed when encrypted credentials cannot be decrypted", async () => {
    mocks.findConnection.mockResolvedValue({
      id: "connection-a",
      providerType: "example-provider",
      credentialCiphertext: "invalid-envelope",
      config: {}
    });
    await expect(new ProviderConnectionCredentialsService(db as never)
      .getActiveCredentials("tenant-a", "connection-a"))
      .rejects.toThrow(/invalid or uses an unsupported version/);
  });
});
