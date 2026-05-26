/**
 * Config Credentials Commands (mt#1426)
 *
 * Operator-facing surface for managing tokens Minsky persists in
 * `~/.config/minsky/config.yaml`. Three commands:
 *
 *   config.credentials.add <provider>    — interactive add (masked paste, validate, store, test)
 *   config.credentials.list              — list configured providers (no values)
 *   config.credentials.remove <provider> — unset a provider's credential
 *
 * The CLI surface is interactive: when `token` is omitted, the operator is
 * prompted via a masked TTY input. When `token` is passed as a parameter
 * (MCP path), the prompt is skipped — the caller is responsible for
 * handling the secret safely on their side.
 */

import { z } from "zod";
import { CommandCategory, defineCommand } from "../../command-registry";
import { CommonParameters, composeParams } from "../../common-parameters";
import {
  KNOWN_PROVIDER_IDS,
  addCredential,
  getCredentialProvider,
  listCredentials,
  removeCredential,
  recheckCredential,
  recheckAllCredentials,
} from "@minsky/domain/credentials";
import { CredentialEntryAbortedError, promptMaskedLine } from "../../../../utils/masked-prompt";

const sharedParams = {
  json: CommonParameters.json,
} as const;

/** Provider-id schema reused across the three commands. */
const providerSchema = z.string().refine((value) => KNOWN_PROVIDER_IDS.includes(value), {
  message: `Provider must be one of: ${KNOWN_PROVIDER_IDS.join(", ")}`,
});

/**
 * config.credentials.add <provider>
 */
export const configCredentialsAddRegistration = defineCommand({
  id: "config.credentials.add",
  category: CommandCategory.CONFIG,
  name: "credentials.add",
  description:
    "Add a credential (Supabase PAT / GitHub PAT / Anthropic key) via interactive masked-paste flow",
  requiresSetup: false,
  parameters: composeParams(sharedParams, {
    provider: {
      schema: providerSchema,
      description: `Credential provider id (${KNOWN_PROVIDER_IDS.join(" | ")})`,
      required: true as const,
    },
    token: {
      schema: z.string(),
      description:
        "Token value (MCP / scripted path). Omit on CLI to get a masked interactive prompt.",
      required: false as const,
    },
  }),
  execute: async (params, _ctx) => {
    const provider = getCredentialProvider(params.provider);
    if (!provider) {
      return {
        success: false,
        json: params.json || false,
        error: `Unknown provider: ${params.provider}`,
      };
    }

    let token = params.token;
    if (!token) {
      // Interactive entry path — emit acquire guidance to stdout, then mask the paste.
      // Note: writing acquire guidance to stdout is intentional. The TOKEN itself is
      // masked; the URL/scope info is non-sensitive instruction text.
      process.stdout.write(`\nProvider: ${provider.displayName}\n`);
      process.stdout.write(`Generate token at: ${provider.acquireUrl}\n`);
      process.stdout.write(`Scope guidance: ${provider.scopeGuidance}\n\n`);
      try {
        token = await promptMaskedLine({ prompt: "Paste token (hidden): " });
      } catch (error) {
        if (error instanceof CredentialEntryAbortedError) {
          return {
            success: false,
            json: params.json || false,
            error: "Credential entry aborted.",
          };
        }
        return {
          success: false,
          json: params.json || false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (!token || token.trim().length === 0) {
      return {
        success: false,
        json: params.json || false,
        error: "No token provided.",
      };
    }

    const result = await addCredential(params.provider, token);

    if (!result.validate.ok) {
      return {
        success: false,
        json: params.json || false,
        provider: result.provider,
        validate: result.validate,
        error: `Validation failed: ${result.validate.detail}`,
      };
    }

    return {
      success: true,
      json: params.json || false,
      provider: result.provider,
      configFilePath: result.stored?.configFilePath,
      validate: { ok: result.validate.ok, detail: result.validate.detail },
      test: result.test
        ? { ok: result.test.ok, detail: result.test.detail, scopeGap: result.test.scopeGap }
        : undefined,
    };
  },
});

/**
 * config.credentials.list
 */
export const configCredentialsListRegistration = defineCommand({
  id: "config.credentials.list",
  category: CommandCategory.CONFIG,
  name: "credentials.list",
  description: "List configured credentials (values never displayed)",
  requiresSetup: false,
  parameters: composeParams(sharedParams, {}),
  execute: async (params, _ctx) => {
    const credentials = await listCredentials();
    return {
      success: true,
      json: params.json || false,
      credentials,
    };
  },
});

/**
 * config.credentials.remove <provider>
 */
export const configCredentialsRemoveRegistration = defineCommand({
  id: "config.credentials.remove",
  category: CommandCategory.CONFIG,
  name: "credentials.remove",
  description: "Remove a configured credential",
  requiresSetup: false,
  parameters: composeParams(sharedParams, {
    provider: {
      schema: providerSchema,
      description: `Credential provider id (${KNOWN_PROVIDER_IDS.join(" | ")})`,
      required: true as const,
    },
  }),
  execute: async (params, _ctx) => {
    const result = await removeCredential(params.provider);
    return {
      success: true,
      json: params.json || false,
      provider: params.provider,
      removed: result.removed,
    };
  },
});

/**
 * config.credentials.recheck [provider]
 *
 * Re-runs the smoke test on a stored credential. On 401, emits a
 * `credential.invalidated` event (via the sentinel file consumed by
 * CredentialResolver + the cockpit). With no provider, rechecks all
 * configured providers.
 */
export const configCredentialsRecheckRegistration = defineCommand({
  id: "config.credentials.recheck",
  category: CommandCategory.CONFIG,
  name: "credentials.recheck",
  description: "Re-test a stored credential and surface 401 invalidations",
  requiresSetup: false,
  parameters: composeParams(sharedParams, {
    provider: {
      schema: providerSchema.optional(),
      description: `Credential provider id (${KNOWN_PROVIDER_IDS.join(" | ")}). Omit to recheck all configured providers.`,
      required: false as const,
    },
  }),
  execute: async (params, _ctx) => {
    if (params.provider) {
      const result = await recheckCredential(params.provider);
      return {
        success: true,
        json: params.json || false,
        results: [result],
      };
    }
    const results = await recheckAllCredentials();
    return {
      success: true,
      json: params.json || false,
      results,
    };
  },
});
