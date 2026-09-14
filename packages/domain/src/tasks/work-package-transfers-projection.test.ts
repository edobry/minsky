import { describe, test, expect } from "bun:test";
import { renderTransferLog, TRANSFERS_HEADING } from "./work-package-briefing";
import {
  classifyTransfersSection,
  countRenderedTransfers,
} from "./work-package-transfers-projection";

// The pure half of the projection: reading a rendered section back and
// classifying it against the log. The writers and the one-shot run against a
// real Postgres in tests/integration/work-package-transfers-projection.testcontainer.integration.test.ts.

const T0 = new Date(Date.UTC(2026, 8, 14, 12, 0, 0));
const LOG = [
  { seq: 1, origin: "groomed", byConversation: "proc:a", notes: null, createdAt: T0 },
  { seq: 2, origin: "release", byConversation: "proc:a", notes: "stale", createdAt: T0 },
  { seq: 3, origin: "completed", byConversation: null, notes: "all done", createdAt: T0 },
];

const BRIEFING = `Origin: groomed

## Members

- mt#1 — first

## Grouping rationale

One widget.
`;

describe("countRenderedTransfers (mt#5143)", () => {
  test("no section → null; a rendered section → its item count", () => {
    expect(countRenderedTransfers(BRIEFING)).toBeNull();
    expect(countRenderedTransfers(`${BRIEFING}\n${renderTransferLog(LOG)}\n`)).toBe(3);
    expect(countRenderedTransfers(`${BRIEFING}\n${renderTransferLog([])}\n`)).toBe(0);
  });

  test("counts only the section's own items, not a later section's bullets", () => {
    const spec = `${renderTransferLog(LOG.slice(0, 2))}\n\n## Members\n\n- #1 is not a transfer\n- mt#1\n`;
    expect(countRenderedTransfers(spec)).toBe(2);
  });

  test("a heading that merely contains the word is not the section", () => {
    expect(countRenderedTransfers("## Transfers of ownership\n\n- #1 x — t — by y\n")).toBeNull();
  });
});

describe("classifyTransfersSection", () => {
  const withThree = `${BRIEFING}\n${renderTransferLog(LOG)}\n`;

  test("missing / behind / in-sync / ahead", () => {
    expect(classifyTransfersSection(BRIEFING, 3)).toBe("missing");
    expect(classifyTransfersSection(withThree, 4)).toBe("behind");
    expect(classifyTransfersSection(withThree, 3)).toBe("in-sync");
    expect(classifyTransfersSection(withThree, 2)).toBe("ahead");
  });

  test("an empty rendered section against an empty log is in sync", () => {
    expect(classifyTransfersSection(`${TRANSFERS_HEADING}\n\n- none recorded\n`, 0)).toBe(
      "in-sync"
    );
  });
});
