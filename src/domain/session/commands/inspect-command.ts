/** Re-exports from the session facade for backward compatibility. */
export { inspectSessionFromParams } from "../../session";

import { inspectSessionFromParams } from "../../session";

/** Simpler interface for subcommands. */
export async function inspectCurrentSession() {
  return inspectSessionFromParams({});
}
