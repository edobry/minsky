/**
 * Test double for `fetchBoundedFirstUserTurns`'s raw statement (mt#4655).
 *
 * Three widget/route test files build their own drizzle-shaped `db` mock, and
 * all three branch on table identity inside `.select().from(<table>)`. The
 * bounded user-turn read is NOT a `.select()` chain — it is a single
 * `db.execute` with a `row_number()` window — so those doubles cannot answer it
 * by table identity and each needs an `execute`. This is that `execute`, defined
 * once, so the three cannot drift apart.
 *
 * It reproduces BOTH properties of the real statement, because a double that
 * reproduced neither would keep passing if either broke:
 *
 * - **the id subset** the statement actually asked for — production skips ids
 *   whose label resolves at a higher tier, so a double returning every fixture
 *   turn regardless would let that filter break silently (PR #3400 R1);
 * - **the per-session bound**, so a test cannot assert a label built from a row
 *   the real query would have excluded.
 *
 * Returns the driver's snake_case column names rather than drizzle's select
 * aliases, which is what `db.execute` yields for a raw statement — so a test
 * passing here exercises the shape production actually receives.
 */
import { MAX_USER_TURN_CANDIDATES } from "@minsky/domain/transcripts/conversation-label";

export interface DoubleUserTurn {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
}

interface RawTurnRow {
  agent_session_id: string;
  turn_index: number;
  user_text: string;
}

/**
 * Extract the id set from the statement's embedded params.
 *
 * The ids are the string-valued params drizzle put in the template; the only
 * other param is the numeric row bound. An empty set means the shape was not
 * recognizable, in which case the double does not filter — a mock that silently
 * returned NOTHING would fail tests for the wrong reason and send the reader
 * hunting a production bug that isn't there.
 */
function requestedIdsFrom(statement: unknown): Set<string> {
  const found = new Set<string>();

  // RECURSIVE, because `inArray(col, ids)` nests its params inside a sub-`SQL`
  // rather than placing them in the top-level chunk list. A flat scan finds no
  // ids and — worse than finding none — can pick up an unrelated string and
  // filter everything out, which presents as a label regression rather than as
  // a broken double.
  const walk = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    const record = node as { queryChunks?: unknown; value?: unknown };
    if (record.queryChunks !== undefined) walk(record.queryChunks, depth + 1);
    // A drizzle `Param` carries the bound value. Only strings can be ids here;
    // the statement's other param is the numeric row bound.
    if (typeof record.value === "string") found.add(record.value);
    else if (Array.isArray(record.value)) walk(record.value, depth + 1);
  };

  walk((statement as { queryChunks?: unknown } | undefined)?.queryChunks, 0);
  return found;
}

/** Build the `execute` member for a drizzle-shaped `db` mock. */
export function boundedUserTurnsExecute(
  turns: DoubleUserTurn[] | undefined
): (statement: unknown) => Promise<RawTurnRow[]> {
  return (statement: unknown) => {
    const requestedIds = requestedIdsFrom(statement);
    const seenPerSession = new Map<string, number>();

    const bounded = [...(turns ?? [])]
      .filter((turn) => requestedIds.size === 0 || requestedIds.has(turn.agentSessionId))
      .filter((turn): turn is DoubleUserTurn & { userText: string } => turn.userText !== null)
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .filter((turn) => {
        const nth = (seenPerSession.get(turn.agentSessionId) ?? 0) + 1;
        seenPerSession.set(turn.agentSessionId, nth);
        return nth <= MAX_USER_TURN_CANDIDATES;
      });

    return Promise.resolve(
      bounded.map((turn) => ({
        agent_session_id: turn.agentSessionId,
        turn_index: turn.turnIndex,
        user_text: turn.userText,
      }))
    );
  };
}
