# tab-watcher

Snapshots the live Claude Code sessions and their iTerm window/tab layout every 30s, so the
working set can be rebuilt after a crash, a forced reboot, or an accidental quit.

## Canonical source vs installed copy

**This directory is canonical. `~/.claude/scripts/` holds installed artifacts.**

Same relationship ADR-028 establishes for `.minsky/hooks/` → `.claude/hooks/`: the repo holds the
source, a generated/installed tree holds what actually executes, and a check makes divergence
loud.

`~/Library/LaunchAgents/com.local.claude-tab-watcher.plist` runs the **installed** copy, so the
installed copy is what executes and this directory is what code search finds. That asymmetry is
what let the two diverge for three months (mt#3873): the repo copy went stale and its tab-launch
mechanism silently created nothing, while the live copy quietly accumulated fixes nobody reviewed.

**Do not edit `~/.claude/scripts/*.sh` by hand.** Edit here, then `install.sh install`. A hand-edit
is not detected by anything except `install.sh drift`.

## Commands

```
./install.sh install     # copy scripts to ~/.claude/scripts, render + bootstrap the launchd agent
./install.sh uninstall   # bootout the agent and remove installed files (state dir is left intact)
./install.sh status      # is the agent loaded? when was the last snapshot, and how many sessions?
./install.sh drift       # compare every installed script against its repo copy
```

`drift` exits 0 when everything matches and 1 when any script differs or is missing, printing the
diff and the remedy. It reports **every** drifted file in one run rather than stopping at the
first.

`INSTALLED_SCRIPTS` in `install.sh` is the single list both `install` and `drift` iterate — adding
a file there is what brings it under the drift check. `resume-tabs-in-place.sh` existed only in the
installed location until mt#3873, which is exactly how it escaped version control.

## Files

| file                                 | role                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `tab-watcher.sh`                     | the daemon body; writes `snapshot.json` + timestamped history every 30s |
| `resume-from-snapshot.sh`            | rebuilds the recorded window/tab layout in a **new** window             |
| `resume-tabs-in-place.sh`            | re-attaches sessions to tabs that are **already open**                  |
| `install.sh`                         | install / uninstall / status / drift                                    |
| `com.local.claude-tab-watcher.plist` | launchd agent template (`__HOME__` is substituted at install)           |

## Retention

`HISTORY_KEEP` defaults to **120** — at the 30s cadence that is roughly an hour of rolling history
(~35 KB/file). It was 10 (five minutes), which could not survive a reboot: the watcher restarting
after an unclean shutdown pruned the pre-crash inventory before anyone could get to it.

`archive_pre_boot_snapshot` additionally preserves the last snapshot taken **before the current
boot** as `preboot-<timestamp>.json`, written once per boot and never a pruning candidate. Rolling
retention alone is self-defeating for a crash-recovery tool; the pre-crash inventory is the only
thing anyone actually wants after a panic.

## Window grouping, and when it is not real

`resume-from-snapshot.sh` rebuilds windows from each session's `iterm_window_id`, which
`tab-watcher.sh` gets by asking iTerm over AppleScript. When iTerm is **wedged** — the case a
crash snapshot exists for — it never answers, and before mt#4080 every session was simply
recorded with an empty window id: indistinguishable from iTerm genuinely having one window. The
snapshot looked complete and the layout was silently gone.

Every snapshot now carries two fields, and a third when it applies:

| field                   | values                      | meaning                                       |
| ----------------------- | --------------------------- | --------------------------------------------- |
| `iterm_dump`            | `ok` / `unavailable`        | did iTerm answer at all?                      |
| `iterm_grouping_source` | `live` / `history` / `none` | where the grouping came from                  |
| `iterm_grouping_from`   | a timestamp                 | which snapshot a recovered grouping came from |

When the dump is unavailable, the watcher reuses the most recent **observed** grouping from
history, re-joined to the current sessions **by tty**. That works because the tty comes from
`ps`/`lsof`, which do not need iTerm: a session still running still has the tty it was recorded
under. Sessions started since the last good dump match nothing and stay ungrouped, so the join
bounds itself and needs no age cutoff. A snapshot that was itself recovered is never used as a
source — chaining would keep re-dating a stale layout.

`resume-from-snapshot.sh` prints a warning when it restores from a snapshot whose dump was
unavailable, naming whether the grouping was recovered (and from when) or is simply gone.
**Snapshots written before mt#4080 carry none of these fields and are read as observed** — which
is the right default for them, since they were only ever written when the dump succeeded or
failed silently.

## Restoring

```
./resume-from-snapshot.sh --dry-run          # print the plan, open nothing
./resume-from-snapshot.sh                    # rebuild the layout
```

After a crash, restore from the last **pre-crash** file rather than the live one, which the daemon
may have already overwritten with a post-reboot (empty) inventory:

```
ls -t ~/.claude/tab-state/snapshot-*.json
./resume-from-snapshot.sh --snapshot ~/.claude/tab-state/preboot-<ts>.json
```

Defaults worth knowing:

- **Window-grouped.** Sessions that shared an iTerm window are restored as tabs of one new window.
  `--flat` gives the pre-2026-08-05 behavior of one window per session.
- **Staggered.** `--stagger` (default 3s) and `--min-free-gb` (default 8) pace the restore.
  Restoring a large snapshot at once is the documented trigger for a logd-watchdog forced reboot:
  aggregate Claude RSS pushes free pages low, logd's drain-mem queue stalls in the same malloc
  path, and the watchdog fires at 40s.
- **Already-running sessions are skipped**, so a partial restore can be re-run safely.
  `--no-skip-running` overrides, but resuming a session that already has a live process gives two
  processes appending to one transcript — see mem#707 R9 for what that costs.

`--limit <n>` stages a large restore; `--window <id>` restores one recorded window (repeatable).

## Platform

macOS only: launchd, iTerm2 AppleScript, and BSD `stat -f`/`find -newerXY` throughout.
