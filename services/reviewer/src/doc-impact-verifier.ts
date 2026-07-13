import type { ReviewToolCall, SubmitDocumentationImpactArgs } from "./output-tools";

const NOISE_PATH_SEGMENTS = new Set([
  "src",
  "lib",
  "dist",
  "build",
  "test",
  "tests",
  "spec",
  "node_modules",
  "index",
  "utils",
  "helpers",
  "types",
  "interfaces",
  "constants",
  "config",
  "web",
  "app",
  "pages",
  "components",
  "readme",
  "docs",
  "guide",
  "shared",
  "common",
  "models",
  "services",
  "packages",
  "scripts",
  "hooks",
  "domain",
  "adapters",
  "infrastructure",
]);

const NOISE_DIFF_TOKENS = new Set([
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "interface",
  "type",
  "extends",
  "implements",
  "new",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "default",
  "switch",
  "case",
  "break",
  "continue",
  "void",
  "typeof",
  "instanceof",
  "string",
  "number",
  "boolean",
  "object",
  "any",
  "unknown",
  "never",
]);

export function extractSurfaceTerms(filesChanged: string[], diff: string): string[] {
  const terms = new Set<string>();

  for (const filePath of filesChanged) {
    const segments = filePath.split("/");
    for (const seg of segments) {
      const name = seg.replace(/\.[^.]+$/, "");
      if (name.length >= 3 && !NOISE_PATH_SEGMENTS.has(name.toLowerCase())) {
        terms.add(name.toLowerCase());
      }
    }
  }

  const diffLines = diff.split("\n");
  for (const line of diffLines) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const identifiers = line.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g);
    if (!identifiers) continue;
    for (const id of identifiers) {
      if (!NOISE_DIFF_TOKENS.has(id.toLowerCase()) && id.length >= 4) {
        terms.add(id.toLowerCase());
      }
    }
  }

  const routeMatches = diff.matchAll(/["'`](\/[A-Za-z0-9:_\-[\]/]+)/g);
  for (const m of routeMatches) {
    const route = m[1];
    if (route) terms.add(route.toLowerCase());
  }

  return [...terms];
}

export interface DocVerificationResult {
  verified: string[];
  removed: string[];
}

export function verifyAffectedDocs(
  affectedDocs: string[],
  surfaceTerms: string[],
  docContents: Map<string, string>
): DocVerificationResult {
  const verified: string[] = [];
  const removed: string[] = [];

  for (const docPath of affectedDocs) {
    const content = docContents.get(docPath);
    if (content === undefined) {
      removed.push(docPath);
      continue;
    }

    const lowerContent = content.toLowerCase();
    const hasMatch = surfaceTerms.some((term) => lowerContent.includes(term));

    if (hasMatch) {
      verified.push(docPath);
    } else {
      removed.push(docPath);
    }
  }

  return { verified, removed };
}

export interface DocImpactVerificationResult {
  toolCalls: ReadonlyArray<ReviewToolCall>;
  verificationsApplied: boolean;
  removedDocs: string[];
}

const DOC_FINDING_MARKERS = [
  "documentation",
  "doc impact",
  "docs need",
  "needs updating",
  "needs update",
];

function isDocRelatedFinding(tc: ReviewToolCall, removedDocs: string[]): boolean {
  if (tc.name !== "submit_finding") return false;
  if (tc.args.severity !== "BLOCKING") return false;
  const text = `${tc.args.summary} ${tc.args.details}`.toLowerCase();
  if (DOC_FINDING_MARKERS.some((marker) => text.includes(marker))) return true;
  if (removedDocs.some((doc) => text.includes(doc.toLowerCase()))) return true;
  return false;
}

export function applyDocImpactVerification(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  surfaceTerms: string[],
  docContents: Map<string, string>
): DocImpactVerificationResult {
  const allRemovedDocs: string[] = [];
  let anyChanged = false;
  let fullDowngrade = false;

  const updatedCalls = toolCalls.map((tc): ReviewToolCall => {
    if (tc.name !== "submit_documentation_impact") return tc;
    if (tc.args.kind !== "blocking-needs-update") return tc;
    if (!tc.args.affectedDocs || tc.args.affectedDocs.length === 0) return tc;

    const { verified, removed } = verifyAffectedDocs(
      tc.args.affectedDocs,
      surfaceTerms,
      docContents
    );
    allRemovedDocs.push(...removed);

    if (removed.length === 0) return tc;
    anyChanged = true;

    if (verified.length === 0) {
      fullDowngrade = true;
      return {
        name: "submit_documentation_impact" as const,
        args: {
          kind: "no-update-needed" as const,
          evidence: `${tc.args.evidence} [Verification: none of the listed docs reference the changed surfaces; downgraded from blocking-needs-update.]`,
        } satisfies SubmitDocumentationImpactArgs,
      };
    }

    return {
      name: "submit_documentation_impact" as const,
      args: {
        kind: "blocking-needs-update" as const,
        evidence: tc.args.evidence,
        affectedDocs: verified,
      } satisfies SubmitDocumentationImpactArgs,
    };
  });

  const reconciledCalls = fullDowngrade
    ? updatedCalls.map((tc): ReviewToolCall => {
        if (!isDocRelatedFinding(tc, allRemovedDocs)) return tc;
        if (tc.name !== "submit_finding") return tc;
        return {
          name: "submit_finding" as const,
          args: { ...tc.args, severity: "NON-BLOCKING" as const },
        };
      })
    : updatedCalls;

  const remainingBlockingCount = reconciledCalls.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  const finalCalls =
    anyChanged && remainingBlockingCount === 0
      ? reconciledCalls.map((tc): ReviewToolCall => {
          if (tc.name !== "conclude_review") return tc;
          if (tc.args.event !== "REQUEST_CHANGES") return tc;
          return {
            name: "conclude_review" as const,
            args: { ...tc.args, event: "COMMENT" as const },
          };
        })
      : reconciledCalls;

  return {
    toolCalls: finalCalls,
    verificationsApplied: anyChanged,
    removedDocs: allRemovedDocs,
  };
}

export type DocFetcher = (docPath: string) => Promise<string | null>;

export async function fetchAndVerifyDocImpact(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  filesChanged: string[],
  diff: string,
  docFetcher: DocFetcher
): Promise<DocImpactVerificationResult> {
  const hasBlockingDocImpact = toolCalls.some(
    (tc) =>
      tc.name === "submit_documentation_impact" &&
      tc.args.kind === "blocking-needs-update" &&
      tc.args.affectedDocs &&
      tc.args.affectedDocs.length > 0
  );

  if (!hasBlockingDocImpact) {
    return { toolCalls, verificationsApplied: false, removedDocs: [] };
  }

  const allDocPaths = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name === "submit_documentation_impact" && tc.args.affectedDocs) {
      for (const p of tc.args.affectedDocs) allDocPaths.add(p);
    }
  }

  const docContents = new Map<string, string>();
  for (const docPath of allDocPaths) {
    try {
      const content = await docFetcher(docPath);
      if (content !== null) docContents.set(docPath, content);
    } catch {
      // Doc not readable — treated as removed by the verifier
    }
  }

  const surfaceTerms = extractSurfaceTerms(filesChanged, diff);
  return applyDocImpactVerification(toolCalls, surfaceTerms, docContents);
}
