#!/usr/bin/env bun
// Print GUARD_REGISTRY as a stable, order-sensitive snapshot for mt#4115.
//
// ## What this compares, and why not array position
//
// mt#4115 moves registry entries into per-family modules. That is a pure move,
// but "pure" has to be checked against what the dispatcher actually reads, not
// against the array's shape. `getGuardsForEvent` filters by event, then by
// matcher, and the dispatcher runs the FILTERED list in order with
// first-deny-wins. So the behavior-bearing invariant is:
//
//   for every (event, toolName) the dispatcher can be invoked with,
//   the ordered list of guards that run is unchanged.
//
// Array position is a PROXY for that, and a lossy one in both directions: two
// guards on disjoint matchers can swap places with no observable effect, while
// two guards on the SAME matcher swapping changes which one denies first. So
// this dumps the per-(event, tool) dispatch lists directly — section 2 below —
// and keeps the flat field table only as a field-level diff of each entry.
//
// Tool names are harvested from the matchers themselves (every literal
// alternative of every registered matcher), so the probe set cannot drift out
// of sync with the registry it probes.

import { GUARD_REGISTRY, getGuardsForEvent, type LifecycleEvent } from "../.minsky/hooks/registry";

const EVENTS: LifecycleEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "SessionEnd",
];

/** Every literal tool name any registered matcher names, plus a never-matching control. */
function harvestToolNames(): string[] {
  const names = new Set<string>(["__no_such_tool__"]);
  for (const reg of GUARD_REGISTRY) {
    if (!reg.matcher) continue;
    for (const alt of reg.matcher.split("|")) {
      const literal = alt.trim();
      if (literal) names.add(literal);
    }
  }
  return [...names].sort();
}

const fieldRows = GUARD_REGISTRY.map((r, i) =>
  [
    i,
    r.name,
    r.event,
    r.matcher ?? "-",
    r.denyCapable ?? "-",
    r.tuningOwnership ?? "-",
    r.timeoutMs ?? "-",
    r.calibrationLog ?? "-",
    r.contextPriority ?? "-",
    r.needsTranscript ?? "-",
    (r.effects ?? []).map((e) => JSON.stringify(e)).join("+") || "-",
  ].join("\t")
);

const toolNames = harvestToolNames();
const dispatchRows: string[] = [];
for (const event of EVENTS) {
  // The non-tool-scoped dispatch: matchers are meaningless without a tool name.
  dispatchRows.push(
    `${event}\t<no-tool>\t${getGuardsForEvent(GUARD_REGISTRY, event)
      .map((g) => g.name)
      .join(",")}`
  );
  for (const tool of toolNames) {
    dispatchRows.push(
      `${event}\t${tool}\t${getGuardsForEvent(GUARD_REGISTRY, event, tool)
        .map((g) => g.name)
        .join(",")}`
    );
  }
}

console.log("## fields");
console.log(fieldRows.join("\n"));
console.log("## dispatch");
console.log(dispatchRows.join("\n"));
console.log(`## total ${GUARD_REGISTRY.length}`);
