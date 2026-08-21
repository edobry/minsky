/**
 * Tool effect classification — does invoking this tool change state? (mt#3847)
 *
 * ## Why this is not `SharedCommand.mutating`
 *
 * `mutating?: boolean` looks like this classification and is not one. Its own
 * docblock scopes it to "external side effects that must not run when the MCP
 * server is stale", 13 of 225 commands set it, and **none set it false** — so
 * absence carries no information. A consumer reading it as a read/write answer
 * gets a confident wrong verdict for ~212 commands, which is exactly what
 * mt#3845 nearly shipped. That field stays where it is, feeding the drift gate
 * alone; whether the gate's refusal set should widen is mt#3924's question.
 *
 * ## Three states, deliberately
 *
 * A boolean is what produced the defect being fixed. {@link ToolEffect} keeps
 * "we do not know" distinct from "it reads", and nothing here converts
 * `unclassified` into a positive claim in either direction. A consumer that
 * cannot tell should render conservatively, not guess.
 *
 * ## Why a table here rather than a field on each command
 *
 * The classification has to be readable from the cockpit web bundle, and the
 * command registry is server-side — `custom/no-node-import-in-cockpit-web` bans
 * `@minsky/domain` value imports from the browser. `packages/shared` is where
 * that constraint already puts cross-boundary facts (`harness-markup.ts` is
 * here for the same reason). The cost is that a new command can be registered
 * without an entry; `tool-effect.registry-coverage.test.ts` is what makes that
 * fail rather than pass silently.
 *
 * ## How each verdict was reached
 *
 * From the registration's own `description` and the domain calls its handler
 * awaits — never from the spelling of the id. `mt#3845`'s spec requires exactly
 * that ("positively evidenced from the tool registry, not inferred from the
 * tool name's spelling"), and a verb heuristic is what it rules out: `git.log`
 * and `git.reset` share a shape and nothing else. Where the evidence did not
 * settle it, the entry is absent and the tool reports `unclassified`.
 *
 * **Incidental telemetry does not make a reader a writer.** Several read paths
 * call `emitSystemEventBestEffort` on their way out. That writes an event row,
 * but the tool's PURPOSE is the read, and classifying by side effect would make
 * nearly everything a mutator and the distinction useless. The question this
 * module answers is whether invoking the tool changes state the CALLER asked to
 * change.
 *
 * @see mt#3847 — this module; mt#3924 — the drift-gate refusal-set decision
 * @see mt#3845 — the first consumer (read-vs-write weighting in the transcript view)
 */

/**
 * What invoking a tool does to state.
 *
 * `unclassified` covers two distinct cases on purpose — a tool nobody has
 * classified yet, and one whose effect genuinely depends on its arguments
 * ({@link AMBIGUOUS_TOOL_REASONS}). Both mean "do not claim either way".
 */
export type ToolEffect = "mutates" | "reads" | "unclassified";

/**
 * Tools whose effect is not a property of the tool at all — it is whatever the
 * caller passed. Forcing these to a boolean would be a lie in one direction or
 * the other, so they are classified `unclassified` WITH a reason a consumer can
 * surface.
 */
export const AMBIGUOUS_TOOL_REASONS: Readonly<Record<string, string>> = {
  "session.exec": "runs an arbitrary shell command in the session workspace",
  Bash: "runs an arbitrary shell command",
  Agent: "dispatches a subagent, which may do anything the parent could",
  Task: "dispatches a subagent, which may do anything the parent could",
};

/**
 * Harness-native tools. These are never `SharedCommand`s — no registry field
 * could reach them — which is half of why this table exists outside the
 * registry at all.
 */
export const NATIVE_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  Write: "mutates",
  Edit: "mutates",
  MultiEdit: "mutates",
  NotebookEdit: "mutates",
  TodoWrite: "mutates",
  Read: "reads",
  Glob: "reads",
  Grep: "reads",
  WebFetch: "reads",
  WebSearch: "reads",
  ToolSearch: "reads",
  // Bash / Agent / Task are deliberately absent — see AMBIGUOUS_TOOL_REASONS.
};

/**
 * Minsky MCP commands, keyed by canonical dotted id (the form
 * `debug.listMethods` returns). Underscored and `mcp__minsky__`-prefixed
 * spellings are normalized by {@link classifyTool}.
 *
 * Absent ids are `unclassified` by construction. That set is measured, not
 * assumed — see the registry-coverage test.
 */
export const MCP_COMMAND_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  // --- ai ---------------------------------------------------------------
  "ai.cache.clear": "mutates", // clearProviderCache / clearAllCache
  "ai.models.refresh": "mutates", // refreshes the cached model set
  "ai.fast-apply": "mutates", // applies edits to a file
  "ai.chat": "reads",
  "ai.complete": "reads",
  "ai.models.available": "reads",
  "ai.models.list": "reads",
  "ai.providers.list": "reads",
  "ai.validate": "reads",

  // --- asks -------------------------------------------------------------
  "asks.cancel": "mutates", // terminal transition + provenance write (mt#3353)
  "asks.create": "mutates",
  "asks.edit": "mutates",
  "asks.respond": "mutates",
  "asks.reconcile": "mutates", // writes verdicts + fires wake sinks
  "asks.get": "reads",
  "asks.list": "reads",
  "asks.wait-for-response": "reads",

  // --- attention / authorship / provenance --------------------------------
  "attention.report": "reads",
  "authorship.get": "reads",
  "authorship.recompute": "mutates", // provenanceService.recomputeAll
  "provenance.get": "reads",

  // --- changesets ---------------------------------------------------------
  "changeset.get": "reads",
  "changeset.info": "reads",
  "changeset.list": "reads",
  "changeset.search": "reads",

  // --- compile / config ---------------------------------------------------
  compile: "mutates", // writes harness-specific output files
  "config.credentials.add": "mutates",
  "config.credentials.remove": "mutates",
  "config.credentials.recheck": "mutates", // records 401 invalidations
  "config.doctor": "mutates", // fixMcpAuthTokenFromSecretsFile repairs config
  "config.set": "mutates", // writer.setConfigValue
  "config.unset": "mutates", // writer.unsetConfigValue
  "config.credentials.list": "reads",
  "config.get": "reads",
  "config.list": "reads",
  "config.show": "reads",
  "config.validate": "reads",

  // --- debug / deployment -------------------------------------------------
  "debug.echo": "reads",
  "debug.listMethods": "reads",
  "debug.systemInfo": "reads",
  "deployment.logs": "reads",
  "deployment.status": "reads",
  "deployment.wait-for-latest": "reads",

  // --- events / epics -----------------------------------------------------
  "events.emit": "mutates", // emitter.emit writes a system event
  "events.list": "reads",
  "epic-decomposition.audit": "reads",

  // --- forge --------------------------------------------------------------
  "forge.branch_protection_set": "mutates",
  "forge.ci_run_rerun": "mutates",
  "forge.label_create": "mutates",
  "forge.label_delete": "mutates",
  "forge.label_update": "mutates",
  "forge.branch_protection_get": "reads",
  "forge.check_runs_list": "reads",
  "forge.ci_run_list": "reads",
  "forge.ci_run_view_log": "reads",
  "forge.label_list": "reads",

  // --- git ----------------------------------------------------------------
  "git.branch": "mutates",
  "git.checkout": "mutates",
  "git.clone": "mutates",
  "git.commit": "mutates",
  "git.merge": "mutates",
  "git.pull": "mutates",
  "git.push": "mutates",
  "git.rebase": "mutates",
  "git.repair_lock": "mutates",
  "git.repair_refs": "mutates",
  "git.reset": "mutates",
  "git.restore": "mutates",
  "git.stash": "mutates",
  "git.stash_drop": "mutates",
  "git.stash_pop": "mutates",
  "git.blame": "reads",
  "git.conflicts": "reads",
  "git.diff": "reads",
  "git.log": "reads",
  "git.search": "reads",
  "git.stash_list": "reads",
  "git.stats": "reads",
  "git.status": "reads",
  "guard-events.ingest": "mutates", // batch-inserts into guard_events (mt#4035)

  // --- init / knowledge / mcp ---------------------------------------------
  init: "mutates",
  "knowledge.sync": "mutates", // writes the vector index
  "knowledge.fetch": "reads",
  "knowledge.search": "reads",
  "knowledge.sources": "reads",
  "mcp.register": "mutates", // writes client configuration

  // --- memory --------------------------------------------------------------
  "memory.create": "mutates",
  "memory.delete": "mutates",
  "memory.patch": "mutates",
  "memory.supersede": "mutates",
  "memory.update": "mutates",
  "memory.get": "reads",
  "memory.lineage": "reads",
  "memory.list": "reads",
  "memory.search": "reads",
  "memory.similar": "reads",

  // --- observability / persistence -----------------------------------------
  "observability.calibration-review": "mutates", // advances + persists watermarks
  "observability.smoke-test": "mutates", // sends a live event to Braintrust
  "persistence.migrate": "mutates",
  "persistence.check": "reads",

  // --- pr watches / principal ----------------------------------------------
  "pr.watch.create": "mutates",
  "pr.watch.cancel": "mutates",
  "pr.watch.run": "mutates", // fires notifications and updates watch state
  "pr.watch.list": "reads",
  "principal.notify": "mutates", // sends the principal a message

  // --- refs / repo ----------------------------------------------------------
  "refs.status": "reads",
  "repo.list_directory": "reads",
  "repo.read_file": "reads",
  "repo.search": "reads",

  // --- reviewer -------------------------------------------------------------
  "reviewer.retrigger": "mutates", // triggers a fresh review run
  "reviewer.watch.run": "mutates", // fires operator notifications
  "reviewer.watch.start": "mutates",

  // --- rules ----------------------------------------------------------------
  "rules.compile": "mutates",
  "rules.create": "mutates",
  "rules.disable": "mutates",
  "rules.enable": "mutates",
  "rules.generate": "mutates",
  "rules.index-embeddings": "mutates",
  "rules.migrate": "mutates",
  "rules.update": "mutates",
  "rules.config": "reads",
  "rules.get": "reads",
  "rules.list": "reads",
  "rules.presets": "reads",
  "rules.search": "reads",

  // --- security -------------------------------------------------------------
  "security.check-credentials": "reads", // scans text for credential shapes; never mutates state

  // --- session --------------------------------------------------------------
  "session.apply_post_merge_state_sync": "mutates",
  "session.cleanup": "mutates",
  "session.commit": "mutates",
  "session.delete": "mutates",
  "session.edit-file": "mutates",
  "session.migrate": "mutates",
  "session.migrate-backend": "mutates",
  "session.repair": "mutates",
  "session.start": "mutates",
  "session.update": "mutates",
  "session.attached": "reads",
  "session.conflicts": "reads",
  "session.dir": "reads",
  "session.generate_prompt": "reads",
  "session.get": "reads",
  "session.inspect": "reads",
  "session.list": "reads",
  "session.ps": "reads",
  "session.review": "reads",
  "session.search": "reads",

  // --- session PR -----------------------------------------------------------
  "session.pr.approve": "mutates",
  "session.pr.check_run.submit": "mutates",
  "session.pr.close": "mutates",
  "session.pr.create": "mutates",
  "session.pr.drive": "mutates",
  "session.pr.edit": "mutates",
  "session.pr.merge": "mutates",
  "session.pr.review.dismiss": "mutates",
  "session.pr.review.submit": "mutates",
  "session.pr.review.thread.resolve": "mutates",
  "session.pr.checks": "reads",
  "session.pr.get": "reads",
  "session.pr.list": "reads",
  "session.pr.open": "reads",
  "session.pr.review_context": "reads",
  "session.pr.wait-for-review": "reads",

  // --- setup ----------------------------------------------------------------
  setup: "mutates",
  "setup.db": "mutates",
  "setup.github-app": "mutates",
  "setup.local-http": "mutates",

  // --- tasks ----------------------------------------------------------------
  "tasks.bulk-edit": "mutates",
  "tasks.create": "mutates",
  "tasks.delete": "mutates",
  "tasks.deps.add": "mutates",
  "tasks.deps.rm": "mutates",
  "tasks.dispatch": "mutates",
  "tasks.edit": "mutates",
  "tasks.embeddings-repair": "mutates",
  "tasks.index-embeddings": "mutates",
  "tasks.migrate-backend": "mutates",
  "tasks.reparent": "mutates",
  "tasks.spec.patch": "mutates",
  "tasks.spec.search_replace": "mutates",
  "tasks.status.set": "mutates",
  "tasks.available": "reads",
  "tasks.children": "reads",
  "tasks.claims.list": "reads",
  "tasks.deps.graph": "reads",
  "tasks.deps.list": "reads",
  "tasks.deps.tree": "reads",
  "tasks.embeddings-status": "reads",
  "tasks.get": "reads",
  "tasks.list": "reads",
  "tasks.orchestrate": "reads",
  "tasks.parent": "reads",
  "tasks.route": "reads",
  "tasks.search": "reads",
  "tasks.similar": "reads",
  "tasks.spec.freshness": "reads",
  "tasks.spec.get": "reads",
  "tasks.status.get": "reads",

  // --- session workspace files (registered on the MCP surface, not the shared
  //     registry — `debug.listMethods` does not report these) ------------------
  "session.write_file": "mutates",
  "session.delete_file": "mutates",
  "session.create_directory": "mutates",
  "session.edit_file": "mutates",
  "session.search_replace": "mutates",
  "session.move_file": "mutates",
  "session.rename_file": "mutates",
  "session.read_file": "reads",
  "session.list_directory": "reads",
  "session.file_exists": "reads",
  "session.grep_search": "reads",
  "session.diff": "reads",
  "session.status": "reads",

  // --- tools / principal corpus ---------------------------------------------
  "tools.index-embeddings": "mutates",
  "tools.search": "reads",
  "tools.similar": "reads",
  "principal_corpus.index-embeddings": "mutates",
  "principal_corpus.search": "reads",
  "principal_corpus.similar": "reads",

  // --- transcripts ------------------------------------------------------------
  "transcripts.index-embeddings": "mutates",
  "transcripts.ingest": "mutates",
  "transcripts.spawns-extract": "mutates",
  "transcripts.get": "reads",
  "transcripts.list": "reads",
  "transcripts.search": "reads",
  "transcripts.search-text": "reads",
  "transcripts.similar": "reads",

  // --- unasked direction / validate / windows / workspace ---------------------
  "unasked-direction.mark-false-positive": "mutates",
  "unasked-direction.mark-real": "mutates",
  "unasked-direction.list": "reads",
  "validate.lint": "reads",
  "validate.typecheck": "reads",
  "window.close": "mutates",
  "window.open": "mutates",
  "window.service": "mutates", // renders a digest AND advances window state
  "window.list": "reads",
  "window.status": "reads",
  "workspace.info": "reads",
};

/**
 * Ids deliberately left out of {@link MCP_COMMAND_EFFECTS} because the evidence
 * available at classification time did not settle them. Listed rather than
 * silently absent so the coverage test can tell "known gap" from "someone added
 * a command and forgot" — the distinction mt#3789's unpopulated registry field
 * had no way to make.
 */
export const KNOWN_UNCLASSIFIED: readonly string[] = [
  "tasks.analyze", // description alone does not say whether it writes analysis back
  "tasks.decompose", // may create subtasks; handler indirection hid the call
  "tasks.estimate", // same shape as analyze
  "tasks.dispatch-recover", // "detect/classify/prepare" — the prepare half is unclear
  "provenance.recompute", // deprecated shim; delegates somewhere unread
  "session.focus", // description is a shared constant; effect on window state unread
  "session.goto", // alias of session.focus
  "session.bindings.refresh", // description is a shared constant
  "session.exec", // ambiguous by nature — see AMBIGUOUS_TOOL_REASONS
];

const KNOWN_UNCLASSIFIED_SET: ReadonlySet<string> = new Set(KNOWN_UNCLASSIFIED);

/** The `mcp__minsky__` prefix the harness puts on Minsky's MCP tools. */
const MCP_TOOL_PREFIX = "mcp__minsky__";

/**
 * Reduce any spelling a caller might hold to the canonical dotted id.
 *
 * Three forms reach consumers: the canonical `tasks.spec.patch`, the
 * Claude-Desktop underscore alias `tasks_spec_patch` (`src/mcp/tool-name.ts`
 * replaces dots with underscores), and the harness-prefixed
 * `mcp__minsky__tasks_spec_patch` that appears in transcripts.
 *
 * Underscores inside a single segment (`session.pr.check_run.submit`,
 * `git.stash_drop`, `deployment.wait-for-latest`) make the reverse mapping
 * lossy, so an underscored name is resolved by lookup against the known ids
 * rather than by substituting dots back in.
 */
export function canonicalToolId(name: string): string {
  const withoutPrefix = name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;
  if (withoutPrefix.includes(".")) return withoutPrefix;

  for (const candidate of Object.keys(MCP_COMMAND_EFFECTS)) {
    if (candidate.replace(/\./g, "_") === withoutPrefix) return candidate;
  }
  for (const candidate of KNOWN_UNCLASSIFIED) {
    if (candidate.replace(/\./g, "_") === withoutPrefix) return candidate;
  }
  return withoutPrefix;
}

/**
 * Classify a tool by any of its spellings. An unknown name is `unclassified` —
 * never coerced to a positive verdict in either direction (SC6).
 */
export function classifyTool(name: string): ToolEffect {
  const native = NATIVE_TOOL_EFFECTS[name];
  if (native !== undefined) return native;

  const id = canonicalToolId(name);
  return MCP_COMMAND_EFFECTS[id] ?? "unclassified";
}

/**
 * Why a tool is `unclassified`, when there is a stated reason. Returns
 * `undefined` for a tool that is classified, or for one nobody has looked at —
 * "no reason recorded" and "reads" are different answers and must not collapse.
 */
export function ambiguityReason(name: string): string | undefined {
  const direct = AMBIGUOUS_TOOL_REASONS[name];
  if (direct !== undefined) return direct;
  return AMBIGUOUS_TOOL_REASONS[canonicalToolId(name)];
}

/** True when the id is a recorded gap rather than an unrecognized tool. */
export function isKnownUnclassified(name: string): boolean {
  return KNOWN_UNCLASSIFIED_SET.has(canonicalToolId(name));
}
