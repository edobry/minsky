---
name: cockpit
description: Open this conversation in the Minsky cockpit.
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Bash(minsky cockpit open*)
---

# Cockpit

```!
minsky cockpit open
```

Report that one line and stop.

**Prefer `!minsky cockpit open` over this command.** Both run the same thing, but `!` is bash mode:
it runs in your shell and no model turn is spent. Invoking `/cockpit` renders this skill into a
prompt and the model replies — a full turn for a command with no decision in it. This skill exists
because `!` commands do not appear in the slash-command list, and for harnesses that have no bash
mode.
