# CI workflows

Relocated from the top-level README (mt#3828) — reference for the repository's GitHub Actions gates.

| Workflow             | Trigger              | Purpose                                                                                                                                                                                  |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-boot-smoke`  | every PR / main push | Builds the bundle and asserts `GET /health` returns 200                                                                                                                                  |
| `cold-start-migrate` | every PR / main push | Builds the bundle, runs `minsky persistence migrate --execute` from a temp dir outside the repo, then asserts the `tasks` table was created and `--dry-run` reports 0 pending migrations |

The `cold-start-migrate` workflow is the regression gate for the bundle-aware migration
resolver (see [persistence-configuration.md](./persistence-configuration.md) §Schema
migrations). It proves that the production binary can find and apply its bundled
migrations from an arbitrary working directory.

Related: the merge gate additionally requires the bundle-boot smoke check to have
concluded successfully — see CLAUDE.md §Build & Test for the local reproduction recipe.
