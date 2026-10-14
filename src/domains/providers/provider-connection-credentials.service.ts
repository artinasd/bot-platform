import { PrismaClient, RecordStatus } from "@prisma/client";
import { decryptCredential } from "../../infrastructure/security/credential-encryption";

export type ActiveProviderCredentials = Readonly<{
  connectionId: string;
  providerType: string;
  credentials: string;
  config: unknown;
}>;

/**
 * Resolves an active provider connection within an explicit tenant boundary.
 * Keep the returned plaintext credentials in server-side memory only; callers
 * must never include them in API responses, logs, or persisted operation data.
 */
export class ProviderConnectionCredentialsService {
  constructor(private readonly db: PrismaClient) {}

  async getActiveCredentials(tenantId: string, connectionId: string): Promise<ActiveProviderCredentials> {
    if (!tenantId.trim()) throw new Error("Tenant ID is required.");
    if (!connectionId.trim()) throw new Error("Provider connection ID is required.");

    const connection = await this.db.providerConnection.findFirst({
      where: {
        id: connectionId,
        tenantId,
        status: RecordStatus.ACTIVE
      },
      select: {
        id: true,
        providerType: true,
        credentialCiphertext: true,
        config: true
      }
    });

    if (!connection) {
      throw new Error("Active provider connection was not found in this tenant.");
    }

    return {
      connectionId: connection.id,
      providerType: connection.providerType,
      credentials: decryptCredential(connection.credentialCiphertext),
      config: connection.config
    };
  }
}
