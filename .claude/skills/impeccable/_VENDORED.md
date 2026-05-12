# Vendored from https://github.com/pbakaus/impeccable

- **Source:** https://github.com/pbakaus/impeccable/blob/e587004ee42883dad40d14cd0f5e1b21ae1933df/.claude/skills/impeccable/SKILL.md
- **Commit SHA:** e587004ee42883dad40d14cd0f5e1b21ae1933df
- **File SHA:** 5e926ac04cda7f439a70aa43e4fe437c4883eac6
- **Vendored:** 2026-05-12
- **Task:** mt#1777
- **Bundle:** mt#1768 (Cockpit design + engineering bundle)

This skill is vendored from the upstream repo with one modification: `allowed-tools` has been
stripped from the frontmatter. To update, refetch from the source URL and replace SKILL.md,
then re-apply this strip.

**Modification from upstream:** Stripped `allowed-tools: Bash(npx impeccable *)` from
frontmatter — vendored as documentation-only per mt#1777 R1 review
(https://github.com/edobry/minsky/pull/1077#pullrequestreview-4275477162).
If executable capability is needed, add tools explicitly at the agent level
(`.minsky/agents/cockpit-dev/agent.ts`).
