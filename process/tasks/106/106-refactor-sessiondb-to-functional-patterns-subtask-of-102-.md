# Task #106: Refactor SessionDB to Functional Patterns (Subtask of #102)

## Context

This task is a subtask of #102 (Refactor Domain Objects to Follow Functional Patterns). It focuses on refactoring the `SessionDB` module to align with functional programming principles. This is part of a larger effort to improve code testability, maintainability, and predictability within the domain layer.

## Requirements

1.  **Pure Functions for `SessionDB` Operations**:

    - Convert all methods in `SessionDB` (e.g., `listSessions`, `getSession`, `addSession`, `updateSession`, `deleteSession`, `getRepoPath`, `getSessionWorkdir`) into pure functions.
    - These functions should not have side effects (e.g., no direct file I/O or modification of external state).
    - State (such as the content of `session-db.json`) must be passed explicitly as an argument to these functions.
    - Functions that modify state should return a new state representation instead of mutating the input state.

2.  **Explicit State Management**:

    - The in-memory representation of the session database (currently handled within `SessionDB` class instances) should be managed explicitly.
    - Functions will take the current DB state as input and return the updated DB state as output.

3.  **Isolation of Side Effects**:

    - All file system operations (reading from and writing to `session-db.json`) must be isolated from the core pure functions.
    - These side effects should be handled at the application's boundaries or through a dedicated, controlled interface (e.g., a new service or a set of specific I/O functions) that the pure functions can instruct.

4.  **Functional Composition**:

    - Where appropriate, use functional composition techniques to build more complex operations from simpler, pure functions. This might involve creating smaller helper functions.

5.  **Update Tests**:

    - Thoroughly update or rewrite all existing unit and integration tests for `SessionDB`.
    - Tests for pure functions should focus on input-output validation without needing to mock extensive dependencies.
    - Tests for the parts of the system that handle side effects will require appropriate mocking of the I/O operations.

6.  **Maintain Compatibility (where feasible)**:
    - While refactoring, consider the existing dependents of `SessionDB` and strive to minimize disruptive changes to their interfaces, if possible. If significant interface changes are necessary, they should be documented.

## Detailed Implementation Plan

[COMPLETED] All items in this section have been implemented.

## Worklog

- **Initial Implementation & Workspace Correction**:
  - Implemented the functional refactoring of SessionDB, creating `session-db.ts` (pure functions), `session-db-io.ts` (I/O), and `session-adapter.ts` (compatibility).
  - Initially, changes were made in the main workspace. This was corrected by:
    - Creating the `task#106` session workspace directories.
    - Copying implemented files to the session workspace.
    - Committing changes to the `pr/task#106` branch.
    - Reverting changes from the main workspace.
- **Testing**:
  - Wrote `session-db.test.ts` for pure functions.
  - Wrote `session-adapter.test.ts` for the compatibility adapter.
  - All tests are passing after fixing an issue with `repoPath` generation in tests.
- **Linter Errors**:
  - Addressed several linter errors related to imports and type definitions in the new session modules.
  - Attempted to fix TypeScript linter errors in test files related to Bun test type augmentations. While runtime tests pass, some type-checking errors for `expect` matchers persist. These are deemed non-blocking for now.
- **PR Preparation**:
  - Generated PR summary using `minsky git summary`.
  - Saved PR description to `process/tasks/106/pr.md`.
  - Committed PR description and an update to `process/tasks.md`.
  - Updated `CHANGELOG.md` with details of the refactoring.
  - All changes pushed to `pr/task#106`.
  - Task status is IN-REVIEW.

## Remaining Work

- **Resolve Persistent Linter Errors in Test Files (Optional/Follow-up)**:
  - Investigate the root cause of the Bun test type augmentation issues in `*.test.ts` files (e.g., `Property 'not' does not exist on type '{...}'`, `Property 'toHaveProperty' does not exist on type '{...}'`). This might involve deeper TypeScript configuration or specific Bun type handling.
- **PR Creation on Git Platform**: Create the actual Pull Request on GitHub (or equivalent platform) from the `pr/task#106` branch.
- **Code Review**: Facilitate and respond to code review.
- **Merge PR**: After approval, merge the PR.
- **Final Task Status Update**: Update task status to DONE via `minsky tasks status set 106 DONE` after merge.

## Detailed Implementation Plan

### 1. State and Type Definitions

1. Define a clear `SessionDbState` type to represent the state of the database:

   ```typescript
   export interface SessionDbState {
     sessions: SessionRecord[];
     baseDir: string;
   }
   ```

2. Create utility types needed for function parameter definitions:
   ```typescript
   export type SessionDbConfig = {
     dbPath?: string;
     baseDir?: string;
   };
   ```

### 2. Pure Function Implementations

1. Create the following pure functions, each separated from I/O operations:

   a. **Core Session Operations**:

   ```typescript
   export function listSessionsFn(state: SessionDbState): SessionRecord[] {
     return [...state.sessions];
   }

   export function getSessionFn(state: SessionDbState, sessionName: string): SessionRecord | null {
     return state.sessions.find((s) => s.session === sessionName) || null;
   }

   export function getSessionByTaskIdFn(
     state: SessionDbState,
     taskId: string
   ): SessionRecord | null {
     const normalize = (id: string | undefined) => (id?.startsWith("#") ? id : `#${id}`);
     const normalizedInput = normalize(taskId);
     return state.sessions.find((s) => normalize(s.taskId) === normalizedInput) || null;
   }

   export function addSessionFn(state: SessionDbState, newSession: SessionRecord): SessionDbState {
     return {
       ...state,
       sessions: [...state.sessions, newSession],
     };
   }

   export function updateSessionFn(
     state: SessionDbState,
     sessionName: string,
     updates: Partial<Omit<SessionRecord, "session">>
   ): SessionDbState {
     const sessionIndex = state.sessions.findIndex((s) => s.session === sessionName);
     if (sessionIndex === -1) return state;

     const { session: _, ...safeUpdates } = updates as any;
     const updatedSessions = [...state.sessions];
     updatedSessions[sessionIndex] = { ...updatedSessions[sessionIndex], ...safeUpdates };

     return {
       ...state,
       sessions: updatedSessions,
     };
   }

   export function deleteSessionFn(state: SessionDbState, sessionName: string): SessionDbState {
     const sessionIndex = state.sessions.findIndex((s) => s.session === sessionName);
     if (sessionIndex === -1) return state;

     const updatedSessions = [...state.sessions];
     updatedSessions.splice(sessionIndex, 1);

     return {
       ...state,
       sessions: updatedSessions,
     };
   }
   ```

   b. **Repository Path Operations**:

   ```typescript
   export function getRepoPathFn(state: SessionDbState, record: SessionRecord): string {
     if (!record.repoName || !record.session) {
       if (record.repoPath) return record.repoPath;
       if (record.workdir) return record.workdir;
       throw new Error("Invalid session record: missing repoName or session");
     }

     // Determine the path based on the provided record
     const newPath = join(state.baseDir, record.repoName, "sessions", record.session);

     // If the record already has a repoPath, return that
     if (record.repoPath) return record.repoPath;

     // Default to the new path structure
     return newPath;
   }

   export function getSessionWorkdirFn(state: SessionDbState, sessionName: string): string | null {
     const session = getSessionFn(state, sessionName);
     if (!session) return null;

     return getRepoPathFn(state, session);
   }

   export function getNewSessionRepoPathFn(
     state: SessionDbState,
     repoName: string,
     sessionId: string
   ): string {
     return join(state.baseDir, repoName, "sessions", sessionId);
   }
   ```

### 3. I/O Operations Module

1. Create a separate module for I/O operations:

   ```typescript
   export async function readSessionDbFile(dbPath: string): Promise<SessionRecord[]> {
     try {
       if (!existsSync(dbPath)) return [];
       const data = await readFile(dbPath, "utf8");
       const sessions = JSON.parse(data);

       // Migrate existing sessions to include repoName
       return sessions.map((session: SessionRecord) => {
         if (!session.repoName && session.repoUrl) {
           session.repoName = normalizeRepoName(session.repoUrl);
         }
         return session;
       });
     } catch (e) {
       return [];
     }
   }

   export async function writeSessionDbFile(
     dbPath: string,
     sessions: SessionRecord[]
   ): Promise<void> {
     try {
       await ensureDbDir(dbPath);
       await writeFile(dbPath, JSON.stringify(sessions, null, 2));
     } catch (error) {
       console.error(
         `Error writing session database: ${error instanceof Error ? error.message : String(error)}`
       );
     }
   }

   export async function ensureDbDir(dbPath: string): Promise<void> {
     const dbDir = join(dbPath, "..");
     await mkdir(dbDir, { recursive: true });
   }

   export async function repoExistsFn(path: string): Promise<boolean> {
     try {
       await access(path);
       return true;
     } catch (err) {
       return false;
     }
   }
   ```

### 4. Factory Function and State Initialization

1. Create a functional factory that initializes state and wires everything together:

   ```typescript
   export function createSessionDbState(
     config?: SessionDbConfig
   ): SessionDbState & { dbPath: string } {
     const xdgStateHome =
       process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");

     const dbPath = config?.dbPath || join(xdgStateHome, "minsky", "session-db.json");
     const baseDir = config?.baseDir || join(xdgStateHome, "minsky", "git");

     return {
       sessions: [],
       baseDir,
       dbPath,
     };
   }
   ```

### 5. Interface Adapter for Backward Compatibility

1. Create an adapter that implements the `SessionProviderInterface` using our new pure functions:

   ```typescript
   export class SessionDbAdapter implements SessionProviderInterface {
     private dbPath: string;
     private baseDir: string;

     constructor(dbPath?: string) {
       const state = createSessionDbState({ dbPath });
       this.dbPath = state.dbPath;
       this.baseDir = state.baseDir;
     }

     async listSessions(): Promise<SessionRecord[]> {
       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       return listSessionsFn(state);
     }

     async getSession(session: string): Promise<SessionRecord | null> {
       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       return getSessionFn(state, session);
     }

     async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
       try {
         const sessions = await readSessionDbFile(this.dbPath);
         const state: SessionDbState = { sessions, baseDir: this.baseDir };
         return getSessionByTaskIdFn(state, taskId);
       } catch (error) {
         console.error(
           `Error finding session by task ID: ${error instanceof Error ? error.message : String(error)}`
         );
         return null;
       }
     }

     async addSession(record: SessionRecord): Promise<void> {
       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       const newState = addSessionFn(state, record);
       await writeSessionDbFile(this.dbPath, newState.sessions);
     }

     async updateSession(
       session: string,
       updates: Partial<Omit<SessionRecord, "session">>
     ): Promise<void> {
       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       const newState = updateSessionFn(state, session, updates);
       await writeSessionDbFile(this.dbPath, newState.sessions);
     }

     async deleteSession(session: string): Promise<boolean> {
       try {
         const sessions = await readSessionDbFile(this.dbPath);
         const state: SessionDbState = { sessions, baseDir: this.baseDir };
         const originalLength = state.sessions.length;
         const newState = deleteSessionFn(state, session);

         if (newState.sessions.length === originalLength) {
           return false; // No session was deleted
         }

         await writeSessionDbFile(this.dbPath, newState.sessions);
         return true;
       } catch (error) {
         console.error(
           `Error deleting session: ${error instanceof Error ? error.message : String(error)}`
         );
         return false;
       }
     }

     async getRepoPath(record: SessionRecord | any): Promise<string> {
       // Add defensive checks for the input
       if (!record) {
         throw new Error("Session record is required");
       }

       // Special handling for SessionResult type returned by startSessionFromParams
       if (record.sessionRecord) {
         return this.getRepoPath(record.sessionRecord);
       }

       // Special handling for CloneResult
       if (record.cloneResult && record.cloneResult.workdir) {
         return record.cloneResult.workdir;
       }

       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       return getRepoPathFn(state, record);
     }

     async getSessionWorkdir(sessionName: string): Promise<string> {
       const sessions = await readSessionDbFile(this.dbPath);
       const state: SessionDbState = { sessions, baseDir: this.baseDir };
       const workdir = getSessionWorkdirFn(state, sessionName);
       if (!workdir) {
         throw new Error(`Session "${sessionName}" not found.`);
       }
       return workdir;
     }

     // Additional methods carried over with functional implementation
     getNewSessionRepoPath(repoName: string, sessionId: string): string {
       return getNewSessionRepoPathFn({ sessions: [], baseDir: this.baseDir }, repoName, sessionId);
     }

     async migrateSessionsToSubdirectory(): Promise<void> {
       const sessions = await readSessionDbFile(this.dbPath);
       let modified = false;
       const updatedSessions = [...sessions];

       for (let i = 0; i < updatedSessions.length; i++) {
         const session = updatedSessions[i];
         if (session.repoPath && session.repoPath.includes("/sessions/")) {
           continue;
         }

         const legacyPath = join(this.baseDir, session.repoName, session.session);
         const newPath = join(this.baseDir, session.repoName, "sessions", session.session);

         // Check if legacy path exists
         if (await repoExistsFn(legacyPath)) {
           // Create new path directory structure
           await mkdir(join(this.baseDir, session.repoName, "sessions"), { recursive: true });

           // Move repository to new location
           try {
             await rename(legacyPath, newPath);
             // Update session record
             updatedSessions[i] = { ...session, repoPath: newPath };
             modified = true;
           } catch (err) {
             console.error(`Failed to migrate session ${session.session}:`, err);
           }
         }
       }

       // Save changes
       if (modified) {
         await writeSessionDbFile(this.dbPath, updatedSessions);
       }
     }
   }
   ```

2. Update the factory function to use the adapter for backward compatibility:
   ```typescript
   export function createSessionProvider(options?: { dbPath?: string }): SessionProviderInterface {
     return new SessionDbAdapter(options?.dbPath);
   }
   ```

### 6. Tests

1. Create unit tests for each pure function, focusing on input/output behavior
2. Create integration tests that verify adapter functionality with the file system
3. Update existing tests that use SessionDB to work with the new implementation

### 7. Module Organization

1. Create a new file structure:

   ```
   src/domain/session/
     │
     ├── session-db.ts      # Pure functions and state definitions
     ├── session-db-io.ts   # I/O operations
     ├── session-adapter.ts # Compatibility adapter
     └── index.ts           # Public API exports
   ```

2. Update imports across the codebase to point to the new module structure

## Implementation Steps

1.  [x] Analyze current `SessionDB` methods and identify all side effects and state manipulations.
2.  [ ] Define clear data structures for representing the session database state.
3.  [ ] Implement pure function versions for each `SessionDB` operation:
    - [ ] `listSessionsFn(dbState)`
    - [ ] `getSessionFn(dbState, sessionName)`
    - [ ] `getSessionByTaskIdFn(dbState, taskId)`
    - [ ] `addSessionFn(dbState, newSessionRecord)`
    - [ ] `updateSessionFn(dbState, sessionName, updates)`
    - [ ] `deleteSessionFn(dbState, sessionName)`
    - [ ] `getRepoPathFn(dbState, sessionRecord)` (or adapt if state dependency changes)
    - [ ] `getSessionWorkdirFn(dbState, sessionName)` (or adapt)
4.  [ ] Create a separate module or service for handling the actual file I/O (reading and writing `session-db.json`).
    - [ ] `readSessionDbFile(): Promise<SessionDbState>`
    - [ ] `writeSessionDbFile(dbState: SessionDbState): Promise<void>`
5.  [ ] Refactor existing code that uses `SessionDB` to work with the new pure functions and the I/O service. This will likely involve changes in how services are instantiated or how data flows.
6.  [ ] Update all unit tests for `SessionDB` logic to test the pure functions directly.
7.  [ ] Update/create integration tests to cover the interaction between the pure functions and the side-effect-handling module.
8.  [ ] Document any significant changes to the `SessionDB` interface and usage patterns.

## Verification

- [ ] All `SessionDB` core logic is implemented as pure functions.
- [ ] Side effects (file I/O) are clearly separated from pure logic.
- [ ] All existing tests for `SessionDB` pass or have been updated.
- [ ] New tests provide adequate coverage for the refactored code.
- [ ] The application remains functional with the refactored `SessionDB`.
- [ ] Code conforms to project linting and style guidelines.

Parent Task: #102
