/**
 * Rules Compile Module
 *
 * Multi-target rule compilation architecture.
 */

export type { CompileTarget, CompileResult, TargetOptions } from "./types";
export { CompileService, createCompileService } from "./compile-service";
export { agentsMdTarget } from "./targets/agents-md";
export { claudeMdTarget } from "./targets/claude-md";
export { cursorRulesTarget } from "./targets/cursor-rules";