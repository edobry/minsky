/**
 * The version Minsky states about ITSELF on the MCP surface (mt#5029).
 *
 * Two places tell an MCP peer what Minsky is: the server's `serverInfo.version`
 * in the `initialize` response (`start-command.ts`), and the `clientInfo.version`
 * the CLI sends when it connects as a client (`tools-command.ts`). Both were the
 * literal `"1.0.0"` — a number this package has never carried. It went
 * `0.1.0` → `0.1.1` → `0.1.2` → `0.2.0`, and `src/cli.ts` retired its own
 * hardcoded `1.0.0` in mt#3616 so `--version` would read `package.json`; the MCP
 * surface was not brought along.
 *
 * A wrong version in a handshake produces no error anywhere, which is why it sat
 * behind a `// TODO: Import from package.json` long enough to outlive four
 * releases. A client that logs or branches on it received a number it could not
 * even reason about as "an old release".
 *
 * ## Why a shared constant rather than two imports
 *
 * The value used to live inside a local object literal, reachable by nothing, so
 * no test could assert it without standing up a server. Naming it here gives the
 * assertion a seam: `advertised-version.test.ts` reads `package.json` off disk
 * independently and compares, so re-introducing a literal at either call site
 * fails a test rather than silently shipping.
 *
 * ## What deliberately does NOT use this
 *
 * The `clientInfo` literals in `scripts/*` — `deploy-verify`,
 * `mt#1745-benchmark`, `mt2677-progress-probe`, `post-deploy-health-monitor` and
 * the rest. Each names a per-probe identity rather than the product, so its
 * version describes that probe; a probe does not ship with the package, and
 * pointing it at `package.json` would make the field mean something else. The
 * discriminator is the NAME, not the version: if `clientInfo.name` is the
 * product, the version is a claim about Minsky and belongs here.
 *
 * Out of scope, and must not be folded in: `protocolVersion` (mt#4856/mt#4608 —
 * a spec revision the peers negotiate, not a product version), and the policy
 * versions (`AUTHORSHIP_POLICY_VERSION`, `provenance-schema.ts`'s
 * `policyVersion`, `cache-service.ts`'s cache format), each of which versions its
 * own artifact and must NOT track the package.
 */

import packageJson from "../../../package.json" with { type: "json" };

export const MCP_ADVERTISED_VERSION: string = packageJson.version;
