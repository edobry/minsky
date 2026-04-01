export * from "./git";
export * from "./tasks";
export * from "./rules";
export * from "./repo-utils";
export * from "./workspace";
export * from "./init";

// Export Git-related functions
export {
  GitService,
  createPullRequestFromParams,
  preparePrFromParams,
  mergePrFromParams,
  cloneFromParams,
  branchFromParams,
  pushFromParams,
  commitChangesFromParams,
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
} from "./git";

// Export legacy SessionDB and related functions
export {
  type SessionProviderInterface,
  type Session,
  sessionGet,
  sessionList,
  sessionStart,
  sessionUpdate,
  sessionDelete,
  sessionDir,
  sessionApprove,
  createSessionProvider,
  sessionInspect,
  sessionReviewFromParams as sessionReview,
  type SessionReviewParams,
  type SessionReviewResult,
} from "./session";

// Export the functional session module
export {
  createSessionProvider as createFunctionalSessionProvider,
  type SessionDbState,
  type SessionDbFileOptions,
} from "./session/index";
