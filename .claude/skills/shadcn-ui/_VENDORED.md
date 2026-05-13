# Vendored from https://github.com/shadcn-ui/ui

- **Source:** https://github.com/shadcn-ui/ui/blob/15ac1be92b889480010802151324924005918047/skills/shadcn/SKILL.md
- **Commit SHA:** 15ac1be92b889480010802151324924005918047
- **File SHA:** 016f824d17974e5715a0e9a6e96af2001ee25e7c
- **Vendored:** 2026-05-12
- **Task:** mt#1777
- **Bundle:** mt#1768 (Cockpit design + engineering bundle)

This skill is vendored from the upstream repo with two local modifications. To update,
refetch from the source URL and replace SKILL.md, then re-apply both strips below.

**Modification 1 (mt#1777):** Stripped `allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)` from
frontmatter — vendored as documentation-only per mt#1777 R1 review
(https://github.com/edobry/minsky/pull/1077#pullrequestreview-4275477162).
If executable capability is needed, add tools explicitly at the agent level
(`.minsky/agents/cockpit-dev/agent.ts`).

**Modification 2 (mt#1803):** Removed the auto-executing `!`npx shadcn@latest info --json``context block from the "Current Project Context" section. The leading`!`in Claude Code
skill markdown auto-executes the backticked command at skill-load time, which the auto-mode
classifier denies as untrusted external code execution — this denial blocks dispatch of any
agent that preloads this skill (notably`cockpit-dev`). The information value of the
auto-loaded JSON dump is low when vendored (it runs once at skill load, not at the moment
the user asks shadcn-related questions), so removal is the right scope. The "Getting Project
Context" section now documents the command as guidance to invoke at task-time, not at
skill-load time.
