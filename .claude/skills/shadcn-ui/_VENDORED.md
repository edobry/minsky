# Vendored from https://github.com/shadcn-ui/ui

- **Source:** https://github.com/shadcn-ui/ui/blob/15ac1be92b889480010802151324924005918047/skills/shadcn/SKILL.md
- **Commit SHA:** 15ac1be92b889480010802151324924005918047
- **File SHA:** 016f824d17974e5715a0e9a6e96af2001ee25e7c
- **Vendored:** 2026-05-12
- **Task:** mt#1777
- **Bundle:** mt#1768 (Cockpit design + engineering bundle)

This skill is vendored from the upstream repo with two local modifications. To update,
refetch from the source URL and replace SKILL.md, then re-apply both strips below.

## Modification 1 (mt#1777): frontmatter `allowed-tools` strip

Stripped the following frontmatter line:

```
allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)
```

Vendored as documentation-only per mt#1777 R1 review
(https://github.com/edobry/minsky/pull/1077#pullrequestreview-4275477162). If executable
capability is needed, add tools explicitly at the agent level
(`.minsky/agents/cockpit-dev/agent.ts`).

## Modification 2 (mt#1803): auto-executing context block strip

Removed the "Current Project Context" section, which contained the following
auto-executing pattern at the top of the file:

````
## Current Project Context

```json
!`npx shadcn@latest info --json`
````

```

The leading `!` is Claude Code's skill-markdown context-injection syntax that runs the
backticked command at skill-load time. The auto-mode classifier denies this preemptively
as untrusted external code execution — that denial blocks dispatch of any agent that
preloads this skill (notably `cockpit-dev`).

Replacement: a "Getting Project Context" section that documents the same command as
guidance to invoke at task-time. The auto-loaded JSON dump has low information value when
vendored anyway (it runs once at skill load, not at the moment the user asks
shadcn-related questions).
```
