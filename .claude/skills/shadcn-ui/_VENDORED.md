# Vendored from https://github.com/shadcn-ui/ui

- **Source:** https://github.com/shadcn-ui/ui/blob/15ac1be92b889480010802151324924005918047/skills/shadcn/SKILL.md
- **Commit SHA:** 15ac1be92b889480010802151324924005918047
- **File SHA:** 016f824d17974e5715a0e9a6e96af2001ee25e7c
- **Vendored:** 2026-05-12
- **Task:** mt#1777
- **Bundle:** mt#1768 (Cockpit design + engineering bundle)

This skill is vendored from the upstream repo with one modification: `allowed-tools` has been
stripped from the frontmatter. To update, refetch from the source URL and replace SKILL.md,
then re-apply this strip.

**Modification from upstream:** Stripped `allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)` from
frontmatter — vendored as documentation-only per mt#1777 R1 review
(https://github.com/edobry/minsky/pull/1077#pullrequestreview-4275477162).
If executable capability is needed, add tools explicitly at the agent level
(`.minsky/agents/cockpit-dev/agent.ts`).
