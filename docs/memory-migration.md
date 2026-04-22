# Memory Migration Playbook

Cutover from always-loaded `MEMORY.md` preamble to on-demand `memory_search`.

## Background

Claude Code natively reads `~/.claude/projects/<hash>/memory/MEMORY.md` and injects it as a
system-reminder preamble every turn (~3.7k tokens). Minsky Phase 1 memory (mt#1012) stores the
same content in the database. This playbook switches the agent from preamble-load to on-demand
retrieval via `memory_search`, reducing baseline token cost and enabling precise context retrieval.

The `memory.loadingMode` config flag controls the transition:

- `"on_demand"` (default after mt#1009): agent uses `memory_search`; preamble directive is emitted
  in compiled CLAUDE.md
- `"legacy"`: preamble still loads from disk; `memory_search` directive is suppressed in compiled
  CLAUDE.md

## Prerequisites

- Minsky Phase 1 memory import completed (see `mcp__minsky__persistence_migrate` docs)
- `mcp__minsky__tasks_search` and `memory_search` tools available

---

## Migration Steps

### Step 1: Dry-run the memory importer

Verify the importer would correctly ingest all memory files without writing anything:

```bash
bun run src/cli.ts memory import --dry-run
```

Confirm: the output lists all expected memory entries with no errors.

### Step 2: Run the memory importer

Import all memory files into the Minsky database:

```bash
bun run src/cli.ts memory import
```

### Step 3: Verify memory list matches expectations

Confirm that all expected memories are present in the database:

```bash
bun run src/cli.ts memory list
```

Cross-check the count and key entries against the source `MEMORY.md` index and linked files.
Every top-level memory file listed in `MEMORY.md` should appear as one or more database entries.

### Step 4: Flip the feature flag to `on_demand`

In your Minsky config (`.minsky/config.yaml` or equivalent):

```yaml
memory:
  loadingMode: on_demand
```

Then recompile rules so the memory-usage directive is emitted in CLAUDE.md:

```bash
bun run minsky rules compile
```

Verify the directive appears in `CLAUDE.md`:

```bash
grep -A2 "memory_search" CLAUDE.md
```

Expected output includes the line:
`Memory is stored in Minsky DB, not files. Use memory_search ...`

### Step 5: Verify agent behavior in a fresh conversation

Open a fresh Claude Code conversation (no prior context window). Ask:

> "What do you know about my preferences?"

Expected: the agent calls `memory_search` with a relevant query and returns results from the
database. The conversation transcript should show a `memory_search` tool call, not a
system-reminder block from `MEMORY.md`.

If the agent instead reads from MEMORY.md preamble (visible as a system-reminder block), check:

1. The config flag is set to `"on_demand"`
2. `bun run minsky rules compile` was run after the flag change
3. The session workspace `CLAUDE.md` was refreshed

### Step 6: Remove source memory files (user action)

Once on-demand retrieval is verified, the source memory files are no longer needed as preamble
input. To prevent Claude Code from loading an empty preamble, you may optionally remove or archive
the files:

```bash
# Archive (recommended — keeps a backup)
mv ~/.claude/projects/<hash>/memory/ ~/.claude/projects/<hash>/memory.bak/

# Or remove entirely
rm -rf ~/.claude/projects/<hash>/memory/
```

> **Caution**: Do not remove files until Step 5 verification succeeds. The files are the source of
> truth until the database import is confirmed complete.

---

## Post-Migration Verification

After completing all steps, verify the end-to-end system:

1. **Database round-trip**: call `memory_search` with a known query and confirm the expected memory
   is returned
2. **memory_create**: create a test memory entry, then search for it to confirm it persists
3. **No preamble bleed**: in a fresh conversation, confirm no system-reminder block from MEMORY.md
   appears (inspect conversation transcript or use Claude's `<system-reminder>` tag visibility)
4. **Skill behavior**: invoke `/orchestrate` — the first tool call should be `memory_search`, not
   a file read

---

## Rollback

To revert to legacy preamble loading:

1. Set `memory.loadingMode: legacy` in config
2. Run `bun run minsky rules compile`
3. Restore the memory files if they were removed (from `memory.bak/`)

The `"legacy"` mode suppresses the `memory-usage` directive in compiled CLAUDE.md, allowing
Claude Code's native MEMORY.md loader to take effect again.
