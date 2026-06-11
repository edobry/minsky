/**
 * Credential provider registry (mt#1426).
 *
 * Maps provider id (CLI arg / cockpit selector) to the implementation.
 * `KNOWN_PROVIDER_IDS` is the source of truth for valid `<provider>` arguments.
 */
import type { CredentialProvider } from "../types";
import { supabaseProvider } from "./supabase";
import { githubProvider } from "./github";
import { anthropicProvider } from "./anthropic";
import { railwayProvider } from "./railway";
import { googleProvider } from "./google";
import { telegramProvider } from "./telegram";

const REGISTRY: ReadonlyMap<string, CredentialProvider> = new Map([
  [supabaseProvider.id, supabaseProvider],
  [githubProvider.id, githubProvider],
  [anthropicProvider.id, anthropicProvider],
  [railwayProvider.id, railwayProvider],
  [googleProvider.id, googleProvider],
  [telegramProvider.id, telegramProvider],
]);

export const KNOWN_PROVIDER_IDS: readonly string[] = Array.from(REGISTRY.keys());

export function getCredentialProvider(id: string): CredentialProvider | undefined {
  return REGISTRY.get(id);
}

export function listCredentialProviders(): readonly CredentialProvider[] {
  return Array.from(REGISTRY.values());
}
