/**
 * Presence domain module — task-grain (and future session/subagent-grain) agent presence.
 *
 * mt#2562: canonical cross-grain presence/claim schema.
 */

export type {
  PresenceClaim,
  AnnotatedPresenceClaim,
  UpsertPresenceClaimInput,
  PresenceSubjectKind,
} from "./types";
export { PRESENCE_CLAIM_TTL_MS, PRESENCE_CLAIM_REAP_MS } from "./types";

export type { PresenceClaimRepository } from "./repository";
export {
  DrizzlePresenceClaimRepository,
  buildPresenceClaimRepository,
  toPresenceClaim,
} from "./repository";
