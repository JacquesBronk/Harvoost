import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { PrismaService } from '../prisma/prisma.service';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

// ExportJobsService — persists export job rows, uploads XLSX buffers to Azure
// Blob Storage (or Azurite in dev), and produces 5-minute SAS download URLs.
//
// The signed URL is the security boundary — it's short-lived (5 min) and
// non-bearer; the caller does not need to authenticate the download itself.
//
// The export_jobs table is created lazily (additive migration). Caller-owned
// poll endpoint reads { status, download_url, expires_at }.

export interface ExportJobRow {
  id: string;
  actor_user_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  filter: unknown;
  download_url: string | null;
  expires_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const SAS_TTL_SECONDS = 5 * 60; // 5 minutes per SECURITY M10

@Injectable()
export class ExportJobsService {
  private readonly logger = new Logger(ExportJobsService.name);
  private blobReady = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  // Lazy DDL — additive, no-op if already present.
  private async ensureTable(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS export_jobs (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           actor_user_id BIGINT NOT NULL,
           status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
           filter JSONB NOT NULL,
           download_url TEXT,
           expires_at TIMESTAMPTZ,
           error TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE INDEX IF NOT EXISTS export_jobs_actor_created_idx
           ON export_jobs (actor_user_id, created_at DESC);`,
      );
    } catch (err) {
      this.logger.warn('export_jobs.ensure_table_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async create(actorUserId: string, filter: unknown): Promise<{ jobId: string }> {
    await this.ensureTable();
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `INSERT INTO export_jobs (actor_user_id, status, filter)
       VALUES ($1::bigint, 'queued', $2::jsonb)
       RETURNING id`,
      actorUserId,
      JSON.stringify(filter),
    );
    return { jobId: String(rows[0]!.id) };
  }

  async markRunning(jobId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE export_jobs SET status='running', updated_at=NOW() WHERE id = $1::uuid`,
      jobId,
    );
  }

  async markDone(jobId: string, downloadUrl: string, expiresAt: Date): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE export_jobs SET status='done', download_url=$2, expires_at=$3, updated_at=NOW()
       WHERE id = $1::uuid`,
      jobId,
      downloadUrl,
      expiresAt.toISOString(),
    );
  }

  async markFailed(jobId: string, error: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE export_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id = $1::uuid`,
      jobId,
      error.slice(0, 1000),
    );
  }

  async get(jobId: string, actorUserId: string): Promise<ExportJobRow | null> {
    await this.ensureTable();
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: unknown;
        actor_user_id: unknown;
        status: unknown;
        filter: unknown;
        download_url: unknown;
        expires_at: unknown;
        error: unknown;
        created_at: unknown;
        updated_at: unknown;
      }>
    >(
      `SELECT id, actor_user_id, status, filter, download_url, expires_at, error, created_at, updated_at
       FROM export_jobs
       WHERE id = $1::uuid AND actor_user_id = $2::bigint
       LIMIT 1`,
      jobId,
      actorUserId,
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: String(r.id),
      actor_user_id: String(r.actor_user_id),
      status: String(r.status) as ExportJobRow['status'],
      filter: r.filter,
      download_url: r.download_url ? String(r.download_url) : null,
      expires_at: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
      error: r.error ? String(r.error) : null,
      created_at: new Date(String(r.created_at)).toISOString(),
      updated_at: new Date(String(r.updated_at)).toISOString(),
    };
  }

  // Uploads the buffer + returns a 5-minute SAS URL.
  async uploadAndSign(
    actorUserId: string,
    fileName: string,
    buffer: Buffer,
  ): Promise<{ url: string; expiresAt: Date }> {
    if (!this.env.BLOB_STORAGE_CONNECTION_STRING) {
      // Dev fallback — return a synthetic file://-style URL so the contract works
      // without azurite. This is acceptable in test/dev only.
      this.logger.warn('export.upload.no_blob_conn_string', {
        note: 'BLOB_STORAGE_CONNECTION_STRING unset; returning data: URL stub',
      });
      const dataUri = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buffer
        .subarray(0, Math.min(buffer.length, 64))
        .toString('base64')}...`;
      return { url: dataUri, expiresAt: new Date(Date.now() + SAS_TTL_SECONDS * 1000) };
    }

    const containerName = this.env.BLOB_EXPORTS_CONTAINER;
    const service = BlobServiceClient.fromConnectionString(this.env.BLOB_STORAGE_CONNECTION_STRING);
    const container = service.getContainerClient(containerName);
    if (!this.blobReady) {
      try {
        await container.createIfNotExists();
      } catch (err) {
        this.logger.warn('export.upload.container_create_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.blobReady = true;
    }
    const blobName = `${actorUserId}/${fileName}`;
    const blockBlob = container.getBlockBlobClient(blobName);
    await blockBlob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });

    const expiresAt = new Date(Date.now() + SAS_TTL_SECONDS * 1000);

    // SAS generation requires the account name + key. Pull from the connection string.
    const credential = extractSharedKeyCredential(this.env.BLOB_STORAGE_CONNECTION_STRING);
    if (!credential) {
      // Account key not present (e.g., managed-identity-only). Fall back to the
      // blob's URL without SAS — caller will get 403 unless caller has separate auth.
      this.logger.warn('export.upload.sas_skip', {
        reason: 'no shared key in conn string; returning unsigned URL',
      });
      return { url: blockBlob.url, expiresAt };
    }
    const sas = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: expiresAt,
        protocol: undefined,
      },
      credential,
    ).toString();
    return { url: `${blockBlob.url}?${sas}`, expiresAt };
  }
}

// Pull AccountName + AccountKey out of a connection string. Returns null when
// the conn string uses a non-key auth method (e.g., SAS token already, or
// managed identity).
function extractSharedKeyCredential(connStr: string): StorageSharedKeyCredential | null {
  const parts = new Map<string, string>();
  for (const p of connStr.split(';')) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    parts.set(p.slice(0, eq), p.slice(eq + 1));
  }
  const name = parts.get('AccountName');
  const key = parts.get('AccountKey');
  if (!name || !key) return null;
  try {
    return new StorageSharedKeyCredential(name, key);
  } catch {
    return null;
  }
}
