/**
 * The upper bound on a snapshot window's turn count (mt#4263).
 *
 * Its own module for one reason: it has TWO enforcement points at different
 * layers, and they must not drift.
 *
 * - `src/cockpit/routes/context-inspector.ts` rejects `?turns=` above it, so a
 *   client gets a 400 naming the bound instead of a silently clamped response.
 * - `assembleSessionContextSnapshot` clamps to it, so a non-HTTP caller cannot
 *   ask for the whole transcript through the windowed path either.
 *
 * Both are wanted — the route's is a contract, the assembler's is a backstop —
 * but a bound enforced in two places from two literals is a drift vector, and
 * the drift is silent: the two would simply disagree about what "too large"
 * means, with the smaller one winning and no error saying so. PR #3148 R2
 * flagged exactly that after the first cut declared `500` in both files.
 *
 * It lives HERE rather than in the assembler because the route needs the number
 * BEFORE it decides whether to load the assembler at all — the assembler is
 * imported dynamically inside the handler, and pulling in its drizzle/schema
 * graph just to read one integer would defeat that.
 *
 * Sized against the render budget it serves rather than picked round:
 * `INITIAL_TURNS` is 50 and `OLDER_CHUNK` is 100, so 500 is five scroll-back
 * chunks in a single request — well past any page the client asks for, and far
 * short of the 2,236-turn conversations this task measured against.
 */
export const MAX_SNAPSHOT_WINDOW_LIMIT = 500;
