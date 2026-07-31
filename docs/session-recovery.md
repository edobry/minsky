# Recovering a session (`session start --recover`)

Operator reference for the `--recover` flag on `minsky session start` / the `recover: true` param on
the `session_start` MCP tool.

## What `--recover` is for

Normal `session start` refuses when a session already exists for the task — that guard stops two
agents from working the same task at once. `--recover` is the escape hatch for when the existing
state is _abandoned_ rather than _live_, or when a task's branch exists but its session does not.

It is **not** a "force" flag. It never overrides a healthy or idle session, and it never overrides a
session whose PR has merged.

## The three cases

`--recover` decides from two facts: is there a **session record** for the task, and does the task's
**remote branch** (`task/<id>`) exist?

| session record   | remote `task/<id>` | what happens                                                   |
| ---------------- | ------------------ | -------------------------------------------------------------- |
| absent           | absent             | **Refused.** Nothing to recover.                               |
| absent           | present            | Session created and based on **that branch's tip**.            |
| stale / orphaned | present            | Stale record cleared, then based on **that branch's tip**.     |
| stale / orphaned | absent             | Stale record cleared; fresh branch off main.                   |
| healthy / idle   | —                  | Refused (unchanged) — the session may be actively in use.      |
| PR merged        | —                  | Refused (unchanged) — delete the old session explicitly first. |

Recovery means one of two things, and both are honored: **reclaim the task's branch**, or **clear an
abandoned record and start over**. Only when neither applies is there genuinely nothing to recover.

## "Nothing to recover" usually means the task already merged

If you see:

```
Nothing to recover for mt#1234: there is no session record for it AND no remote branch
'task/mt-1234' on https://github.com/...
```

the likeliest explanation is that the task **is already done**. Post-merge cleanup deletes the
session record _and_ the remote branch by design, so "session gone + branch gone" is the normal
shape of a merged task, not a fault.

Check before treating it as a problem:

```
minsky tasks status get mt#1234        # DONE means merged; stop here
```

To start genuinely new work on the task instead, drop the flag:

```
minsky session start --task mt#1234
```

## Behavior notes

- **`--recover` requires `--task`.** Recovery is defined against a task's branch, so there is nothing
  to recover without one. It is refused rather than silently ignored.
- **The branch is fetched through `origin`**, which carries the credentials the workspace already
  has — recovery works on private repos.
- **A recovered branch tracks its remote**, so a later `session pr create` / push targets the branch
  it was recovered from.
- **An unreachable remote refuses distinctly**, with a "could not determine whether..." message
  rather than "nothing to recover". A failed probe is not evidence the branch is absent — treating
  it as absence would decline a recovery that should have succeeded.
- **A failed fetch or checkout is an error.** Recovery never silently falls back to branching off
  main; the half-built session and its directory are removed and the error surfaces.

## Related

- `docs/session-workspace-tools.md` — the session file-access tools.
- mt#3166 (this contract), mt#2895 (the abandoned-CREATED-state case), mt#3106 (routing the
  recover-path delete through the guarded delete — tracked separately).
