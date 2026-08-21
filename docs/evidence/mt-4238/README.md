# mt#4238 — read-vs-write weight in the conversation view

Rendered evidence for [mt#4238](minsky://task/mt%234238): a tool call the registry classifies as
`mutates` now carries more weight than one it classifies as `reads`. Before this, mt#4220 made
every healthy tool row recede uniformly, so `WebFetch` and `tasks_spec_patch` were
indistinguishable.

**Aesthetic acceptance is the principal's.** What is asserted here is only that the classification
is correct against live data and that no objective defect (clipping, overlap, contrast loss,
orphaned element) was introduced.

## Capture conditions

|                   |                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation      | `c026457e-1648-4b9a-a177-9a3cdab8df09` — a real 122-turn session, not a fixture                                                             |
| Viewport          | 1440x900, uncropped                                                                                                                         |
| Served from       | `vite` dev server on `:5199` out of the mt#4238 session workspace, `/api` proxied to the running daemon                                     |
| Bundle provenance | the footer in both frames reads **`ui dcf217bb4`** — the commit under test. `svc 889feda99` is the daemon, which this change does not touch |
| Driver            | Chrome Canary via CDP on `:9333`, throwaway profile                                                                                         |
| Captured          | 2026-08-21                                                                                                                                  |

The bundle commit is legible IN THE FRAME rather than asserted alongside it. That is deliberate:
`/api/health`'s `commit` names the DAEMON's provenance and cannot answer for the bundle
(`vite.config.ts` §`resolveBuildCommit`), so a health-body assertion would have been evidence about
the wrong artifact.

## The pair

Both frames are the same conversation at the same scroll anchor (the `session_pr_edit` row), so
they differ only by the change. `before-` was produced by temporarily restoring mt#4220's uniform
values and letting HMR apply them; the renderer was then confirmed byte-identical to commit
`dcf217bb4` (`git diff HEAD` empty) before anything was committed.

| File                            | What it shows                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `before-mixed-run-1440x900.png` | `ToolSearch` (read) and `minsky · session_pr_edit` (write) at identical weight — the defect |
| `after-mixed-run-1440x900.png`  | the same two rows, with the write heavier and the read receded                              |

## Measured over the live DOM, not read off the picture

At the moment of capture, over the 15 tool rows rendered:

| Class     | Count | Distinct tools                                                                            |
| --------- | ----- | ----------------------------------------------------------------------------------------- |
| `mutates` | 3     | `session_pr_edit`, `session_pr_merge`                                                     |
| `reads`   | 11    | `Bash`, `tasks_spec_get`, `ToolSearch`, `session_pr_wait-for-review`, `session_pr_checks` |
| errored   | 1     | `session_pr_merge` — rendered at the failure tier, which outranks the effect step         |

Two things worth reading off that table rather than the image:

- **Every verdict is correct**, and none of them is derivable from the tool name's spelling —
  `session_pr_edit` and `session_pr_wait-for-review` share a prefix and land on opposite sides.
- **`Bash` sits in the reads column.** It is `unclassified` by construction
  (`packages/shared/src/tool-effect.ts` — its effect is whatever the caller passed), so a shell
  command that commits renders at read weight. That is the known limit of this surface, not a
  miscount; it is why mt#4238's first success criterion was narrowed at planning to the
  classifier's verdict rather than to "a tool call that mutates state."

## What is NOT shown

- A destructive tier. `ToolEffect` has no `delete` state, so `memory_delete` and `memory_create`
  render alike. The accepted RFC _The watchable world_ reserves a louder tier for destruction; the
  deviation and its reason are recorded in mt#4238's planning audit under gate (p), and the
  underlying split is [mt#4411](minsky://task/mt%234411).
- Any hue. `destructive` is reserved for hard alarms and amber for attention debt
  (`docs/design-system.md` §5.1); a healthy write is neither, so the weight is spent entirely on
  the neutral brightness/font-weight axis.
