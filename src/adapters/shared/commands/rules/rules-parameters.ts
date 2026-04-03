/**
 * Parameter definitions for rules commands.
 */
import { z } from "zod";
import { type CommandParameterMap } from "../../command-registry";
import {
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  OVERWRITE_DESCRIPTION,
} from "../../../../utils/option-descriptions";
import { CommonParameters, RulesParameters, composeParams } from "../../common-parameters";

export type RulesListParams = {
  format?: "cursor" | "generic";
  tag?: string;
  since?: string;
  until?: string;
  json?: boolean;
  debug?: boolean;
};

export const rulesListCommandParams: CommandParameterMap = composeParams(
  {
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    since: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). " +
        "Currently not enforced due to missing timestamps.",
      required: false,
    },
    until: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). " +
        "Currently not enforced due to missing timestamps.",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

export type RulesIndexEmbeddingsParams = {
  limit?: number;
  json?: boolean;
  debug?: boolean;
  force?: boolean;
};

export const rulesIndexEmbeddingsParams: CommandParameterMap = composeParams(
  {
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of rules to index (for debugging)",
      required: false,
    },
    force: {
      schema: z.boolean(),
      description: "Force reindex even if content hash matches",
      required: false,
      defaultValue: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

export type RulesGetParams = {
  id: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

export const rulesGetCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

export type RulesGenerateParams = {
  interface?: "cli" | "mcp" | "hybrid";
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: string;
  preferMcp?: boolean;
  mcpTransport?: "stdio" | "http";
  json?: boolean;
  debug?: boolean;
};

export const rulesGenerateCommandParams: CommandParameterMap = composeParams(
  {
    interface: {
      schema: z.enum(["cli", "mcp", "hybrid"]),
      description: "Interface preference for generated rules (cli, mcp, or hybrid)",
      required: false,
      defaultValue: "cli",
    },
    rules: {
      schema: z.string().optional(),
      description:
        "Comma-separated list of specific rule templates to generate " +
        "(if not specified, generates all available templates)",
      required: false,
    },
    outputDir: {
      schema: z.string().optional(),
      description:
        "Output directory for generated rules (defaults to .cursor/rules " +
        "for cursor format, .ai/rules for openai format)",
      required: false,
    },
    dryRun: {
      schema: z.boolean(),
      description: "Show what would be generated without actually creating files",
      required: false,
      defaultValue: false,
    },
    overwrite: {
      schema: z.boolean(),
      description: OVERWRITE_DESCRIPTION,
      required: false,
      defaultValue: false,
    },
    format: {
      schema: z.enum(["cursor", "generic", "minsky"]),
      description: "Rule format for file system organization (cursor or generic)",
      required: false,
      defaultValue: "cursor",
    },
    preferMcp: {
      schema: z.boolean(),
      description: "In hybrid mode, prefer MCP commands over CLI commands",
      required: false,
      defaultValue: false,
    },
    mcpTransport: {
      schema: z.enum(["stdio", "http"]),
      description: "MCP transport method (only relevant when interface is mcp or hybrid)",
      required: false,
      defaultValue: "stdio",
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

export type RulesCreateParams = {
  id: string;
  content: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  overwrite?: boolean;
  json?: boolean;
};

export const rulesCreateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    content: RulesParameters.content,
    description: {
      schema: z.string().optional(),
      description: RULE_DESCRIPTION_DESCRIPTION,
      required: false,
    },
    name: {
      schema: z.string().optional(),
      description: RULE_NAME_DESCRIPTION,
      required: false,
    },
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    overwrite: CommonParameters.overwrite,
    json: CommonParameters.json,
  }
);

export type RulesUpdateParams = {
  id: string;
  content?: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

export const rulesUpdateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    content: {
      schema: z.string().optional(),
      description: RULE_CONTENT_DESCRIPTION,
      required: false,
    },
    description: {
      schema: z.string().optional(),
      description: RULE_DESCRIPTION_DESCRIPTION,
      required: false,
    },
    name: {
      schema: z.string().optional(),
      description: RULE_NAME_DESCRIPTION,
      required: false,
    },
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

export const rulesCompileCommandParams: CommandParameterMap = {
  target: {
    schema: z.string(),
    description:
      "Target file type to compile to (e.g., agents.md, claude.md). Defaults to agents.md.",
    required: false,
    defaultValue: "agents.md",
  },
  output: {
    schema: z.string().optional(),
    description: "Output file path (defaults to the target's default output path)",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Print compiled content to output without writing to file",
    required: false,
    defaultValue: false,
  },
  check: {
    schema: z.boolean(),
    description:
      "Check if the output file is up-to-date (staleness detection). Exits non-zero if stale.",
    required: false,
    defaultValue: false,
  },
};

export const rulesMigrateCommandParams: CommandParameterMap = {
  dryRun: {
    schema: z.boolean(),
    description: "Show what would be migrated without doing it",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Overwrite existing files in destination",
    required: false,
    defaultValue: false,
  },
};

export type RulesSearchParams = {
  query?: string;
  tag?: string;
  format?: "cursor" | "generic";
  limit?: number;
  threshold?: number;
  details?: boolean;
  quiet?: boolean;
  json?: boolean;
  debug?: boolean;
};

export const rulesSearchCommandParams: CommandParameterMap = composeParams(
  {
    query: RulesParameters.query,
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    limit: {
      schema: z.number().int().positive().default(10),
      help: "Max number of results",
      required: false,
    },
    threshold: {
      schema: z.number().optional(),
      help: "Optional distance threshold (lower is closer)",
      required: false,
    },
    details: {
      schema: z.boolean().default(false),
      help: "Show detailed output including scores and diagnostics",
      required: false,
    },
    quiet: CommonParameters.quiet,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);
