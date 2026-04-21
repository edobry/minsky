import type { SessionProviderInterface } from "./types";

/** Read-only subset of SessionProviderInterface for use in validate() phase (ADR-004) */
export type ReadonlySessionProvider = Pick<
  SessionProviderInterface,
  "listSessions" | "getSession" | "getSessionByTaskId" | "getRepoPath" | "getSessionWorkdir"
>;
