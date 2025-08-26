- [x] Add `--task` Option to `session get` Command [md#004](#)

- [x] Add `--quiet` Option to `session start` for Programmatic Output [md#006](#)

- [x] Add `minsky tasks create` Command [md#007](#)

- [x] Update `tasks list` to Default to Not-DONE Tasks Only [md#008](#)

- [x] Add `git commit` Command to Stage and Commit Changes [md#009](#)

- [x] ~~Enhance `git pr` Command to Create GitHub PRs and Update Task Status~~ (Command removed - functionality moved to `session pr`) [md#010](#)

- [x] ~~Fix `git pr` Command and Add Proper Tests~~ (Command removed - functionality moved to `session pr`) [md#011](#)

- [x] Add `session update` Command [md#012](#)

- [x] Add Repository Backend Support for Remote Git Repositories [md#014](#)

- [x] Add `session delete` Command [md#015](#)

- [x] Enforce Task Operations in Main Workspace [md#016](#)

- [x] Support Both Task ID Formats in `--task` Option [md#017](#)

- [x] Add `--task` Option to `session dir` Command [md#018](#)

- [x] Implement Test Suite Improvements [md#019](#)

- [x] ~~Add `--task` option to `git pr` command~~ (Command removed - functionality moved to `session pr`) [md#020](#)

- [x] Refactor Large Methods in GitService [md#021](#)

- [x] Fix Session Test Failures and Linting Issues [md#022](#)

- [x] Add Task Specification Path to Task Object [md#023](#)

- [x] Fix `session dir` Command Logic [md#024](#)

- [x] Add PR Merging Commands for Session Workflow [md#025](#)

- [x] Fix Task Spec Paths [md#026](#)

- [x] Auto-detect Session Context in Session Commands [md#027](#)

- [x] Automate Task Status Updates at Key Workflow Points [md#028](#)

- [x] Add `rules` command for managing Minsky rules [md#029](#)

- [x] Setup Project Tooling and Automation [md#030](#)

- [x] Add Filter Messages to `tasks list` Command [md#031](#)

- [x] Auto-Rename Task Spec Files in `tasks create` Command [md#032](#)

- [ ] Enhance Minsky Init Command with Additional Rules [md#033](#)

- [x] Add MCP Support to Minsky [md#034](#)

- [x] Fix Task Creation Workflow to Not Require Task Number in Spec Title [md#035](#)

- [x] Add `session commit` Command to Stage, Commit, and Push All Changes for a Session [md#037](#)

- [x] Make tasks status set prompt for status if not provided [md#038](#)

- [x] Interface-Agnostic Command Architecture [md#039](#)

- [x] Add `--task` Option to `session delete` Command [md#040](#)

- [ ] Write Test Suite for Cursor Rules [md#041](#)

- [x] Add Session Information to Task Details [md#043](#)

- [x] Fix Remaining Test Failures in Minsky [md#044](#)

- [ ] Setup Documentation Tooling [md#045](#)

- [ ] Document Dependency Management Process [md#046](#)

- [x] Configure MCP Server in Minsky Init Command [md#047](#)

- [x] Implement Session-Scoped MCP Server for Workspace Isolation [md#049](#)

- [x] Add Git Commands to MCP Server [md#051](#)

- [x] Add Remaining Task Management Commands to MCP [md#052](#)

- [x] Prevent Session Creation Within Existing Sessions [md#053](#)

- [ ] Configure Husky Hooks for Session Repositories [md#054](#)

- [x] Document and Fix Rule Sync Bug in Minsky CLI [md#055](#)

- [ ] Explore OCI Artifacts for Rule Distribution [md#056](#)

- [ ] Implement TypeScript-based Rule Authoring System [md#057](#)

- [ ] Evaluate zod-matter and Zod for Rule Metadata and Validation [md#058](#)

- [x] Add Centralized Test Mock Utilities [md#059](#)

- [ ] Implement Automatic Test Linting [md#060](#)

- [x] Implement Test Fixture Factory Pattern [md#061](#)

- [x] Improve bun:test TypeScript Declarations [md#062](#)

- [ ] Define and Implement Snapshot Testing Strategy [md#063](#)

- [x] Add Single-Line Description Validation to `minsky rules create` [md#064](#)

- [x] Fix `minsky rules create/update` Description Quoting Bug [md#065](#)

- [x] Investigate and Fix `minsky rules get --format generic` Inconsistency [md#066](#)

- [x] Refactor `minsky-workflow.mdc` Rule into Smaller, Focused Rules [md#067](#)

- [x] AI Guideline: Do Not Over-Optimize Indentation [md#068](#)

- [x] Improve Task ID Permissiveness in Minsky CLI Commands [md#069](#)

- [x] Auto-Detect Current Session/Task in Minsky CLI from Session Workspace [md#070](#)

- [x] Remove Interactive CLI Tests and Establish Core Testing Principles [md#071](#)

- [x] Fix Test Failures and Remaining Linter Errors [md#072](#)

- [x] Fix Adapter Integration Test Failures [md#073](#)

- [x] Implement Auto-Dependency Installation for Session Workspaces [md#074](#)

- [x] Fix Minsky Session Delete Command Cleanup [md#075](#)

- [x] Complete Interface-Agnostic Architecture Migration [md#076](#)

- [x] Implement Structured Logging System [md#077](#)

- [x] Fix minsky rules CLI to operate on rules in the current workspace (main or session) [md#078](#)

- [x] Task: Revisit GitService Testing Strategy [md#079](#)

- [x] Review Workspace and Repository Path Concepts [md#080](#)

- [x] Disable Debug Logs Unless Debug Log Level is Explicitly Set [md#081](#)

- [x] Add Context Management Commands for Environment-Agnostic AI Collaboration [md#082](#)

- [x] Fix Bugs in Minsky Rules CLI Command [md#083](#)

- [x] Extend Auto-Detection to Additional Commands [md#084](#)

- [x] Migrate CLI adapter tests to test domain methods instead [md#085](#)

- [x] Formalize Core Minsky Concepts and Relationships [md#086](#)

- [x] Implement Unified Session and Repository Resolution [md#087](#)

- [x] Standardize Repository URI Handling [md#088](#)

- [x] Align CLI Commands with Revised Concepts [md#089](#)

- [ ] Prepare for Future Non-Filesystem Workspaces [md#090](#)

- [x] Enhance SessionDB with Multiple Backend Support [md#091](#)

- [x] Add Session PR Command and Improve Git Prepare-PR Interface [md#092](#)

- [x] Implement Consistent CLI Error Handling Across All Commands [md#093](#)

- [x] Fix git prepare-pr Branch Naming Issues [md#095](#)

- [x] Improve CLI Adapter Structure for Shared Options [md#096](#)

- [x] Standardize Option Descriptions Across CLI and MCP Adapters [md#097](#)

- [x] Create Shared Adapter Layer for CLI and MCP Interfaces [md#098](#)

- [x] Implement Environment-Aware Logging [md#099](#)

- [x] Align MCP API with CLI Implementation and Remove Placeholders [md#100](#)

- [x] Improve Domain Module Testability with Proper Dependency Injection [md#101](#)

- [x] Refactor Domain Objects to Follow Functional Patterns [md#102](#)

- [x] Enhance Test Utilities for Better Domain Testing [md#103](#)

- [x] Re-implement Disabled Integration Tests [md#104](#)

- [x] Add Session Inspect Subcommand for Current Session Detection [md#105](#)

- [x] Refactor SessionDB to Functional Patterns (Subtask of #102) [md#106](#)

- [x] Refactor GitService to Functional Patterns (Subtask of #102) [md#107](#)

- [x] Refactor TaskService to Functional Patterns (Subtask of #102) [md#108](#)

- [x] Fix inconsistent repository name normalization between SessionDB and GitService [md#109](#)

- [x] Create a Complete Test Inventory and Classification System [md#110](#)

- [x] Build Core Mock Compatibility Layer [md#111](#)

- [x] Implement Comprehensive Test Utility Documentation [md#112](#)

- [x] Implement Automated Test Migration Script [md#113](#)

- [x] Migrate High-Priority Tests to Native Bun Patterns [md#114](#)

- [x] Implement Dependency Injection Test Patterns [md#115](#)

- [x] Improve CI/CD Test Stability with Progressive Migration [md#116](#)

- [x] Fix Session Update Command Implementation [md#117](#)

- [x] Fix rule format errors in rules.ts [md#118](#)

- [x] Fix MCP Rules.list Command to Exclude Rule Content [md#119](#)

- [x] Add --with-inspector Option to `mcp start` Command [md#120](#)

- [x] Enhance `tasks get` Command to Support Multiple Task IDs [md#121](#)

- [x] Improve Error Handling for MCP Server Port Conflicts [md#122](#)

- [x] Add Repository Path Parameter to MCP Server [md#124](#)

- [x] Implement CLI Bridge for Shared Command Registry [md#125](#)

- [x] Add Task Specification Content Reading Capability [md#126](#)

- [x] Fix FastMCP Method Registration Issues [md#127](#)

- [x] Update fastmcp Dependency to v3.3.0 [md#128](#)

- [x] Implement Local DB Tasks Backend [md#129](#)

- [x] System Stability Post-CLI Bridge [md#130](#)

- [x] Fix TypeScript Issues in DI Helpers [md#131](#)

- [x] Fix Session Get Command Output Format [md#132](#)

- [x] Fix CLI Flag Naming Inconsistency for Task Identification [md#133](#)

- [x] Task: Resolve Remaining Test Race Conditions and Stability Issues [md#134](#)

- [x] Task: Fix `minsky tasks create` Verbose Content Extraction Bug [md#135](#)

- [x] Fix All Linter Warnings [md#136](#)

- [ ] Task: Implement Todoist Backend Integration [md#137](#)

- [x] Add GitHub Issues Support as Task Backend [md#138](#)

- [x] Add Session Context Autodetection [md#139](#)

- [x] Fix dependency installation error in session startup [md#140](#)

- [x] Implement Repository Configuration System [md#141](#)

- [x] Test dependency installation fix [md#142](#)

- [x] Upgrade ESLint from v8.57.1 to v9.29.0 [md#143](#)

- [x] Fix Session PR and Git Prepare-PR Commands to Implement Proper Prepared Merge Commit Workflow [md#144](#)

- [ ] Import Existing GitHub Issues Under Minsky Management [md#145](#)

- [x] Fix Session PR Command Import Bug [md#146](#)

- [x] Implement Backend Migration Utility [md#147](#)

- [x] Fix session approve command to not depend on session workspace state [md#149](#)

- [x] Add --body-path Option and Required Title/Body to Session PR Command [md#150](#)

- [x] Fix Task Create Command Content Truncation Issue [md#151](#)

- [x] Refactor Task Spec Document Title Format [md#152](#)

- [x] Fix Task Status Selector to Show Current Status as Default [md#153](#)

- [x] Add BLOCKED Status Support [md#155](#)

- [x] Remove .js Extensions from TypeScript Imports [md#156](#)

- [x] Review and Modernize Project Documentation Architecture [md#157](#)

- [x] Implement Session-Aware Versions of Cursor Built-in Tools [md#158](#)

- [ ] Implement Comprehensive ESLint Configuration [md#159](#)

- [x] Add AI Completion Backend with Multi-Provider Support [md#160](#)

- [x] Add GitHub PR Workflow as Alternative to Prepared Merge Commits [md#161](#)

- [ ] Research and Design Comprehensive AI Evals Framework for Rules, Context Construction, and Agent Operations [md#162](#)

- [x] Add --title and --description Options to tasks create Command [md#163](#)

- [x] Add Bun Binary Builds and GitHub Actions Release Workflow [md#164](#)

- [x] Fix Session Lookup Bug Where Sessions Exist on Disk But Not in Database [md#165](#)

- [x] Remove @types/commander and Fix Revealed TypeScript Errors [md#166](#)

- [x] Fix Task Creation CLI Bug - "status is not defined" Error [md#167](#)

- [x] Evaluate and Deduplicate Error Messages [md#169](#)

- [x] Comprehensive Session Database Architecture Fix [md#176](#)

- [x] Implement Cross-Cutting Session Auto-Detection [md#173](#)

- [x] Review Session PR Workflow Architecture [md#174](#)

- [ ] Add AI-powered task management subcommands [md#175](#)

- [ ] Review and improve session update command design and merge conflict handling [md#177](#)

- [x] Establish Codemod Best Practices and Standards [md#178](#)

- [ ] Investigate Embeddings/RAG for Search-Related MCP Tools [md#179](#)

- [x] Investigate and improve configuration system design [md#181](#)

- [x] Add AI-Powered Rule Suggestion MVP [md#182](#)

- [x] Fix Task Operations to Use Main Workspace [md#183](#)

- [ ] Restore Full Test Suite for `init` Command [md#185](#)

- [x] Task: Integrate JsonFileTaskBackend with CLI Commands [md#187](#)

- [ ] Import Existing GitHub Issues Under Minsky Management [md#188](#)

- [x] Restore Init Command Interactivity [md#189](#)

- [ ] Design Containerized Session Workspace Architecture [md#190](#)

- [x] Replace Direct process.exit() Calls with Custom exit() Utility [md#194](#)

- [x] Eliminate MCP Command Duplication by Implementing Proper Bridge Integration [md#201](#)

- [ ] Rule Suggestion Evaluation and Optimization [md#202](#)

- [x] Improve Session PR Command Output and Body Generation [md#203](#)

- [x] Add CLOSED task status for irrelevant tasks [md#207](#)

- [x] Improve user-friendly output formatting for tasks delete command [md#208](#)

- [x] Investigate and Evaluate Configuration System Architecture [md#209](#)

- [x] Fix CLI output suppression in session workspaces [md#210](#)

- [x] Investigate normalizeRepoName function and repo name formatting inconsistencies [md#214](#)

- [ ] Implement Core Agent Loop for Independent Minsky Operation [md#216](#)

- [x] Execute session migration to simplified path structure [md#217](#)

- [x] Remove redundant repoPath field from session records [md#218](#)

- [x] Add specific linting rules for underscore prefixes in variable declarations [md#219](#)

- [x] Improve Test Isolation and Reliability [md#220](#)

- [x] Better Merge Conflict Prevention [md#221](#)

- [x] Enhanced Error Messages and Debugging [md#223](#)

- [x] Restructure configuration to colocate credentials with their components [md#224](#)

- [x] Remove temporary SessionDB compatibility layer and update all imports [md#225](#)

- [ ] Implement AI-Powered Session Review Workflow [md#226](#)

- [x] Extend conflict detection to comprehensive git workflow protection [md#227](#)

- [x] Exclude CLOSED tasks from default tasks list output [md#228](#)

- [x] Evaluate mandatory task-session association requirement [md#229](#)

- [x] Investigate session workspace disk usage and optimize node_modules storage [md#230](#)

- [x] Implement session PR refresh functionality [md#231](#)

- [ ] Improve session PR conflict resolution workflow with auto-resolution and better UX [md#232](#)

- [ ] Setup semantic-release with conventional commits for automated GitHub releases and binary builds [md#233](#)

- [ ] Implement Dagger CI Pipeline with Hybrid Development Workflow [md#234](#)

- [x] Add metadata support to tasks (subtasks, priority, dependencies) [md#235](#)

- [x] Fix test failures and infinite loops revealed during Task #166 verification [md#236](#)

- [ ] Implement Hierarchical Task System with Subtasks and Dependencies [md#237](#)

- [ ] Phase 1: Implement Basic Subtask Support with Parent-Child Relationships [md#238](#)

- [ ] Phase 2: Implement Task Dependencies and Basic Task Graphs [md#239](#)

- [ ] Phase 3: Enhanced Planning/Execution Separation with Checkpointing [md#240](#)

- [ ] Advanced Visualization and Database Migration [md#243](#)

- [x] Implement comprehensive test isolation framework to eliminate suite interference [md#244](#)

- [x] Complete configuration system standardization and cleanup [md#245](#)

- [x] Investigate and Improve Session-Aware Edit/Reapply MCP Tools with Fast-Apply APIs [md#249](#)

- [ ] Investigate and Implement Session-Aware Code Search MCP Tools with Fast Retrieval APIs [md#250](#)

- [ ] Add Mobile/Voice Interface for Minsky Operations [md#251](#)

- [ ] Design and implement task management UI system [md#252](#)

- [-] Implement Task Similarity Search Using Embeddings [md#253](#)

- [ ] Implement Commit History Similarity Search Using Embeddings [md#254](#)

- [x] Fix session dependency installation error [md#255](#)

- [ ] Implement Context-Aware Tool Management System [md#256](#)

- [ ] Design multi-agent cybernetic supervision system for AI-to-AI task oversight [md#258](#)

- [x] Add `minsky tasks delete` Command [md#205](#)

- [ ] Implement AI-Powered PR Content Generation for Session and Git Commands [md#273](#)

- [x] Improve CLI error messages for user-friendly output [md#259](#)

- [ ] Implement prompt templates for AI interaction [md#260](#)

- [ ] Explore consolidating ESLint rules with codemods [md#262](#)

- [ ] Investigate PaaS Deployment Options for Minsky Sessions [md#263](#)

- [ ] Explore Adding Standard API Interface Alongside MCP Using Shared Command Registry [md#264](#)

- [x] Refactor configuration system parameter naming and improve developer ergonomics [md#265](#)

- [x] Investigate Enhanced Storage Backend Factory Redundancy [md#266](#)

- [x] Integrate logger with configuration system to eliminate process.env access [md#267](#)

- [ ] Complete AST-Only Codemod Framework Development [md#268](#)

- [x] Eliminate all testing-boundaries violations across the test suite [md#272](#)

- [x] Fix test isolation issues causing global state interference [md#269](#)

- [x] Restructure and improve test architecture for clarity and maintainability [md#270](#)

- [x] Find and Fix All Unsafe Type Casts (as any) in Codebase [md#271](#)

- [x] Fix Command Registry Type Erasure Architecture [md#274](#)

- [x] Store PR Existence in Session Records for Optimized Session Approval [md#275](#)

- [x] Optimize test suite quality and pass rate post-isolation [md#276](#)

- [ ] Implement Stacked PR Workflow for Session Dependencies [md#277](#)

- [ ] Implement multi-layered agent memory system for persistent learning and knowledge accumulation [md#279](#)

- [x] Cleanup excessive 'as unknown' assertions to improve TypeScript effectiveness [md#280](#)

- [x] Fix systematic verification failures in AI responses [md#281](#)

- [x] Port MCP Server from FastMCP to Official MCP SDK [md#282](#)

- [x] Separate Task ID Storage from Display Format [md#283](#)

- [ ] Integrate Task Graph System with Workflow Orchestration [md#284](#)

- [x] Fix session PR title duplication bug [md#285](#)

- [x] Fix MCP Server and CLI Issues Post Task 282 [md#286](#)

- [x] Complete Task #286 Follow-up: Inspector Upgrade and FastMCP Cleanup [md#287](#)

- [x] Implement Template-Based Rules Generation System [md#289](#)

- [x] Implement automatic git stash handling for merge conflicts in session approve [md#292](#)

- [ ] Add session chat interface context UI elements [md#293](#)

- [x] Audit codebase for git command timeout issues and create ESLint rule [md#294](#)

- [x] Implement ESLint Jest Pattern Prevention [md#300](#)

- [x] Implement Custom Type-Safe Configuration System [md#295](#)

- [ ] Explore Exposing Rules and Documentation as MCP Resources with Template Integration [md#302](#)

- [x] Improve Task Operations Workflow with Auto-Commit for Markdown Backend [md#303](#)

- [x] Fix special workspace auto-commit sync issue [md#304](#)

- [x] Systematic Jest Pattern Migration & ESLint Rule Re-enablement [md#305](#)

- [x] Migrate codebase from TaskBackendRouter to workspace-resolving backends [md#306](#)

- [x] Explore adding session lint command for pre-commit issue detection [md#307](#)

- [x] Add validation to session PR title argument to prevent body content in title [md#308](#)

- [x] Improve file operation tools: auto-create directories and semantic error messages [md#309](#)

- [x] Enhance session_read_file tool with line range support to match Cursor's built-in read_file functionality [md#312](#)

- [x] Implement session-aware move_file and rename_file MCP tools [md#313](#)

- [x] Implement External Task Database for Metadata Storage [md#315](#)

- [x] Enable max-lines ESLint rule with two-phase approach (400 warning, 1500 error) [md#316](#)

- [x] Investigate and fix task operations hanging issues [md#317](#)

- [x] Fix all linter errors [md#318](#)

- [x] Fix Special Workspace and Main Workspace Synchronization for Task Operations (renamed from 310) [md#319](#)

- [ ] Fix all linter errors in codebase [md#320](#)

- [ ] AI-Powered Project Analysis for Enhanced Init Command [md#321](#)

- [x] Refactor MCP Tools with Type Composition to Eliminate Argument Duplication [md#322](#)

- [x] Create AI Provider Model Data Fetching System [md#323](#)

- [ ] Add MCP Client Registration Functionality [md#324](#)

- [x] Task Backend Architecture Analysis and Design Resolution [md#325](#)

- [ ] Explore embedding Outerbase DB explorer for database inspection [md#326](#)

- [ ] Analyze and architect general message/prompt system supporting human and AI agents across contexts [md#327](#)

- [x] Extend type composition refactoring to other MCP command domains [md#328](#)

- [x] Create Domain-Wide Schema Libraries for Cross-Interface Type Composition [md#329](#)

- [x] Apply Type Composition Patterns to CLI Adapters [md#335](#)

- [x] Extend Type Composition Refactoring to All MCP Command Domains [md#331](#)

- [x] Implement Pre-Commit Secret Scanning with Husky [md#341](#)

- [x] Add Git Conflict Detection Command with Structured Output [md#342](#)

- [x] Exclude Content Field from Rules.list Command Output [md#345](#)

- [x] Move AI Commands from Core to AI Category [md#347](#)

- [ ] Analyze Command Registration Architecture for Simplification [md#348](#)

- [ ] Analyze Cursor Chat History to Understand Agent OODA Loop Logic [md#349](#)

- [ ] Explore Active Sessions Command and Task/Session Equivalence Analysis [md#350](#)

- [x] Improve configuration validation system: integrate proper logging, add strictness controls, improve type safety, and document behavior for unknown config fields [md#351](#)

- [ ] Implement Session Reapply Tool with Fast-Apply Recovery [md#354](#)

- [x] Make tasks status set do the same stash/commit/push/stash flow as session operations like approve in description sessions [md#355](#)

- [x] Implement Multi-Backend Task System Architecture [md#356](#)

- [x] Integrate GitHub Issues Backend with Repository Backend Architecture [md#357](#)

- [x] Restructure Session PR Command with Explicit Subcommands [md#359](#)

- [x] Implement Session Outdated Detection and Display [md#360](#)

- [ ] Explore Automated Session Sync Workflow on PR Merge [md#361](#)

- [x] Truncate verbose git commands in error messages [md#362](#)

- [ ] Implement Linear Backend for Multi-Backend Task System [md#363](#)

- [x] Fix missing session.pr command in template system causing 5 template generation failures [md#364](#)

- [x] Fix Session Start with Qualified Task IDs [md#368](#)

- [ ] Multi-Backend System Polish & Optimization [md#369](#)

- [ ] Investigate Language Server Integration for Semantic Code Analysis MCP Tools [md#384](#)

- [ ] Fix git commands not being available over MCP by uncommenting the registerGitTools call in the MCP command registration [md#386](#)

- [x] Add MCP tool for sessiondb querying [md#387](#)

- [x] Audit and fix task backend consistency across session operations [md#388](#)

- [ ] Refactor session dependencies for unified dependency injection pattern [md#389](#)

- [ ] Add AI telemetry and verbose output for debugging AI requests [md#390](#)

- [ ] Add config commands to MCP server [md#391](#)

- [+] Systematic Global Module Mock Cleanup [md#392](#)

- [ ] Testable Design Pattern Expansion [md#394](#)

- [ ] Dependency Injection Enhancement for Test Reliability [md#395](#)

- [x] Test Architecture Documentation and Guidelines [md#396](#)

- [ ] Improve test mock filesystem approach with external libraries [md#398](#)

- [ ] Explore alternative task entry methods and reference resolution [md#400](#)

- [x] Improve SessionDB migration command and plan PostgreSQL cutover [md#401](#)

- [x] Final test of the complete fix [md#402](#)

- [ ] Implement Drizzle Kit migrations for PostgreSQL SessionDB [md#403](#)

- [ ] Implement --set-default to write config and back it up; update/remove tests referencing session.branch [md#405](#)

- [ ] Complete TaskBackend enum refactoring across codebase [md#406](#)

- [ ] Extract Shared Database Service for Sessions, Tasks, and Embeddings [md#407](#)

- [ ] Implement GitHub repository quality guardrails configuration [md#408](#)

- [x] Implement session pr open command for GitHub backend [md#409](#)

- [x] Fix task status update to use main workspace and configure main workspace path [md#410](#)

- [+] Continue Systematic ESLint-Guided Filesystem Violation Fixes [md#397](#)

- [x] Fix session start to auto-detect GitHub remote when default_repo_backend is github [md#435](#)

- [x] Create comprehensive integration tests for session.edit_file MCP tool with Cursor edit_file parity verification [md#399](#)

- [x] Implement conventional commit title generation for session pr create command [md#413](#)

- [x] Fix post-merge test regressions after md#397 merge [md#414](#)

- [ ] Improve CLI Error Summarization with Structured Detection [md#415](#)

- [x] CLI demo for session.edit_file tool [md#416](#)

- [x] Pass instruction through end-to-end for session.edit_file [md#417](#)

- [x] Add dry-run support to session.edit_file [md#418](#)

- [x] CLI ergonomics for session.edit_file [md#419](#)

- [ ] AI Resilience module for error/backoff/circuit breaker (optional adoption) [md#420](#)

- [x] Improve session PR merge output: hide low-value Octokit HTTP logs unless --debug; show concise approval/branch-protection status [md#421](#)

- [ ] Extract reusable result-handling utilities for list/get commands [md#422](#)

- [x] Auto-commit and push for tasks_create (Minsky Tasks) [md#423](#)

- [x] Disable [DEBUG] logs for session start unless debug logging is enabled [md#425](#)

- [ ] Automated Migrations Strategy (Boot-time/Orchestrated) and Remote Runs [md#426](#)

- [+] Plan: Automated Embedding Sync/Update Process [md#432](#)

- [+] Plan: Support Postgres→Postgres SessionDB Migration [md#433](#)

- [+] Plan: Explore Migrating from SQLite to PGlite [md#434](#)

- [x] Enforce conventional-commit title validation on session pr edit [md#427](#)

- [+] Implement md#315 Phase 1: backfill normalized task_id and add unique constraint; prepare migration command scaffolding [md#428](#)

- [ ] FS DI refactor: explicit injection across modules and test suite [md#430](#)

- [ ] # Implement programmatic pending Drizzle migrations detection [md#431](#)

- [x] feat(session commit): show commit summary and changed files [md#436](#)

- [+] RFC: Transitioning Minsky task system to backend-SoT with DB overlay; deprecate tasks.md; MCP tools for agent edits; GI sync path. [md#437](#)

- [x] Improve task search output to include title, spec path, and other relevant information by default, with additional details behind a flag. Update both CLI and JSON output formats. [md#438](#)

- [x] Implement Minimal DB-Only Tasks Backend (db#) and Manual Export Command [md#439](#)

- [ ] Define Phased Future Direction: Backend-SoT + DB Overlay, MCP‑First (Minimal Path) [md#440](#)

- [ ] Implement MCP-Based Subagent System with Task Graph Integration [md#441](#)

- [ ] Implement Task Routing System for Automated Implementation Planning [md#442](#)

- [x] Upgrade to multi-backend TaskService with proper qualified ID routing [md#443](#)

- [x] Improve task search to support filtering by status (and default hide DONE/CLOSED unless --all), consistent with `tasks list`. [md#444](#)

- [x] Implement embedding-based rule suggestion (replace AI-based) reusing tasks embeddings infra [md#445](#)

- [ ] Add cross-cutting reranking support to embeddings infra using Morph reranking API [md#446](#)

- [x] Extract generic similarity search service with pluggable backends and fallback chain [md#447](#)

- [ ] Explore task templates for different backends [md#448](#)

- [ ] Extend embeddings infra: server-side filtering and index-optimized queries [md#449](#)

- [ ] Explore embedding score normalization and distance metrics for similarity search (tasks & rules) [md#450](#)

- [ ] Explore embedding content optimization strategies for similarity search [md#451](#)

- [+] Resolve merge conflicts for status-filtering PR in session workspace [md#453](#)

- [+] Resolve merge conflicts after tasks search status filtering work; ensure session uses GitHub backend. [md#452](#)

- [+] Investigate AI Integration Test Validation Logic [md#456](#)

- [ ] Context Visualization Redesign [md#461](#)

- [ ] Rethink test organization for consistency and principled structure [md#457](#)

- [ ] Add Missing Test Cases [md#458](#)

- [ ] Create Test Architecture Documentation [md#459](#)

- [ ] Implement test coverage enforcement in pre-commit hooks [md#460](process/tasks/md#460-implement-test-coverage-enforcement-in-pre-commit-hooks.md)

- [ ] Remove hardcoded 'markdown' backend defaults [md#461](process/tasks/md#461-remove-hardcoded-markdown-backend-defaults.md)

- [ ] Investigate "seek human input" / "ask expert" tool and Agent Inbox pattern; design DB-backed queue and turn-taking semantics (research-only) [md#454](process/tasks/md#454-investigate-seek-human-input-ask-expert-tool-and-agent-inbox-pattern-design-db-backed-queue-and-turn-taking-semantics-research-only-.md)

- [ ] Formalize task types (speculative/investigative/experimental) and explore CLI/PR integration (research-only) [md#455](process/tasks/md#455-formalize-task-types-speculative-investigative-experimental-and-explore-cli-pr-integration-research-only-.md)

- [ ] Investigate rearchitecting Minsky around InversifyJS for proper dependency injection [md#462](process/tasks/md#462-investigate-rearchitecting-minsky-around-inversifyjs-for-proper-dependency-injection.md)

- [ ] Test Task Creation After Bug Fix [md#464](process/tasks/md#464-test-task-creation-after-bug-fix.md)

- [ ] Implement Task Editing Commands for CLI and MCP [md#466](process/tasks/md#466-implement-task-editing-commands-for-cli-and-mcp.md)

- [x] Mock out logger in all tests to use in-memory logger instead of CLI output to eliminate test noise [md#467](process/tasks/md#467-mock-out-logger-in-all-tests-to-use-in-memory-logger-instead-of-cli-output-to-eliminate-test-noise.md)

- [+] Comprehensive test infrastructure improvements: integration test cleanup, quality monitoring, documentation, noise prevention, and debugging safety nets [md#468](process/tasks/md#468-comprehensive-test-infrastructure-improvements-integration-test-cleanup-quality-monitoring-documentation-noise-prevention-and-debugging-safety-nets.md)