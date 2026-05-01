/**
 * LocalConfigCredentialStore — writes credentials to ~/.config/minsky/<name>.{pem,json}.
 *
 * Layout (mirrors what scripts/create-github-app.ts writes today):
 *   <outputDir>/<name>.pem   — RSA private key (0600)
 *   <outputDir>/<name>.json  — metadata (appId, slug, clientId, installationId, ...)
 *
 * @see mt#1087
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import type { CredentialStore } from "./credential-store";
import type { AppCredentials } from "./types";

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

  constructor(outputDir?: string) {
    this.outputDir = outputDir ?? join(process.env.HOME ?? "~", ".config", "minsky");
  }

  private pemPath(name: string): string {
    return join(this.outputDir, `${name}.pem`);
  }

  private metaPath(name: string): string {
    return join(this.outputDir, `${name}.json`);
  }

  async exists(name: string): Promise<boolean> {
    return existsSync(this.pemPath(name)) && existsSync(this.metaPath(name));
  }

  async read(name: string): Promise<AppCredentials | null> {
    const pem = this.pemPath(name);
    const meta = this.metaPath(name);
    if (!existsSync(pem) || !existsSync(meta)) {
      return null;
    }
    try {
      const pemContent = await Bun.file(pem).text();
      const raw = (await Bun.file(meta).json()) as StoredMeta;
      return {
        appId: raw.appId,
        slug: raw.slug,
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        pem: pemContent,
        htmlUrl: raw.htmlUrl,
        installationId: raw.installationId,
      };
    } catch {
      return null;
    }
  }

  async write(name: string, creds: AppCredentials): Promise<void> {
    mkdirSync(this.outputDir, { recursive: true });

    const pemFile = this.pemPath(name);
    writeFileSync(pemFile, creds.pem);
    chmodSync(pemFile, 0o600);

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
    writeFileSync(this.metaPath(name), JSON.stringify(meta, null, 2));
  }
}
