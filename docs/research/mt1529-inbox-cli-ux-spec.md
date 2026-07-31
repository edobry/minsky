# Inbox CLI UX Spec — Post-v1 Verbs (mt#1529)

**Research brief for mt#454 (Agent Inbox) · post-v1 CLI surface**
**Date:** 2026-05-01
**Status:** Draft — pending mt#1528 (data model) for concurrency primitive finalization

---

## 1. Context and Scope

### 1.1 What shipped in v1

mt#1456 and mt#1458 shipped the initial inbox CLI surface:

| Command                    | Description                                   |
| -------------------------- | --------------------------------------------- |
| `minsky asks list`         | Read-only inspection with state/kind filters  |
| `minsky asks create`       | Create a new Ask (agent-facing)               |
| `minsky asks respond <id>` | Attach a response and advance to `responded`  |
| `minsky asks reconcile`    | Run one pass of the quality-review reconciler |

These commands are registered in `src/adapters/shared/commands/asks.ts` and serve as the naming,
option, and output-shape baseline that all post-v1 verbs **must** follow.

### 1.2 What this brief covers

Post-v1 verbs for multi-operator workflows, lifecycle recovery, deadline management, priority and
assignment surfaces, and batch operations. No implementation is produced here — this is a
command-reference design that implementation tasks can consume directly.

### 1.3 Anchor files (read-only, not modified)

| File                                   | Role                                           |
| -------------------------------------- | ---------------------------------------------- |
| `src/adapters/shared/commands/asks.ts` | v1 command registrations (naming baseline)     |
| `src/domain/ask/repository.ts`         | AskRepository interface — methods CLI wraps    |
| `src/domain/ask/state-machine.ts`      | Valid transitions — verbs cannot violate these |
| `src/domain/ask/types.ts`              | Ask shape — CLI output mirrors this            |

### 1.4 State machine reference

The current transition table (from `src/domain/ask/state-machine.ts`):

```
detected   → classified | cancelled | expired
classified → routed     | cancelled | expired
routed     → suspended  | cancelled | expired
suspended  → responded  | cancelled | expired
responded  → closed
closed     → (terminal)
cancelled  → (terminal)
expired    → (terminal)
```

Terminal states (`closed`, `cancelled`, `expired`) admit no further transitions. The `reopen` verb
described below requires a new transition (`closed → suspended`) that **must be added in mt#1528**.

### 1.5 Conventions from v1 (all post-v1 verbs must honor)

- **Option names**: `--state`, `--kind`, `--limit`, `--json`, `--message` (from `asks.respond`)
- **Exit codes**: `0` = success, `1` = usage/validation error, `2` = not found, `3` = conflict/concurrency error
- **`--json` shape**: always a top-level object `{ "ask": <AskObject> }` for single-entity commands,
  `{ "asks": [...], "total": N, "limit": N }` for list commands
- **Task-id resolution**: `--task <id>` resolves to `parentTaskId` filter in all list variants
- **Dry-run policy**: every state-mutating verb supports `--dry-run` and requires `--execute` to apply
  (per CLAUDE.md §Operational Safety). `--dry-run` is the default mode; `--execute` is the explicit opt-in.

---

## 2. Operator UX Action Taxonomy (from mt#1526)

mt#1526 (Agent Inbox ecosystem comparison) recommends borrowing Agent Inbox's UX action taxonomy:
**accept / reject / edit / respond**. These map onto Minsky verbs as follows:

| Agent Inbox action  | Minsky verb(s)               | Notes                                                |
| ------------------- | ---------------------------- | ---------------------------------------------------- |
| accept              | `asks claim`                 | Claims ownership of a suspended Ask                  |
| reject              | `asks release`               | Releases a claimed Ask without responding            |
| edit                | `asks respond --message ...` | Rewrite semantics: replace response draft            |
| respond             | `asks respond` (v1, shipped) | Attach final response and advance state              |
| close without reply | `asks close`                 | Operator cancels; transitions to `cancelled`         |
| reopen              | `asks reopen`                | Re-suspend after bad response (needs new transition) |

The taxonomy guides the naming and UX shape. The four actions are not four separate isolated verbs —
they are UX-level intents that may map to a single method or a compound operation on `AskRepository`.

---

## 3. Command Reference

### 3.1 Verb template

Each verb section is structured as:

```
Signature
Parameters (required + optional)
Exit codes
JSON output shape
Dry-run behavior
Error conditions
Usage examples
AskRepository method(s) + state transition(s)
```

---

### 3.2 `asks claim`

**Purpose**: Claim ownership of a suspended Ask for exclusive processing. Implements optimistic-lock
concurrency: two operators cannot claim the same Ask simultaneously. The claim is recorded in
`metadata.claimedBy` and `metadata.claimedAt`.

> **Dependency on mt#1528**: The concurrency primitive (optimistic-lock vs. advisory-lock vs.
> metadata-field approach) is provisional pending mt#1528's data model decisions. This spec assumes
> a `metadata`-field approach (no schema migration required) and flags where a stronger primitive
> would change the implementation.

#### Signature

```
minsky asks claim <id> [--execute] [--dry-run] [--operator <agent-id>] [--json]
```

#### Parameters

| Parameter               | Required         | Default                           | Description                                |
| ----------------------- | ---------------- | --------------------------------- | ------------------------------------------ |
| `<id>`                  | yes              | —                                 | Ask ID to claim                            |
| `--execute`             | no (see dry-run) | —                                 | Apply the claim. Omitting means dry-run.   |
| `--dry-run`             | no               | default if `--execute` absent     | Preview what would happen without applying |
| `--operator <agent-id>` | no               | current session operator identity | Agent ID that is claiming ownership        |
| `--json`                | no               | false                             | Output as JSON                             |

#### Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | Claim applied (or preview shown)                               |
| 1    | Usage error (invalid id format, missing required param)        |
| 2    | Ask not found                                                  |
| 3    | Concurrency conflict — Ask already claimed by another operator |
| 4    | State error — Ask is not in `suspended` state                  |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "state": "suspended",
    "metadata": {
      "claimedBy": "operator:user:alice",
      "claimedAt": "2026-05-01T12:00:00.000Z"
    }
  },
  "claimed": true,
  "dryRun": false
}
```

Dry-run response adds `"dryRun": true` and does NOT write to the repository.

#### Dry-run behavior

`--dry-run` (the default when `--execute` is omitted) prints:

```
[dry-run] Would claim Ask 01HXYZ... for operator:user:alice
  Current state: suspended
  claimedBy: (none)
  claimedAt: (none)

  Would write:
    metadata.claimedBy = "operator:user:alice"
    metadata.claimedAt = "2026-05-01T12:00:00.000Z"

Run with --execute to apply.
```

If the Ask is already claimed, dry-run shows the current claimant and exits with code 3.

#### Error conditions

- **Not found**: `Ask 01HXYZ... not found` (exit 2)
- **Wrong state**: `Ask 01HXYZ... is in state "closed" — claim requires state "suspended"` (exit 4)
- **Already claimed**: `Ask 01HXYZ... is already claimed by operator:user:bob (since 2026-05-01T11:55:00.000Z)` (exit 3)

#### Usage examples

```bash
# Preview a claim (default dry-run)
minsky asks claim 01HXYZ...
# → [dry-run] Would claim Ask 01HXYZ... for operator:user:alice
# → Run with --execute to apply.

# Apply the claim
minsky asks claim 01HXYZ... --execute
# → Claimed Ask 01HXYZ... for operator:user:alice

# Claim as a specific operator
minsky asks claim 01HXYZ... --operator "operator:user:carol" --execute

# Conflict error path
minsky asks claim 01HXYZ... --execute
# exit 3: Ask 01HXYZ... is already claimed by operator:user:bob (since ...)
```

#### Repository + state transition

| Operation                | Method                                              | Transition                                                            |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| Read current claim state | `repo.getById(id)`                                  | none                                                                  |
| Write claim metadata     | `repo.transition(id, "suspended")` + metadata patch | `suspended → suspended` (no state change; metadata field update only) |

> **Note**: `claim` does not change `AskState`. It is a metadata-only operation. If mt#1528 adds
> a dedicated `claimed` state, the transition becomes `suspended → claimed` and this note becomes
> obsolete. Flag this as a provisional design decision.

---

### 3.3 `asks release`

**Purpose**: Release a claimed Ask back to the unowned pool without responding. Only the current
claimant (or an operator with elevated permissions) can release. Implements the "reject" action
from the Agent Inbox UX taxonomy.

#### Signature

```
minsky asks release <id> [--execute] [--dry-run] [--operator <agent-id>] [--force] [--json]
```

#### Parameters

| Parameter               | Required         | Default                       | Description                                                |
| ----------------------- | ---------------- | ----------------------------- | ---------------------------------------------------------- |
| `<id>`                  | yes              | —                             | Ask ID to release                                          |
| `--execute`             | no (see dry-run) | —                             | Apply the release                                          |
| `--dry-run`             | no               | default if `--execute` absent | Preview only                                               |
| `--operator <agent-id>` | no               | current session identity      | Must match `metadata.claimedBy` unless `--force`           |
| `--force`               | no               | false                         | Release regardless of who claimed it (elevated permission) |
| `--json`                | no               | false                         | Output as JSON                                             |

#### Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Released (or preview shown)                                     |
| 1    | Usage error                                                     |
| 2    | Ask not found                                                   |
| 3    | Permission error — not the current claimant (without `--force`) |
| 4    | State error — Ask is not claimed                                |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "state": "suspended",
    "metadata": {
      "claimedBy": null,
      "claimedAt": null
    }
  },
  "released": true,
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would release Ask 01HXYZ...
  Currently claimed by: operator:user:alice (since 2026-05-01T12:00:00.000Z)
  Would clear: metadata.claimedBy, metadata.claimedAt

Run with --execute to apply.
```

#### Error conditions

- **Not found**: exit 2
- **Not claimed**: `Ask 01HXYZ... is not currently claimed` (exit 4)
- **Wrong claimant**: `Ask 01HXYZ... is claimed by operator:user:alice — use --force to override` (exit 3)

#### Usage examples

```bash
# Preview release
minsky asks release 01HXYZ...

# Release own claim
minsky asks release 01HXYZ... --execute

# Force-release (admin / escalation path)
minsky asks release 01HXYZ... --force --execute
```

#### Repository + state transition

| Operation            | Method                           | Transition              |
| -------------------- | -------------------------------- | ----------------------- |
| Verify claimant      | `repo.getById(id)`               | none                    |
| Clear claim metadata | metadata patch (no state change) | `suspended → suspended` |

---

### 3.4 `asks close`

**Purpose**: Operator cancels an Ask without providing a response. Transitions state to `cancelled`.
Use when the Ask is no longer relevant, the requestor has been superseded, or the question became
moot. Distinct from `asks respond` (which provides a substantive answer) and from system-level
`expired` (which is deadline-driven, not operator-driven).

#### Signature

```
minsky asks close <id> --reason <text> [--execute] [--dry-run] [--json]
```

#### Parameters

| Parameter         | Required         | Default                       | Description                                                       |
| ----------------- | ---------------- | ----------------------------- | ----------------------------------------------------------------- |
| `<id>`            | yes              | —                             | Ask ID to close                                                   |
| `--reason <text>` | yes              | —                             | Human-readable cancellation reason (stored in `response.payload`) |
| `--execute`       | no (see dry-run) | —                             | Apply the cancellation                                            |
| `--dry-run`       | no               | default if `--execute` absent | Preview only                                                      |
| `--json`          | no               | false                         | Output as JSON                                                    |

#### Exit codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | Closed (or preview shown)                        |
| 1    | Usage error (missing `--reason`)                 |
| 2    | Ask not found                                    |
| 4    | State error — Ask is already in a terminal state |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "state": "cancelled",
    "closedAt": "2026-05-01T12:05:00.000Z",
    "response": {
      "responder": "operator",
      "payload": { "cancellationReason": "Superseded by mt#1600 decision" },
      "attentionCost": null
    }
  },
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would cancel Ask 01HXYZ...
  Current state: suspended
  Reason: "Superseded by mt#1600 decision"
  Would transition: suspended → cancelled
  Would set: closedAt, response.payload.cancellationReason

Run with --execute to apply.
```

#### Error conditions

- **Missing reason**: `--reason is required for asks close` (exit 1)
- **Not found**: exit 2
- **Already terminal**: `Ask 01HXYZ... is already in terminal state "closed" — no further transitions allowed` (exit 4)

#### Usage examples

```bash
# Preview cancellation
minsky asks close 01HXYZ... --reason 'Decision was made via direct operator message'

# Apply cancellation
minsky asks close 01HXYZ... --reason 'Superseded by mt#1600 decision' --execute

# Already terminal error
minsky asks close 01HXYZ... --reason 'late close' --execute
# exit 4: Ask 01HXYZ... is in terminal state "closed"
```

#### Repository + state transition

| Operation              | Method                                                                                     | Transition                  |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Validate current state | `repo.getById(id)`                                                                         | none                        |
| Cancel the Ask         | `repo.close(id, { response: { responder: "operator", payload: { cancellationReason } } })` | Current state → `cancelled` |

Valid source states for `cancelled`: `detected`, `classified`, `routed`, `suspended` (per state machine).
**Note**: `responded → cancelled` is **not** a valid transition. An Ask with a response must go to
`closed` via `asks respond` completing the lifecycle, not via `asks close`.

---

### 3.5 `asks reopen`

**Purpose**: Re-suspend a closed Ask when the operator determines the original response was
insufficient. Implements recovery semantics: the Ask re-enters `suspended` state so a new response
can be submitted.

> **Requires new transition in mt#1528**: `closed → suspended` is not currently in the state
> machine. This verb **cannot be implemented** until mt#1528 adds this transition. The spec flags
> this requirement explicitly so the data-model task can include it in scope.

#### Signature

```
minsky asks reopen <id> --reason <text> [--execute] [--dry-run] [--json]
```

#### Parameters

| Parameter         | Required         | Default                       | Description                                   |
| ----------------- | ---------------- | ----------------------------- | --------------------------------------------- |
| `<id>`            | yes              | —                             | Ask ID to reopen                              |
| `--reason <text>` | yes              | —                             | Explanation for why the Ask is being reopened |
| `--execute`       | no (see dry-run) | —                             | Apply the reopen                              |
| `--dry-run`       | no               | default if `--execute` absent | Preview only                                  |
| `--json`          | no               | false                         | Output as JSON                                |

#### Exit codes

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | Reopened (or preview shown)                                                                     |
| 1    | Usage error (missing `--reason`)                                                                |
| 2    | Ask not found                                                                                   |
| 4    | State error — Ask is in `expired` or `cancelled` terminal state (only `closed` can be reopened) |
| 5    | Feature not yet available — state machine does not support `closed → suspended`                 |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "state": "suspended",
    "suspendedAt": "2026-05-01T12:10:00.000Z",
    "metadata": {
      "reopenReason": "Response was incomplete — missing the authorization path",
      "reopenedAt": "2026-05-01T12:10:00.000Z",
      "previousState": "closed"
    }
  },
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would reopen Ask 01HXYZ...
  Current state: closed
  Reason: "Response was incomplete — missing the authorization path"
  Would transition: closed → suspended
  Would set: suspendedAt, metadata.reopenReason, metadata.reopenedAt

NOTE: This transition requires mt#1528 to add "closed → suspended" to the state machine.

Run with --execute to apply.
```

#### Error conditions

- **Missing reason**: exit 1
- **Not found**: exit 2
- **Wrong terminal state** (`cancelled` or `expired`): `Ask 01HXYZ... is in terminal state "cancelled" — only closed Asks can be reopened` (exit 4)
- **Not yet implemented**: exit 5 until mt#1528 lands the new transition

#### Usage examples

```bash
# Preview reopen
minsky asks reopen 01HXYZ... --reason 'Response lacked the auth path detail'

# Apply reopen
minsky asks reopen 01HXYZ... --reason 'Response lacked the auth path detail' --execute

# Wrong terminal state error
minsky asks reopen 01HXYZ... --reason 'too late' --execute
# exit 4: Ask 01HXYZ... is in terminal state "cancelled" — only closed Asks can be reopened
```

#### Repository + state transition

| Operation                  | Method                             | Transition                                        |
| -------------------------- | ---------------------------------- | ------------------------------------------------- |
| Validate state is `closed` | `repo.getById(id)`                 | none                                              |
| Reopen Ask                 | `repo.transition(id, "suspended")` | `closed → suspended` (**NEW — requires mt#1528**) |
| Store reopen metadata      | metadata patch                     | —                                                 |

---

### 3.6 `asks extend-deadline`

**Purpose**: Push out the soft deadline on an Ask. Does not change state. Useful when the ask is
still relevant but the original SLA was too tight.

#### Signature

```
minsky asks extend-deadline <id> --to <iso8601> [--execute] [--dry-run] [--json]
```

#### Parameters

| Parameter        | Required | Default | Description                                                    |
| ---------------- | -------- | ------- | -------------------------------------------------------------- |
| `<id>`           | yes      | —       | Ask ID                                                         |
| `--to <iso8601>` | yes      | —       | New deadline in ISO-8601 format (e.g., `2026-05-08T18:00:00Z`) |
| `--execute`      | no       | —       | Apply the deadline change                                      |
| `--dry-run`      | no       | default | Preview only                                                   |
| `--json`         | no       | false   | Output as JSON                                                 |

#### Exit codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | Deadline updated (or preview shown)              |
| 1    | Usage error (missing or invalid `--to`)          |
| 2    | Ask not found                                    |
| 4    | State error — Ask is already in a terminal state |
| 6    | Deadline in the past                             |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "deadline": "2026-05-08T18:00:00.000Z"
  },
  "previousDeadline": "2026-05-03T18:00:00.000Z",
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would extend deadline for Ask 01HXYZ...
  Previous deadline: 2026-05-03T18:00:00.000Z
  New deadline:      2026-05-08T18:00:00.000Z
  Extension:         +5 days

Run with --execute to apply.
```

#### Error conditions

- **Missing `--to`**: exit 1
- **Past deadline**: `New deadline 2026-04-30T... is in the past (current: 2026-05-01T...)` (exit 6)
- **Terminal state**: exit 4

#### Usage examples

```bash
# Preview extension
minsky asks extend-deadline 01HXYZ... --to 2026-05-08T18:00:00Z

# Apply extension
minsky asks extend-deadline 01HXYZ... --to 2026-05-08T18:00:00Z --execute

# No prior deadline — sets one
minsky asks extend-deadline 01HXYZ... --to 2026-05-08T18:00:00Z --execute
# → Set deadline for Ask 01HXYZ... to 2026-05-08T18:00:00.000Z (previously: none)
```

#### Repository + state transition

| Operation              | Method                                                                                                                     | Transition             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Validate current state | `repo.getById(id)`                                                                                                         | none                   |
| Update deadline        | Direct Drizzle update on `deadline` field (or a new `repo.setDeadline(id, deadline)` method — provisional pending mt#1528) | none (no state change) |

---

### 3.7 `asks set-priority`

**Purpose**: Set or update the priority of an Ask. Priority is stored in `metadata.priority` as an
ordinal: `critical > high > normal > low`. Does not change state.

#### Signature

```
minsky asks set-priority <id> <priority> [--execute] [--dry-run] [--json]
```

#### Parameters

| Parameter    | Required | Default | Description                                 |
| ------------ | -------- | ------- | ------------------------------------------- |
| `<id>`       | yes      | —       | Ask ID                                      |
| `<priority>` | yes      | —       | One of: `critical`, `high`, `normal`, `low` |
| `--execute`  | no       | —       | Apply the change                            |
| `--dry-run`  | no       | default | Preview only                                |
| `--json`     | no       | false   | Output as JSON                              |

#### Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | Priority set (or preview shown)          |
| 1    | Usage error (invalid priority value)     |
| 2    | Ask not found                            |
| 4    | State error — Ask is in a terminal state |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "metadata": {
      "priority": "high"
    }
  },
  "previousPriority": "normal",
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would set priority for Ask 01HXYZ...
  Previous priority: normal
  New priority:      high

Run with --execute to apply.
```

#### Error conditions

- **Invalid priority**: `Invalid priority "urgent" — must be one of: critical, high, normal, low` (exit 1)
- **Terminal state**: exit 4

#### Usage examples

```bash
# Preview
minsky asks set-priority 01HXYZ... high

# Apply
minsky asks set-priority 01HXYZ... high --execute

# List high-priority asks (composes with asks list)
minsky asks list --priority high
```

#### Repository + state transition

| Operation      | Method                                | Transition             |
| -------------- | ------------------------------------- | ---------------------- |
| Validate state | `repo.getById(id)`                    | none                   |
| Write priority | metadata patch on `metadata.priority` | none (no state change) |

---

### 3.8 `asks assign`

**Purpose**: Assign (or reassign) a `routingTarget` on an Ask that is in `routed` or `suspended`
state. Allows an operator to override the router's target selection — for example, redirecting from
one reviewer to another.

#### Signature

```
minsky asks assign <id> --to <agent-id> [--execute] [--dry-run] [--json]
```

#### Parameters

| Parameter         | Required | Default | Description                                                 |
| ----------------- | -------- | ------- | ----------------------------------------------------------- |
| `<id>`            | yes      | —       | Ask ID                                                      |
| `--to <agent-id>` | yes      | —       | New routing target (`AgentId`, `"operator"`, or `"policy"`) |
| `--execute`       | no       | —       | Apply the assignment                                        |
| `--dry-run`       | no       | default | Preview only                                                |
| `--json`          | no       | false   | Output as JSON                                              |

#### Exit codes

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | Assigned (or preview shown)                               |
| 1    | Usage error (missing `--to`)                              |
| 2    | Ask not found                                             |
| 4    | State error — Ask is not in `routed` or `suspended` state |

#### JSON output shape (`--json`)

```json
{
  "ask": {
    "id": "01HXYZ...",
    "routingTarget": "operator:user:carol"
  },
  "previousTarget": "operator:user:alice",
  "dryRun": false
}
```

#### Dry-run behavior

```
[dry-run] Would assign Ask 01HXYZ...
  Previous target: operator:user:alice
  New target:      operator:user:carol

Run with --execute to apply.
```

#### Error conditions

- **Wrong state**: `Ask 01HXYZ... is in state "detected" — assign requires state "routed" or "suspended"` (exit 4)
- **Missing `--to`**: exit 1

#### Usage examples

```bash
# Reassign to a different operator
minsky asks assign 01HXYZ... --to operator:user:carol --execute

# Reassign to policy (short-circuit)
minsky asks assign 01HXYZ... --to policy --execute
```

#### Repository + state transition

| Operation             | Method                                                                                                     | Transition             |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- |
| Validate state        | `repo.getById(id)`                                                                                         | none                   |
| Update routing target | Direct `routingTarget` field update (new `repo.reassign(id, target)` method — provisional pending mt#1528) | none (no state change) |

---

### 3.9 Batch Operations

Batch variants allow operating on multiple Asks in a single command. Batch operations follow the
same dry-run-first pattern and produce structured output listing per-item outcomes.

#### 3.9.1 `asks batch-close`

**Purpose**: Cancel multiple Asks at once. Atomic per-item (each close is independent; partial
success is reported).

##### Signature

```
minsky asks batch-close --ids <id,...> --reason <text> [--execute] [--dry-run] [--json]
```

##### Parameters

| Parameter         | Required            | Description                                                                                  |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `--ids <id,...>`  | yes (or `--filter`) | Comma-separated list of Ask IDs                                                              |
| `--filter <expr>` | yes (or `--ids`)    | Filter expression selecting Asks (e.g., `--filter state=suspended,kind=coordination.notify`) |
| `--reason <text>` | yes                 | Cancellation reason applied to all Asks                                                      |
| `--execute`       | no                  | Apply changes                                                                                |
| `--dry-run`       | no                  | Preview (default)                                                                            |
| `--json`          | no                  | Output as JSON                                                                               |
| `--max <n>`       | no (default: 20)    | Safety cap on batch size                                                                     |

##### JSON output shape (`--json`)

```json
{
  "results": [
    { "id": "01HXYZ...", "success": true, "previousState": "suspended", "newState": "cancelled" },
    { "id": "01HABC...", "success": false, "error": "already in terminal state closed" }
  ],
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "dryRun": false
}
```

##### Safety constraints

- Default batch cap: 20 Asks. Override with `--max`, but values above 100 require `--force`.
- `--filter` without `--execute` is always a dry-run preview showing the match count.
- `--ids` and `--filter` are mutually exclusive.

#### 3.9.2 `asks batch-assign`

**Purpose**: Bulk reassign routing target for multiple Asks.

##### Signature

```
minsky asks batch-assign --ids <id,...> --to <agent-id> [--execute] [--dry-run] [--json]
```

Same structural conventions as `batch-close`. JSON output shape mirrors `batch-close` with
`previousTarget` / `newTarget` per-item.

---

## 4. `asks list` Extensions (Post-v1 Filter Surface)

The v1 `asks list` command accepts `--state` and `--kind`. Post-v1 adds:

| New option                    | Type   | Description                                                     |
| ----------------------------- | ------ | --------------------------------------------------------------- |
| `--task <id>`                 | string | Filter by `parentTaskId` (resolves via standard task-id format) |
| `--session <id>`              | string | Filter by `parentSessionId`                                     |
| `--deadline-before <iso8601>` | string | Asks with `deadline < given date`                               |
| `--deadline-after <iso8601>`  | string | Asks with `deadline > given date`                               |
| `--overdue`                   | flag   | Shorthand for `--deadline-before <now>` on non-terminal Asks    |
| `--claimed`                   | flag   | Filter to Asks where `metadata.claimedBy` is set                |
| `--unclaimed`                 | flag   | Filter to Asks where `metadata.claimedBy` is absent             |
| `--priority <level>`          | string | Filter by `metadata.priority` (critical/high/normal/low)        |
| `--assignee <agent-id>`       | string | Filter by `routingTarget`                                       |

All new filters compose with existing `--state` and `--kind` (AND semantics).

---

## 5. State Transition Summary

The table below maps each post-v1 verb to its repository call and state transition:

| Verb                   | Repo method                        | From state(s)                                   | To state    | Notes                                 |
| ---------------------- | ---------------------------------- | ----------------------------------------------- | ----------- | ------------------------------------- |
| `asks claim`           | `getById` + metadata patch         | `suspended`                                     | `suspended` | Metadata-only; no state change        |
| `asks release`         | `getById` + metadata patch         | `suspended` (claimed)                           | `suspended` | Metadata-only                         |
| `asks close`           | `repo.close()`                     | `detected`, `classified`, `routed`, `suspended` | `cancelled` | Uses existing `close` method          |
| `asks reopen`          | `repo.transition(id, "suspended")` | `closed`                                        | `suspended` | **NEW transition — requires mt#1528** |
| `asks extend-deadline` | `repo.setDeadline()` (new)         | any non-terminal                                | same        | No state change; new method needed    |
| `asks set-priority`    | metadata patch                     | any non-terminal                                | same        | No state change                       |
| `asks assign`          | `repo.reassign()` (new)            | `routed`, `suspended`                           | same        | No state change; new method needed    |
| `asks batch-close`     | `repo.close()` × N                 | see `asks close`                                | `cancelled` | Per-item, independent                 |
| `asks batch-assign`    | `repo.reassign()` × N              | `routed`, `suspended`                           | same        | Per-item, independent                 |

**Transitions that are already valid** (require no mt#1528 changes): `close`, `claim`, `release`,
`extend-deadline`, `set-priority`, `assign`.

**Transitions requiring mt#1528**: `reopen` (`closed → suspended`).

**New repository methods required** (provisional — mt#1528 decides final interface):

- `repo.setDeadline(id: string, deadline: string): Promise<Ask>`
- `repo.reassign(id: string, target: AgentId | "operator" | "policy"): Promise<Ask>`

---

## 6. Composition with v1 Surface

All post-v1 verbs compose with the shipped v1 surface:

| v1 Command          | Post-v1 Composition Point                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `asks list`         | Post-v1 filter flags extend the same command                                                                                             |
| `asks respond <id>` | `asks claim` → `asks respond` is the happy path for an operator picking up and answering an Ask                                          |
| `asks reconcile`    | Works on `quality.review` Asks in `suspended`; `asks claim` before `asks respond` enables exclusive ownership in multi-operator contexts |

**Naming consistency**: All post-v1 options use the same naming style as v1: hyphen-separated
lowercase (`--dry-run`, `--execute`, `--agent-id`, `--iso8601`). No camelCase option names.

**`--json` shape consistency**: Single-entity commands return `{ "ask": <AskObject> }`. List
commands return `{ "asks": [...], "total": N, "limit": N }`.

---

## 7. v2 Verb Backlog

The following verbs are explicitly deferred beyond the post-v1 surface. Each entry includes a
one-sentence justification for deferral.

| Verb                 | Justification for deferral                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asks bulk-reassign` | Requires a reassignment strategy (round-robin, capacity-aware, affinity-based) that cannot be designed until the multi-operator concurrency primitive from mt#1528 is production-validated.                                        |
| `asks watch`         | Long-polling or SSE subscription for real-time Ask state changes; deferred pending the transport adapter design in mt#454/D (mt#1531).                                                                                             |
| `asks snooze`        | Temporarily suppress an Ask from list views without changing state; requires a `snoozedUntil` field and a sweep mechanism — adds schema complexity that belongs in a second data-model iteration.                                  |
| `asks delegate`      | Transfer ownership from one operator to another with audit trail; deferred because the concurrency model (mt#1528) must stabilize before multi-operator ownership handoffs can be designed safely.                                 |
| `asks filter save`   | Save a named filter expression for reuse (e.g., `minsky asks list --filter @my-open-reviews`); deferred because it requires a personal preferences / saved-views store that has no existing infrastructure in Minsky.              |
| `asks export`        | Export Asks to JSON/CSV for offline analysis; deferred because the use case is analytics-driven and belongs after the v1 + post-v1 surface has production usage data to guide field selection.                                     |
| `asks merge`         | Deduplicate two Asks that represent the same question; deferred because the semantics (which response wins, how to reroute the survivor) require a principled design decision that is out of scope for the current research phase. |

---

## 8. Dependencies on mt#1528

The following design decisions in this spec are **provisional** and may change once mt#1528
finalizes the data model:

| Decision                | Current provisional assumption                             | mt#1528 may change to                                                |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Claim/release primitive | `metadata.claimedBy` field (no schema migration)           | Dedicated `claimed_by` column with DB-level advisory lock            |
| `reopen` transition     | New `closed → suspended` transition added to state machine | Alternative: a `reopened` intermediate state                         |
| Deadline update         | New `repo.setDeadline()` method                            | Folded into a general `repo.update()` patch method                   |
| Reassign                | New `repo.reassign()` method                               | Folded into `repo.update()` or `repo.transition()` with target param |
| Priority storage        | `metadata.priority` field                                  | Dedicated `priority` column for efficient filtering                  |

Where this spec references provisional decisions, the corresponding verb sections are marked with
a `> **Dependency on mt#1528**` callout.

---

## 9. Cross-references

- **v1 surface (shipped)**: `src/adapters/shared/commands/asks.ts` — `asks.list`, `asks.respond`,
  `asks.create`, `asks.reconcile`
- **State machine**: `src/domain/ask/state-machine.ts` — `VALID_TRANSITIONS`, `guardTransition`
- **Repository interface**: `src/domain/ask/repository.ts` — `AskRepository`
- **Ask types**: `src/domain/ask/types.ts` — `Ask`, `AskState`, `AskKind`, `AgentId`
- **Parent research**: mt#454 — full inbox research cluster
- **Data model**: mt#1528 — concurrency primitive and schema decisions this spec depends on
- **Ecosystem comparison**: mt#1526 — Agent Inbox UX taxonomy (accept/reject/edit/respond) used in §2
- **mt#327 integration**: mt#1531 — inbox-to-task integration (separate sibling brief)
- **v1 implementation**: mt#1456 (asks.list) + mt#1458 (asks.respond + asks.create)
