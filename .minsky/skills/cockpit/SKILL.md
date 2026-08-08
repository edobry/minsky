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

**Prefer `!minsky cockpit open` over this command** — but only once `respondToBashCommands` is
`false`. Both forms run the same thing; the difference is whether the model is asked to say
something afterward.

Since Claude Code v2.1.186 the setting defaults to **true**, so a `!` command DOES get a reply and
DOES cost a turn — measured here, not assumed: in conversation `b310a426` the `<bash-input>` entry
carried a `promptId` and an assistant turn followed it directly, chained by `parentUuid`, with no
intervening user message. The installed 2.1.222 binary's settings schema states it plainly:
_"Whether Claude responds after an input-box ! bash command runs. Set to false to add the command
output to context without a response. Default: true."_

So: with the setting at its default, `!minsky cockpit open` and `/cockpit` cost the same. With it
set to `false`, `!` costs nothing and this skill is the more expensive path — kept because `!`
commands do not appear in the slash-command list, and for harnesses with no bash mode.
