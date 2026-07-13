/**
 * Operator notification — public entry point.
 *
 * Exposes the `OperatorNotify` interface and its default system implementation.
 * Zero dependency on the Ask entity — this is pure plumbing.
 */

export type { CommandExecutor, OperatorNotify, StdoutSink } from "./operator-notify";
export { makeProcessStdout, makeSpawnExecutor, SystemOperatorNotify } from "./operator-notify";
