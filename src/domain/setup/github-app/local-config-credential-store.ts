/**
 * LocalConfigCredentialStore — writes credentials to ~/.config/minsky/<name>.{pem,json}.
 *
 * Layout (mirrors what scripts/create-github-app.ts writes today):
 *   <outputDir>/<name>.pem   — RSA private key (0600)
 *   <outputDir>/<name>.json  — metadata (appId, slug, clientId, installationId, ...)
 *
 * @see mt#1087
 */

import { join } from "path";
import type { SyncFsLike } from "../../interfaces/fs-like";
import { createRealSyncFs } from "../../interfaces/fs-like";
import type { CredentialStore } from "./credential-store";
import type { AppCredentials } from "./types";

/**
 * Filesystem subset used by LocalConfigCredentialStore.
 * Extends SyncFsLike with chmodSync (not part of the shared interface because
 * very few modules need it).
 */
export interface CredentialFs extends SyncFsLike {
  chmodSync(path: string, mode: number): void;
}

/** Build a real-fs-backed CredentialFs by extending createRealSyncFs with chmod. */
export function createRealCredentialFs(): CredentialFs {
  const fs = require("fs");
  const base = createRealSyncFs();
  return {
    ...base,
    chmodSync: fs.chmodSync,
  };
}

/** Serialised shape stored in <name>.json */
interface StoredMeta {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  privateKeyFile: string;
  installationId?: number;
  createdAt: string;
}

export class LocalConfigCredentialStore implements CredentialStore {
  private readonly outputDir: string;
  private readonly fs: CredentialFs;

  constructor(outputDir?: string, fs: CredentialFs = createRealCredentialFs()) {
    this.outputDir = outputDir ?? join(process.env.HOME ?? "~", ".config", "minsky");
    this.fs = fs;
  }

  private pemPath(name: string): string {
    return join(this.outputDir, `${name}.pem`);
  }

  private metaPath(name: string): string {
    return join(this.outputDir, `${name}.json`);
  }

  async exists(name: string): Promise<boolean> {
    return this.fs.existsSync(this.pemPath(name)) && this.fs.existsSync(this.metaPath(name));
  }

  async read(name: string): Promise<AppCredentials | null> {
    const pem = this.pemPath(name);
    const meta = this.metaPath(name);
    if (!this.fs.existsSync(pem) || !this.fs.existsSync(meta)) {
      return null;
    }
    try {
      const pemContent = this.fs.readFileSync(pem, "utf-8");
      const rawJson = this.fs.readFileSync(meta, "utf-8");
      const raw = JSON.parse(rawJson as string) as StoredMeta;
      return {
        appId: raw.appId,
        slug: raw.slug,
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        pem: pemContent as string,
        htmlUrl: raw.htmlUrl,
        installationId: raw.installationId,
      };
    } catch {
      return null;
    }
  }

  async write(name: string, creds: AppCredentials): Promise<void> {
    this.fs.mkdirSync(this.outputDir, { recursive: true });

    const pemFile = this.pemPath(name);
    this.fs.writeFileSync(pemFile, creds.pem);
    this.fs.chmodSync(pemFile, 0o600);

    const meta: StoredMeta = {
      appId: creds.appId,
      slug: creds.slug,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      htmlUrl: creds.htmlUrl,
      privateKeyFile: pemFile,
      installationId: creds.installationId,
      createdAt: new Date().toISOString(),
    };
    this.fs.writeFileSync(this.metaPath(name), JSON.stringify(meta, null, 2));
  }
}
