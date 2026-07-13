# Vendored from https://github.com/garrytan/gstack

- **Source:** https://github.com/garrytan/gstack/blob/dc6252d1df7f1f650ea6e9b2bba7d08fab5de902/plan-design-review/SKILL.md.tmpl
- **Commit SHA:** dc6252d1df7f1f650ea6e9b2bba7d08fab5de902
- **File SHA (template):** 24e89a01ec3d9bb4e970f1f571b6d949147ffcdc
- **Vendored:** 2026-05-12
- **Task:** mt#1777
- **Bundle:** mt#1768 (Cockpit design + engineering bundle)

Note: The canonical SKILL.md in this repo (SHA: 699bacf69cfa9de47fa13096077251a004ee02bc) is
101KB and exceeds inline fetch limits. This vendored copy is derived from the SKILL.md.tmpl
template (28KB), which is the authoring source. Template placeholders ({{PREAMBLE}},
{{BASE_BRANCH_DETECT}}, etc.) referencing gstack-specific infrastructure have been removed
as they depend on the gstack toolchain. The core design review methodology is preserved intact.

To update: fetch SKILL.md.tmpl from the source URL above and regenerate.

**Modification from upstream:** Stripped `allowed-tools` from frontmatter — vendored as
documentation-only per mt#1777 R1 review (https://github.com/edobry/minsky/pull/1077#pullrequestreview-4275477162).
If executable capability is needed, add tools explicitly at the agent level
(`.minsky/agents/cockpit-dev/agent.ts`).
