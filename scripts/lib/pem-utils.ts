/**
 * Re-exports from the canonical domain location.
 *
 * The implementation now lives at packages/domain/src/setup/github-app/pem-utils.ts.
 * This shim keeps existing script imports working without modification.
 *
 * @see mt#1087
 */

export { pemToPkcs8ArrayBuffer } from "@minsky/domain/setup/github-app/pem-utils";
