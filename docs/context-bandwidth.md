# Context bandwidth: what a long session actually costs

Measured 2026-08-26 over 662 local session transcripts and 683 subagent transcripts for this
project. Everything below is reproducible:

```bash
bun scripts/measure-context-bandwidth.ts --project ~/.claude/projects/-Users-edobry-Projects-minsky
```

Origin: mt#3842. The quota-burn cluster (mem#762, mt#3345, mt#3346) measures context
re-transmission in **tokens**; this adds the second denominator, **bytes on the wire**, and then
corrects two things the task assumed.

## The mechanism

The Messages API is stateless. Every request re-sends the system prompt, every tool schema, every
prior message, and every prior tool result. Prompt caching prices the unchanged prefix at 0.1x —
**it does not exempt it from transmission**. So the prompt tokens a request carries are the tokens
that crossed the wire, and a transcript is a bandwidth record as much as a spend record.

One trap governs every measurement here: Claude Code writes **one JSONL line per content block**,
so a single API response spans several lines sharing one `message.id`. Counting lines over-counts
requests — measured at 2.27x on this repo's largest transcript, against mem#762's 2.36x. Group by
`message.id`.

## The re-upload tail

A result of size S emitted at request _i_ of an _N_-request session is re-sent **(N − i)** times.
Its true cost is not S; it is S × (N − i).

Measured distribution of N over 662 sessions:

| statistic | requests |
| --------- | -------- |
| median    | 234      |
| mean      | 225      |
| p90       | 394      |
| max       | 1,025    |

**Worked example.** A 100 KB whole-file read, taken early in a median session, is re-uploaded 233
times — **22.8 MB** for one `Read`. At p90 it is 38.4 MB; in the longest observed session, 100 MB.

mt#3842's spec used "a 100 KB read early in a 600-request session costs ~59 MB". The arithmetic is
right and the session is atypical: 600 requests sits between p90 and max. **22.8 MB at the median
is the number to reason with**; 59 MB is a tail case.

### What this implies for reading

The tail multiplier is decided by _when_ you read, and the size by _how_ you read. Both are
controllable:

- **`grep` before `Read`.** A pattern search returns matching lines; a whole-file read returns the
  file, then re-sends it for the rest of the session.
- **Bound the read.** `offset`/`limit` when you know the region. Reading 2,000 lines to look at 40
  is a 50x tail, not a 50x one-off.
- **Read late rather than early** where the choice exists — a result added at request 200 of 234
  pays a 34x tail instead of 233x.
- **Treat an image as the expensive read it is.** At ~364 KB apiece they are the densest payload
  measured here — one screenshot early in a median session costs ~84 MB after its tail, four times
  a 100 KB text read. Read one late, read it once, and never re-read it to "check".
- **Delegate the search** when it is exploratory. See the subagent lever below; it is the largest
  measured effect in this document.

## The session-length curve — the quadratic claim is wrong

mt#3842's third criterion asserted that "upload cost scales with the square of session length."
**It does not.** Measured over the same 662 sessions:

| bin (requests) | sessions | mean requests | mean upload (Mtok) | mean tokens/request |
| -------------- | -------- | ------------- | ------------------ | ------------------- |
| 1–49           | 122      | 14            | 1.8                | 128,017             |
| 50–99          | 36       | 69            | 14.0               | 203,996             |
| 100–199        | 118      | 155           | 51.5               | 331,585             |
| 200–399        | 325      | 291           | 130.7              | 449,061             |
| 400–799        | 57       | 500           | 256.9              | 513,272             |
| 800+           | 4        | 906           | 495.3              | 546,835             |

A log-log fit gives an **upload exponent of 1.38** — between linear and quadratic, and much nearer
linear. The reason is in the last column: **per-request context saturates.** Its own exponent is
**0.38**, not 1.0. Context grows quickly while the session is short and then flattens toward a
working ceiling around 550K tokens, because compaction and the window bound it. Upload is the
product of a growing N and a saturating C, so it is quadratic only in the early regime and close to
linear once C stops moving.

**Why the correction changes the advice rather than just the number.** "Quadratic" implies a runaway
— that the marginal request keeps getting more expensive without limit, so the remedy is to stop
before the blow-up. What actually happens is worse in one way and better in another: there is no
blow-up, but past the knee **every remaining request pays a flat, near-maximal toll forever.** You
do not escape it by stopping soon after; you escape it by not arriving.

### Recommended clear/compact threshold

The knee sits around **150–200 requests**, where per-request context is ~330K and still climbing
steeply; by 291 it is ~449K, and the remaining 600 requests buy only another 22%.

**Compact or clear at ~150 requests.** Holding per-request context near 330K instead of 449K is a
~27% cut in the toll paid by _every subsequent request_ in the session.

Note what the distribution says about current practice: the **median session is 234 requests**,
which is already past the knee. This is not a rare-case optimization.

## The subagent lever — confirmed, and large

mt#3842's second criterion asked whether subagent dispatch is a bandwidth lever, to be confirmed or
refuted by measurement. **Confirmed.** Across 683 subagent transcripts and 39,600 subagent requests:

| quantity                | value                |
| ----------------------- | -------------------- |
| upload inside subagents | 10,728 Mtok          |
| returned to the parent  | 5.77 MB (~1.44 Mtok) |
| median return           | 3,557 bytes          |

**Read the ratio carefully.** 7,440x is _internal upload against returned bytes_ — it is not a
claim that the work was free. The subagent paid its own re-uploads at its own, smaller N. What the
ratio measures is **containment**: none of those 10,728 Mtok entered the parent's context, so none
of it was re-sent for the remainder of the parent's tail. The parent paid a median 3.5 KB.

That is the mechanism stated precisely: inline, a search's tool results land in the parent and are
re-uploaded (N − i) times each. Delegated, they are re-uploaded only inside a transcript that ends,
and the parent's tail carries one summary.

Two honest bounds on the figure:

- Subagents are dispatched for work that is _already_ search-heavy, so this is not a controlled A/B.
  It measures what the lever contained in practice, not what it would contain on arbitrary work.
- Token↔byte conversion uses ~4 B/token to put both sides in one unit. The ratio is large enough
  that the approximation does not affect the conclusion.

This has a quality argument beside the bandwidth one, and they point the same way: mem#584 frames a
fresh dispatch as a fresh **attention** budget, so delegating detail-heavy work protects
detail-attention in the parent as well as its bandwidth.

## Where context actually comes from

Tool results entering context across the corpus — **384.6 MB total**:

| tool                               | MB   | calls  | share | per call |
| ---------------------------------- | ---- | ------ | ----- | -------- |
| `Read`                             | 92.1 | 2,881  | 23.9% | 32 KB    |
| `Bash`                             | 41.2 | 36,764 | 10.7% | 1.1 KB   |
| `chrome-devtools__take_screenshot` | 31.1 | 144    | 8.1%  | 216 KB   |
| `session_search_replace`           | 23.3 | 17,284 | 6.0%  | 1.3 KB   |
| `tasks_spec_get`                   | 22.9 | 3,275  | 5.9%  | 7.0 KB   |
| `memory_search`                    | 22.0 | 902    | 5.7%  | 24.4 KB  |
| `session_exec`                     | 20.5 | 23,179 | 5.3%  | 0.9 KB   |
| `session_read_file`                | 16.0 | 5,111  | 4.2%  | 3.1 KB   |

**Images are the densest thing you can put in a context, by a wide margin.** 299 image blocks carry
**109 MB — 28% of all tool-result bytes, from 0.2% of the blocks** — at ~364 KB each. They arrive
mostly through `Read` on an image file, which is why `Read` leads the table on modest call volume,
and through screenshot tools.

Put that through the tail formula: one screenshot read early in a median 234-request session is
0.36 MB × 233 = **84 MB**, nearly four times the 100 KB text-read example above, from a single call.
Read images late, and never re-read one.

**`memory_search` is the outlier among text-returning Minsky tools: 24.4 KB per call**, an order of
magnitude above its siblings, on only 902 calls. It is also a tool mt#4418's bounding sweep never
saw, and its spec says why — that sweep measured only calls the harness BACKGROUNDED past 120s,
which over-represents slow tools and cannot see fast ones. `memory_search` is fast and enormous. A
concrete instance of the blind spot mt#4418 recorded as a bound on its own measurement, and worth
its own pass.

> **This table was wrong in the first version of this document, and the correction is instructive.**
> The measurement summed only `text` blocks, so every image counted as zero: the total read 273.8 MB
> instead of 384.6 MB, and `Read` ranked seventh at 5.2% rather than first at 23.9%. A measurement
> that silently drops its densest payload class understates its own denominator and every share
> computed from it — including, in the first draft, the share the RTK verdict below rests on. Caught
> by `minsky-reviewer[bot]` on PR #3397, not by me.

## Verdicts on the two external mitigations

mt#3842's fourth criterion requires an explicit recommend/reject with a stated basis.

### RTK — **reject for now**, on measured share

RTK is a PreToolUse interceptor that filters CLI output before it reaches the model (Apache-2.0,
actively maintained; note the install-path collision recorded in the spec — the bare `rtk` crate
name belongs to an unrelated project).

The basis is the table above rather than the vendor's compression ratio. **Shell output is 16.0% of
tool-result bytes** (`Bash` 10.7% + `session_exec` 5.3%) — that is the ceiling on what a
shell-scoped filter can reach, before any question of how well it filters. Even RTK's headline
60–90% reduction on its own scope is therefore at most a ~10–14% cut in tool-result bytes, against
an ongoing per-task verification cost that RTK's own guidance discloses ("a tunable filter, not a
firewall"; "verify impact on every significant task").

That share is **lower** than the 22.5% this document first reported, and the reason is the
image-counting defect noted above: fixing it enlarged the denominator without touching the shell
numerator. The verdict does not turn on the correction — it was reject at 22.5% and is reject by a
wider margin at 16.0% — but the direction is worth stating plainly, because a measurement error
that happens to strengthen your own conclusion is exactly the kind you stop looking for.

The two levers measured in this document — the ~150-request compaction threshold and subagent
containment — act on the whole context rather than on 22.5% of one component, cost nothing, and
carry no third-party dependency. Adopt those first. Revisit RTK if shell output's share rises
materially, which the script above will show.

### Headroom — **reject**, and the reason is not bandwidth

Headroom is a local proxy behind `ANTHROPIC_BASE_URL` that rewrites tool results in flight. Three
independent reasons, in order of weight:

1. **The quality evidence is against it for this workload.** Factory.ai's evaluation — the only
   independent study of the class, over 36,611 production SWE messages — found **artifact trail the
   weakest dimension for every compression method tested, 2.19–2.45 out of 5.0**: compressed agents
   lose track of which files they already modified, re-read them, and make conflicting edits. That
   is precisely this repo's long-implementation-session shape.
2. **The vendor's accuracy numbers are measured on the wrong distribution.** Its published set is
   GSM8K, TruthfulQA, SQuAD and BFCL — none a long-horizon coding-agent task. Its own repo
   separately claims ~20% token reduction for coding agents against a 60–95% headline for JSON, so
   the compression figure and the accuracy figure come from different workloads.
3. **It sits on the credential path.** Routing all API traffic through a third-party proxy is a
   security decision, not only a bandwidth one.

Reason 3 makes adoption a principal decision regardless of the other two; this document records the
evaluation, not an adoption.

**A framing correction from Factory that applies to both, and to us:** _"The right optimization
target is not tokens per request. It is tokens per task."_ Compression that induces a re-read costs
a full re-upload of the re-read content plus its tail, which can exceed what it saved. Any future
measurement here should use bytes per completed task as the denominator.

## What is not measured here

- **A direct packet capture.** The token figures are what the client sent; the mapping to wire bytes
  assumes the request body is uncompressed, which the spec's live `nettop` two-point measurement
  supports (532 KB/request marginal, matching the uncompressed estimate within ~10%) but does not
  prove. A root-privileged capture would upgrade this from `strong-evidence`.
- **A controlled inline-vs-subagent A/B.** See the bound stated above.
- **Fast tools with large payloads, systematically.** `memory_search` surfaced here; nothing
  guarantees it is the only one.

## Cross-references

`scripts/measure-context-bandwidth.ts` (the instrument) · mem#762 (quota-burn decomposition and the
measurement trap) · mem#584 (agent attention as the second resource) · mt#3345 (the always-loaded
floor) · mt#3346 (request count) · mt#4418 (MCP result bounding, and the backgrounded-only bound
this document instantiates) · `subagent-routing.mdc §Bandwidth`.
