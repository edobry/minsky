# "as unknown" Analysis Report

## Summary
- **Total assertions found**: 605
- **Analysis date**: 2025-07-15T03:47:30.867Z

## Distribution by Category
- **suspicious**: 138
- **error-masking**: 356
- **test-mocking**: 104
- **type-bridging**: 7

## Distribution by Priority
- **medium**: 166
- **high**: 356
- **low**: 83

## Recommendations
- 🚨 HIGH PRIORITY: 356 assertions are masking type errors and should be fixed immediately
- ⚠️  356 assertions are masking type errors - these reduce TypeScript effectiveness
- 🧪 104 assertions in tests - review for proper type alternatives
- 🌉 7 assertions for type bridging - consider proper type guards
- 📋 Start with high priority items, then medium, then low
- 🔍 Focus on production code before test code
- 📚 Document any legitimate uses that must remain

## High Priority Items
- **targeted-as-unknown-fixer.ts:36** - Masking null/undefined type errors - dangerous
  ```typescript
  name: "Return null as unknown",
  ```

- **targeted-as-unknown-fixer.ts:38** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /return null as unknown;/g,
  ```

- **targeted-as-unknown-fixer.ts:43** - Masking null/undefined type errors - dangerous
  ```typescript
  name: "Return undefined as unknown",
  ```

- **targeted-as-unknown-fixer.ts:45** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /return undefined as unknown;/g,
  ```

- **targeted-as-unknown-fixer.ts:54** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /= null as unknown;/g,
  ```

- **targeted-as-unknown-fixer.ts:61** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /= undefined as unknown;/g,
  ```

- **targeted-as-unknown-fixer.ts:70** - Property access masking - should use proper types
  ```typescript
  pattern: /Object\.keys\(([^)]+) as unknown\)/g,
  ```

- **targeted-as-unknown-fixer.ts:77** - Property access masking - should use proper types
  ```typescript
  pattern: /Object\.values\(([^)]+) as unknown\)/g,
  ```

- **targeted-as-unknown-fixer.ts:84** - Property access masking - should use proper types
  ```typescript
  pattern: /Object\.entries\(([^)]+) as unknown\)/g,
  ```

- **targeted-as-unknown-fixer.ts:92** - Property access masking - should use proper types
  ```typescript
  console.log("🚀 Starting targeted 'as unknown' batch fixer...");
  ```

- **fix-syntax-errors.ts:16** - This context masking - likely type error
  ```typescript
  // Fix (this as unknown)?.name = "ErrorName"; -> (this as unknown).name = "ErrorName";
  ```

- **fix-syntax-errors.ts:17** - This context masking - likely type error
  ```typescript
  let fixedContent = content.replace(/\(this as unknown\)\?\.name = /g, "(this as unknown).name = ");
  ```

- **fix-syntax-errors.ts:20** - This context masking - likely type error
  ```typescript
  fixedContent = fixedContent.replace(/\(this as unknown\)\?\.([a-zA-Z_][a-zA-Z0-9_]*) = /g, "(this as unknown).$1 = ");
  ```

- **fix-syntax-errors.ts:24** - This context masking - likely type error
  ```typescript
  const fixes = (originalContent.match(/\(this as unknown\)\?\./g) || []).length;
  ```

- **as-unknown-ast-fixer.test.ts:84** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:110** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:118** - Test assertion masking type errors - should be fixed
  ```typescript
  return [...(state as unknown).sessions];
  ```

- **as-unknown-ast-fixer.test.ts:122** - Test assertion masking type errors - should be fixed
  ```typescript
  return (state.sessions as unknown).find(s => s.name === sessionName);
  ```

- **as-unknown-ast-fixer.test.ts:126** - Test assertion masking type errors - should be fixed
  ```typescript
  return (sessions as unknown).find(s => s.id === id);
  ```

- **as-unknown-ast-fixer.test.ts:136** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:148** - Test assertion masking type errors - should be fixed
  ```typescript
  return await (this.sessionProvider as unknown).getSession(name);
  ```

- **as-unknown-ast-fixer.test.ts:152** - Test assertion masking type errors - should be fixed
  ```typescript
  return (this.pathResolver as unknown).getRelativePathFromSession(dir, path);
  ```

- **as-unknown-ast-fixer.test.ts:156** - Test assertion masking type errors - should be fixed
  ```typescript
  return (this.workspaceBackend as unknown).readFile(dir, path);
  ```

- **as-unknown-ast-fixer.test.ts:160** - Test assertion masking type errors - should be fixed
  ```typescript
  return (this.config as unknown).path;
  ```

- **as-unknown-ast-fixer.test.ts:172** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:178** - Test assertion masking type errors - should be fixed
  ```typescript
  const found = (items as unknown).find(item => item.id === 1);
  ```

- **as-unknown-ast-fixer.test.ts:179** - Test assertion masking type errors - should be fixed
  ```typescript
  const length = (items as unknown).length;
  ```

- **as-unknown-ast-fixer.test.ts:180** - Test assertion masking type errors - should be fixed
  ```typescript
  (items as unknown).push({ id: 2 });
  ```

- **as-unknown-ast-fixer.test.ts:181** - Test assertion masking type errors - should be fixed
  ```typescript
  const filtered = (items as unknown).filter(item => item.active);
  ```

- **as-unknown-ast-fixer.test.ts:182** - Test assertion masking type errors - should be fixed
  ```typescript
  const mapped = (items as unknown).map(item => item.name);
  ```

- **as-unknown-ast-fixer.test.ts:183** - Test assertion masking type errors - should be fixed
  ```typescript
  const index = (items as unknown).findIndex(item => item.id === 3);
  ```

- **as-unknown-ast-fixer.test.ts:184** - Test assertion masking type errors - should be fixed
  ```typescript
  (items as unknown).splice(0, 1);
  ```

- **as-unknown-ast-fixer.test.ts:190** - Test assertion masking type errors - should be fixed
  ```typescript
  const keys = (Object as unknown).keys(obj);
  ```

- **as-unknown-ast-fixer.test.ts:191** - Test assertion masking type errors - should be fixed
  ```typescript
  const values = (Object as unknown).values(obj);
  ```

- **as-unknown-ast-fixer.test.ts:192** - Test assertion masking type errors - should be fixed
  ```typescript
  const entries = (Object as unknown).entries(obj);
  ```

- **as-unknown-ast-fixer.test.ts:208** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:216** - Test assertion masking type errors - should be fixed
  ```typescript
  (this as unknown).name = "CustomError";
  ```

- **as-unknown-ast-fixer.test.ts:223** - Test assertion masking type errors - should be fixed
  ```typescript
  (this as unknown).name = "SessionError";
  ```

- **as-unknown-ast-fixer.test.ts:233** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  const homeDir = (process.env as unknown).HOME;
  ```

- **as-unknown-ast-fixer.test.ts:241** - Test assertion masking type errors - should be fixed
  ```typescript
  const nodeEnv = (process.env as unknown).NODE_ENV;
  ```

- **as-unknown-ast-fixer.test.ts:242** - Test assertion masking type errors - should be fixed
  ```typescript
  const customVar = (process.env as unknown).CUSTOM_VAR;
  ```

- **as-unknown-ast-fixer.test.ts:251** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **as-unknown-ast-fixer.test.ts:266** - Test assertion masking type errors - should be fixed
  ```typescript
  const sessions = (state as unknown).sessions;
  ```

- **as-unknown-ast-fixer.test.ts:267** - Test assertion masking type errors - should be fixed
  ```typescript
  const result = (service.provider as unknown).getSession("test");
  ```

- **as-unknown-ast-fixer.test.ts:268** - Test assertion masking type errors - should be fixed
  ```typescript
  const length = (sessions as unknown).length;
  ```

- **as-unknown-ast-fixer.test.ts:269** - Test assertion masking type errors - should be fixed
  ```typescript
  (this as unknown).name = "TestError";
  ```

- **as-unknown-ast-fixer.test.ts:274** - Test assertion masking type errors - should be fixed
  ```typescript
  const home = (process.env as unknown).HOME;
  ```

- **as-unknown-ast-fixer.test.ts:279** - Test assertion masking type errors - should be fixed
  ```typescript
  const complex = (someComplexExpression() as unknown).someProperty;
  ```

- **as-unknown-ast-fixer.test.ts:307** - Test assertion masking type errors - should be fixed
  ```typescript
  sessions: (state as unknown).sessions,
  ```

- **as-unknown-ast-fixer.test.ts:308** - Test assertion masking type errors - should be fixed
  ```typescript
  count: (state as unknown).sessions.length,
  ```

- **as-unknown-ast-fixer.test.ts:309** - Test assertion masking type errors - should be fixed
  ```typescript
  first: (state as unknown).sessions.find(s => s.active)
  ```

- **as-unknown-ast-fixer.test.ts:312** - Test assertion masking type errors - should be fixed
  ```typescript
  const chained = (obj as unknown).prop1.prop2.prop3;
  ```

- **as-unknown-ast-fixer.test.ts:313** - Test assertion masking type errors - should be fixed
  ```typescript
  const multiLine = (veryLongVariableName as unknown)
  ```

- **as-unknown-ast-fixer.test.ts:352** - Test assertion masking type errors - should be fixed
  ```typescript
  test("should handle files with no as unknown patterns", async () => {
  ```

- **as-unknown-ast-fixer.test.ts:422** - Test assertion masking type errors - should be fixed
  ```typescript
  const c = (state as unknown).sessions;
  ```

- **as-unknown-ast-fixer.test.ts:423** - Test assertion masking type errors - should be fixed
  ```typescript
  const d = (items as unknown).length;
  ```

- **as-unknown-ast-fixer.test.ts:441** - Test assertion masking type errors - should be fixed
  ```typescript
  const b = (state as unknown).sessions;
  ```

- **as-unknown-ast-fixer.test.ts:469** - Test assertion masking type errors - should be fixed
  ```typescript
  return (this.config as unknown).path;
  ```

- **as-unknown-ast-fixer.test.ts:473** - Test assertion masking type errors - should be fixed
  ```typescript
  return (this.config as unknown).timeout;
  ```

- **as-unknown-ast-fixer.test.ts:483** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(result).not.toContain("as unknown");
  ```

- **enhanced-as-unknown-fixer.ts:12** - Property access masking - should use proper types
  ```typescript
  * 1. Property access patterns: (obj as unknown).prop → obj.prop
  ```

- **enhanced-as-unknown-fixer.ts:14** - Masking null/undefined type errors - dangerous
  ```typescript
  * 3. Null/undefined patterns: null as unknown → null
  ```

- **enhanced-as-unknown-fixer.ts:15** - Property access masking - should use proper types
  ```typescript
  * 4. Object method patterns: (obj as unknown).method() → obj.method()
  ```

- **enhanced-as-unknown-fixer.ts:16** - Property access masking - should use proper types
  ```typescript
  * 5. Array access patterns: (arr as unknown)[index] → arr[index]
  ```

- **enhanced-as-unknown-fixer.ts:17** - Property access masking - should use proper types
  ```typescript
  * 6. Object.keys/values/entries patterns: Object.keys(obj as unknown) → Object.keys(obj)
  ```

- **enhanced-as-unknown-fixer.ts:65** - Property access masking - should use proper types
  ```typescript
  console.log("🚀 Starting enhanced 'as unknown' fixer...");
  ```

- **enhanced-as-unknown-fixer.ts:122** - Property access masking - should use proper types
  ```typescript
  // Pattern 1: Property access - (obj as unknown).prop
  ```

- **enhanced-as-unknown-fixer.ts:134** - Masking null/undefined type errors - dangerous
  ```typescript
  // Pattern 3: Null/undefined literals - null as unknown
  ```

- **enhanced-as-unknown-fixer.ts:140** - Property access masking - should use proper types
  ```typescript
  // Pattern 4: Object method calls - (obj as unknown).method()
  ```

- **enhanced-as-unknown-fixer.ts:152** - Property access masking - should use proper types
  ```typescript
  // Pattern 6: Object.keys/values/entries - Object.keys(obj as unknown)
  ```

- **enhanced-as-unknown-fixer.ts:171** - Property access masking - should use proper types
  ```typescript
  // Check for (expr as unknown).property
  ```

- **enhanced-as-unknown-fixer.ts:211** - Masking null/undefined type errors - dangerous
  ```typescript
  // Transform null as unknown → null, undefined as unknown → undefined
  ```

- **enhanced-as-unknown-fixer.ts:223** - Property access masking - should use proper types
  ```typescript
  // Check for (expr as unknown).method()
  ```

- **enhanced-as-unknown-fixer.ts:270** - Property access masking - should use proper types
  ```typescript
  // Check for Object.keys(expr as unknown), Object.values(expr as unknown), etc.
  ```

- **enhanced-as-unknown-fixer.ts:387** - Property access masking - should use proper types
  ```typescript
  console.log(`Total 'as unknown' assertions: ${this.metrics.totalAssertions}`);
  ```

- **analyze-as-unknown.ts:29** - Property access masking - should use proper types
  ```typescript
  console.log("🔍 Scanning for \"as unknown\" assertions...");
  ```

- **analyze-as-unknown.ts:52** - Property access masking - should use proper types
  ```typescript
  if (line.includes("as unknown")) {
  ```

- **analyze-as-unknown.ts:89** - Masking null/undefined type errors - dangerous
  ```typescript
  } else if (trimmed.includes("undefined as unknown") ||
  ```

- **analyze-as-unknown.ts:90** - Masking null/undefined type errors - dangerous
  ```typescript
  trimmed.includes("null as unknown")) {
  ```

- **analyze-as-unknown.ts:101** - Masking null/undefined type errors - dangerous
  ```typescript
  if (trimmed.includes("undefined as unknown") ||
  ```

- **analyze-as-unknown.ts:102** - Masking null/undefined type errors - dangerous
  ```typescript
  trimmed.includes("null as unknown")) {
  ```

- **analyze-as-unknown.ts:111** - This context masking - likely type error
  ```typescript
  } else if (trimmed.includes("this as unknown")) {
  ```

- **analyze-as-unknown.ts:116** - Property access masking - should use proper types
  ```typescript
  trimmed.includes("as unknown") && trimmed.includes(".")) {
  ```

- **analyze-as-unknown.ts:194** - Property access masking - should use proper types
  ```typescript
  console.log(`Total "as unknown" assertions found: ${report.totalCount}`);
  ```

- **create-automated-fixes.ts:19** - Property access masking - should use proper types
  ```typescript
  console.log("🔧 Starting automated as unknown fixes...");
  ```

- **create-automated-fixes.ts:80** - Property access masking - should use proper types
  ```typescript
  return (content.match(/as unknown/g) || []).length;
  ```

- **create-automated-fixes.ts:87** - Property access masking - should use proper types
  ```typescript
  pattern: /\(state as unknown\)\.sessions/g,
  ```

- **create-automated-fixes.ts:92** - Property access masking - should use proper types
  ```typescript
  pattern: /\(state\.sessions as unknown\)/g,
  ```

- **create-automated-fixes.ts:97** - Property access masking - should use proper types
  ```typescript
  pattern: /\(s as unknown\)\.session/g,
  ```

- **create-automated-fixes.ts:102** - Property access masking - should use proper types
  ```typescript
  pattern: /\(s as unknown\)\.taskId/g,
  ```

- **create-automated-fixes.ts:107** - Property access masking - should use proper types
  ```typescript
  pattern: /\(session as unknown\)\.session/g,
  ```

- **create-automated-fixes.ts:112** - Property access masking - should use proper types
  ```typescript
  pattern: /\(session as unknown\)\.taskId/g,
  ```

- **create-automated-fixes.ts:117** - Property access masking - should use proper types
  ```typescript
  pattern: /\(workspace as unknown\)\.workspaceDir/g,
  ```

- **create-automated-fixes.ts:122** - Property access masking - should use proper types
  ```typescript
  pattern: /\(workspace as unknown\)\.sessionName/g,
  ```

- **create-automated-fixes.ts:128** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.config as unknown\)\.path/g,
  ```

- **create-automated-fixes.ts:133** - Property access masking - should use proper types
  ```typescript
  pattern: /\(process\.env as unknown\)\.([A-Z_]+)/g,
  ```

- **create-automated-fixes.ts:139** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.length/g,
  ```

- **create-automated-fixes.ts:144** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.push/g,
  ```

- **create-automated-fixes.ts:149** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.find/g,
  ```

- **create-automated-fixes.ts:154** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.findIndex/g,
  ```

- **create-automated-fixes.ts:159** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.splice/g,
  ```

- **create-automated-fixes.ts:164** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.filter/g,
  ```

- **create-automated-fixes.ts:169** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.map/g,
  ```

- **create-automated-fixes.ts:174** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.split/g,
  ```

- **create-automated-fixes.ts:179** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.trim/g,
  ```

- **create-automated-fixes.ts:184** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.replace/g,
  ```

- **create-automated-fixes.ts:205** - Property access masking - should use proper types
  ```typescript
  pattern: /\[\.\.\.\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.([a-zA-Z_][a-zA-Z0-9_]*)\]/g,
  ```

- **create-automated-fixes.ts:210** - Property access masking - should use proper types
  ```typescript
  pattern: /\[\.\.\.\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\]/g,
  ```

- **create-automated-fixes.ts:231** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.sessionProvider as unknown\)\.getSession/g,
  ```

- **create-automated-fixes.ts:236** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.sessionProvider as unknown\)\.getSessionByTaskId/g,
  ```

- **create-automated-fixes.ts:241** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.sessionProvider as unknown\)\.listSessions/g,
  ```

- **create-automated-fixes.ts:246** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.sessionProvider as unknown\)\.getSessionWorkdir/g,
  ```

- **create-automated-fixes.ts:251** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.pathResolver as unknown\)\.getRelativePathFromSession/g,
  ```

- **create-automated-fixes.ts:256** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.pathResolver as unknown\)\.validateAndResolvePath/g,
  ```

- **create-automated-fixes.ts:261** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.readFile/g,
  ```

- **create-automated-fixes.ts:266** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.writeFile/g,
  ```

- **create-automated-fixes.ts:271** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.deleteFile/g,
  ```

- **create-automated-fixes.ts:276** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.listDirectory/g,
  ```

- **create-automated-fixes.ts:281** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.exists/g,
  ```

- **create-automated-fixes.ts:286** - Property access masking - should use proper types
  ```typescript
  pattern: /\(this\.workspaceBackend as unknown\)\.createDirectory/g,
  ```

- **create-automated-fixes.ts:307** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /return null as unknown;/g,
  ```

- **create-automated-fixes.ts:312** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /return undefined as unknown;/g,
  ```

- **create-automated-fixes.ts:333** - This context masking - likely type error
  ```typescript
  pattern: /\(this as unknown\)\.name = "([^"]+)";/g,
  ```

- **create-automated-fixes.ts:354** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /: undefined as unknown/g,
  ```

- **create-automated-fixes.ts:359** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /\? undefined as unknown/g,
  ```

- **create-automated-fixes.ts:364** - Masking null/undefined type errors - dangerous
  ```typescript
  pattern: /undefined as unknown,/g,
  ```

- **create-automated-fixes.ts:380** - Masking null/undefined type errors - dangerous
  ```typescript
  /null as unknown/g,
  ```

- **create-automated-fixes.ts:381** - Masking null/undefined type errors - dangerous
  ```typescript
  /undefined as unknown/g
  ```

- **enhanced-as-unknown-fixer-v2.ts:13** - Property access masking - should use proper types
  ```typescript
  * 1. Function parameter patterns: func(param as unknown)
  ```

- **enhanced-as-unknown-fixer-v2.ts:15** - Property access masking - should use proper types
  ```typescript
  * 3. Simple comparison operations: value === (result as unknown)
  ```

- **enhanced-as-unknown-fixer-v2.ts:16** - Property access masking - should use proper types
  ```typescript
  * 4. Type guard patterns: if (value as unknown)
  ```

- **enhanced-as-unknown-fixer-v2.ts:17** - Property access masking - should use proper types
  ```typescript
  * 5. Error object patterns: (error as unknown).message
  ```

- **enhanced-as-unknown-fixer-v2.ts:18** - Property access masking - should use proper types
  ```typescript
  * 6. Configuration patterns: (config as unknown).key
  ```

- **enhanced-as-unknown-fixer-v2.ts:19** - Property access masking - should use proper types
  ```typescript
  * 7. Ternary expressions: condition ? (value as unknown) : other
  ```

- **enhanced-as-unknown-fixer-v2.ts:61** - Property access masking - should use proper types
  ```typescript
  console.log("🚀 Starting enhanced 'as unknown' fixer v2...");
  ```

- **enhanced-as-unknown-fixer-v2.ts:385** - Property access masking - should use proper types
  ```typescript
  // Check for error patterns: (error as unknown).message
  ```

- **enhanced-as-unknown-fixer-v2.ts:411** - Property access masking - should use proper types
  ```typescript
  // Check for config patterns: (config as unknown).key
  ```

- **enhanced-as-unknown-fixer-v2.ts:584** - Property access masking - should use proper types
  ```typescript
  console.log(`Total 'as unknown' assertions: ${this.metrics.totalAssertions}`);
  ```

- **as-unknown-ast-fixer.ts:22** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (state as unknown).sessions
  ```

- **as-unknown-ast-fixer.ts:25** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (this.sessionProvider as unknown).getSession(name)
  ```

- **as-unknown-ast-fixer.ts:29** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (sessions as unknown).find(s => s.id === id)
  ```

- **as-unknown-ast-fixer.ts:33** - Masking null/undefined type errors - dangerous
  ```typescript
  *    BEFORE: return null as unknown;
  ```

- **as-unknown-ast-fixer.ts:37** - Masking null/undefined type errors - dangerous
  ```typescript
  *    BEFORE: const result = undefined as unknown;
  ```

- **as-unknown-ast-fixer.ts:41** - This context masking - likely type error
  ```typescript
  *    BEFORE: (this as unknown).name = "ErrorName";
  ```

- **as-unknown-ast-fixer.ts:296** - Masking null/undefined type errors - dangerous
  ```typescript
  (text.includes("null as unknown") || text.includes("undefined as unknown"));
  ```

- **as-unknown-ast-fixer.ts:308** - Masking null/undefined type errors - dangerous
  ```typescript
  return text === "null as unknown" || text === "undefined as unknown";
  ```

- **as-unknown-ast-fixer.ts:320** - Property access masking - should use proper types
  ```typescript
  return text.includes("state as unknown") ||
  ```

- **as-unknown-ast-fixer.ts:321** - Property access masking - should use proper types
  ```typescript
  text.includes("session as unknown") ||
  ```

- **as-unknown-ast-fixer.ts:322** - Property access masking - should use proper types
  ```typescript
  text.includes("sessions as unknown");
  ```

- **as-unknown-ast-fixer.ts:334** - Property access masking - should use proper types
  ```typescript
  return text.includes("this.sessionProvider as unknown") ||
  ```

- **as-unknown-ast-fixer.ts:335** - Property access masking - should use proper types
  ```typescript
  text.includes("this.pathResolver as unknown") ||
  ```

- **as-unknown-ast-fixer.ts:336** - Property access masking - should use proper types
  ```typescript
  text.includes("this.workspaceBackend as unknown") ||
  ```

- **as-unknown-ast-fixer.ts:337** - Property access masking - should use proper types
  ```typescript
  text.includes("this.config as unknown");
  ```

- **as-unknown-ast-fixer.ts:386** - This context masking - likely type error
  ```typescript
  return text.includes("this as unknown");
  ```

- **as-unknown-ast-fixer.ts:398** - Property access masking - should use proper types
  ```typescript
  return text.includes("process.env as unknown");
  ```

- **as-unknown-ast-fixer.ts:420** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (format as unknown).timestamp(), (z.string() as unknown).optional()
  ```

- **as-unknown-ast-fixer.ts:447** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (descriptions as unknown).SESSION_DESCRIPTION
  ```

- **as-unknown-ast-fixer.ts:473** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (logInfo as unknown).message, (result as unknown).status
  ```

- **as-unknown-ast-fixer.ts:488** - Property access masking - should use proper types
  ```typescript
  this.log("🔍 Analyzing 'as unknown' assertions...");
  ```

- **as-unknown-ast-fixer.ts:503** - Property access masking - should use proper types
  ```typescript
  if (asExpression.getText().includes("as unknown")) {
  ```

- **as-unknown-ast-fixer.ts:510** - Property access masking - should use proper types
  ```typescript
  this.log(`📊 Found ${this.asUnknownIssues.length} 'as unknown' assertions`);
  ```

- **as-unknown-ast-fixer.ts:575** - Property access masking - should use proper types
  ```typescript
  this.log("🔧 Applying 'as unknown' transformations...");
  ```

- **codemods/fix-explicit-any-types-proven.ts:96** - Property access masking - should use proper types
  ```typescript
  return match.replace("as any", "as unknown");
  ```

- **codemods/risk-aware-type-cast-fixer.ts:82** - Property access masking - should use proper types
  ```typescript
  return match.replace('as any', 'as unknown');
  ```

- **codemods/risk-aware-type-cast-fixer.ts:99** - Property access masking - should use proper types
  ```typescript
  return match.replace('as any', 'as unknown');
  ```

- **codemods/risk-aware-type-cast-fixer.ts:160** - Property access masking - should use proper types
  ```typescript
  return match.replace('as any', 'as unknown');
  ```

- **codemods/risk-aware-type-cast-fixer.ts:252** - Property access masking - should use proper types
  ```typescript
  const asUnknownMatches = content.matchAll(/\bas unknown\b/g);
  ```

- **codemods/risk-aware-type-cast-fixer.ts:348** - Property access masking - should use proper types
  ```typescript
  /Promise\.resolve\([^)]+\) as unknown/,
  ```

- **codemods/risk-aware-type-cast-fixer.ts:349** - Property access masking - should use proper types
  ```typescript
  /JSON\.parse\([^)]+\) as unknown/,
  ```

- **codemods/risk-aware-type-cast-fixer.ts:350** - Property access masking - should use proper types
  ```typescript
  /Object\.keys\([^)]+\) as unknown/
  ```

- **codemods/explicit-any-types-fixer-consolidated.ts:282** - Property access masking - should use proper types
  ```typescript
  replacement: (match) => match.replace("as any", "as unknown"),
  ```

- **codemods/ast-type-cast-fixer.ts:22** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (state as unknown).sessions
  ```

- **codemods/ast-type-cast-fixer.ts:25** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (this.sessionProvider as unknown).getSession(name)
  ```

- **codemods/ast-type-cast-fixer.ts:29** - Property access masking - should use proper types
  ```typescript
  *    BEFORE: (sessions as unknown).find(s => s.id === id)
  ```

- **codemods/ast-type-cast-fixer.ts:33** - Masking null/undefined type errors - dangerous
  ```typescript
  *    BEFORE: return null as unknown;
  ```

- **codemods/ast-type-cast-fixer.ts:37** - Masking null/undefined type errors - dangerous
  ```typescript
  *    BEFORE: const result = undefined as unknown;
  ```

- **codemods/ast-type-cast-fixer.ts:41** - This context masking - likely type error
  ```typescript
  *    BEFORE: (this as unknown).name = "ErrorName";
  ```

- **codemods/ast-type-cast-fixer.ts:296** - Masking null/undefined type errors - dangerous
  ```typescript
  (text.includes("null as unknown") || text.includes("undefined as unknown"));
  ```

- **codemods/ast-type-cast-fixer.ts:308** - Masking null/undefined type errors - dangerous
  ```typescript
  return text === "null as unknown" || text === "undefined as unknown";
  ```

- **codemods/ast-type-cast-fixer.ts:320** - Property access masking - should use proper types
  ```typescript
  return text.includes("state as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:321** - Property access masking - should use proper types
  ```typescript
  text.includes("session as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:322** - Property access masking - should use proper types
  ```typescript
  text.includes("sessions as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:334** - Property access masking - should use proper types
  ```typescript
  return text.includes("this.sessionProvider as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:335** - Property access masking - should use proper types
  ```typescript
  text.includes("this.pathResolver as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:336** - Property access masking - should use proper types
  ```typescript
  text.includes("this.workspaceBackend as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:337** - Property access masking - should use proper types
  ```typescript
  text.includes("this.config as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:386** - This context masking - likely type error
  ```typescript
  return text.includes("this as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:398** - Property access masking - should use proper types
  ```typescript
  return text.includes("process.env as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:420** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (format as unknown).timestamp(), (z.string() as unknown).optional()
  ```

- **codemods/ast-type-cast-fixer.ts:447** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (descriptions as unknown).SESSION_DESCRIPTION
  ```

- **codemods/ast-type-cast-fixer.ts:473** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (logInfo as unknown).message, (result as unknown).status
  ```

- **codemods/ast-type-cast-fixer.ts:488** - Property access masking - should use proper types
  ```typescript
  this.log("🔍 Analyzing 'as unknown' assertions...");
  ```

- **codemods/ast-type-cast-fixer.ts:503** - Property access masking - should use proper types
  ```typescript
  if (asExpression.getText().includes("as unknown")) {
  ```

- **codemods/ast-type-cast-fixer.ts:510** - Property access masking - should use proper types
  ```typescript
  this.log(`📊 Found ${this.asUnknownIssues.length} 'as unknown' assertions`);
  ```

- **codemods/ast-type-cast-fixer.ts:575** - Property access masking - should use proper types
  ```typescript
  this.log("🔧 Applying 'as unknown' transformations...");
  ```

- **src/domain/repository-uri.ts:98** - Property access masking - should use proper types
  ```typescript
  (components as unknown)!.repo = repo;
  ```

- **src/domain/repository-uri.ts:145** - Property access masking - should use proper types
  ```typescript
  return (result as unknown)!.name as unknown;
  ```

- **src/domain/git.test.ts:203** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:210** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:267** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:274** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:283** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:360** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:367** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:402** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:408** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:439** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:464** - Test assertion masking type errors - should be fixed
  ```typescript
  })) as unknown,
  ```

- **src/domain/git.test.ts:477** - Test assertion masking type errors - should be fixed
  ```typescript
  })) as unknown,
  ```

- **src/domain/git.test.ts:491** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:514** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:532** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:552** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:569** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:595** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:623** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:642** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:661** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:687** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:706** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:726** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:745** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:749** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:793** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:821** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:825** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:847** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:851** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:854** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:874** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:896** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/prepared-merge-commit-workflow.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  (require("../git.js") as unknown).preparePrFromParams = originalPreparePr;
  ```

- **src/domain/rules.ts:192** - Property access masking - should use proper types
  ```typescript
  dataKeys: Object.keys(data) as unknown,
  ```

- **src/domain/rules.ts:280** - Property access masking - should use proper types
  ```typescript
  dataKeys: Object.keys(data) as unknown,
  ```

- **src/domain/session-lookup-bug-simple.test.ts:47** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/session-lookup-bug-simple.test.ts:53** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/session-lookup-bug-simple.test.ts:58** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/session-lookup-bug-simple.test.ts:76** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/session-update.test.ts:58** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown);
  ```

- **src/domain/workspace.ts:42** - Property access masking - should use proper types
  ```typescript
  if ((repoUrl as unknown)!.startsWith("file://")) {
  ```

- **src/domain/workspace.ts:43** - Property access masking - should use proper types
  ```typescript
  return (repoUrl as unknown)!.replace("file://", "");
  ```

- **src/domain/workspace.ts:56** - Property access masking - should use proper types
  ```typescript
  return (workspacePath as unknown)!.startsWith(minskySessionsPath);
  ```

- **src/domain/workspace.ts:99** - Property access masking - should use proper types
  ```typescript
  if (!sessionRecord || !(sessionRecord as unknown)!.repoUrl) {
  ```

- **src/domain/workspace.ts:105** - Property access masking - should use proper types
  ```typescript
  upstreamRepository: (sessionRecord as unknown)!.repoUrl,
  ```

- **src/domain/workspace.ts:161** - Property access masking - should use proper types
  ```typescript
  const sessionRecord = await (sessionProvider as unknown)!.getSession(sessionName);
  ```

- **src/domain/workspace.ts:162** - Property access masking - should use proper types
  ```typescript
  if (sessionRecord && (sessionRecord as unknown)!.repoUrl) {
  ```

- **src/domain/workspace.ts:163** - Property access masking - should use proper types
  ```typescript
  return (sessionRecord as unknown)!.repoUrl;
  ```

- **src/domain/workspace.ts:198** - Property access masking - should use proper types
  ```typescript
  return resolveMainWorkspaceFromRepoUrl((sessionInfo as unknown)!.upstreamRepository);
  ```

- **src/domain/workspace.ts:240** - Property access masking - should use proper types
  ```typescript
  return sessionInfo ? (sessionInfo as unknown)!.session : null;
  ```

- **src/domain/workspace.ts:272** - Property access masking - should use proper types
  ```typescript
  const sessionRecord = await (sessionDb as unknown)!.getSession(sessionId);
  ```

- **src/domain/workspace.ts:280** - Property access masking - should use proper types
  ```typescript
  taskId: (sessionRecord as unknown)!.taskId,
  ```

- **src/domain/workspace.ts:362** - Property access masking - should use proper types
  ```typescript
  return sessionInfo ? (sessionInfo as unknown)!.session : null;
  ```

- **src/domain/workspace.ts:366** - Property access masking - should use proper types
  ```typescript
  return sessionInfo ? (sessionInfo as unknown)!.session : null;
  ```

- **src/domain/workspace.ts:389** - Property access masking - should use proper types
  ```typescript
  session: (sessionInfo as unknown)!.session,
  ```

- **src/domain/repository.ts:270** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:288** - Property access masking - should use proper types
  ```typescript
  ).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:314** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:348** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:368** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:386** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:398** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:410** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:460** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:472** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/errors/message-templates.ts:299** - Property access masking - should use proper types
  ```typescript
  title: (config as unknown)!.title,
  ```

- **src/errors/message-templates.ts:300** - Property access masking - should use proper types
  ```typescript
  description: (config as unknown)!.description,
  ```

- **src/errors/message-templates.ts:305** - Property access masking - should use proper types
  ```typescript
  content: formatCommandSuggestions((config as unknown)!.suggestions)
  ```

- **src/utils/type-guards.ts:13** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someObject as unknown).property
  ```

- **src/utils/type-guards.ts:26** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someObject as unknown).deep.property
  ```

- **src/utils/type-guards.ts:44** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someObject as unknown).property
  ```

- **src/utils/type-guards.ts:67** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someValue as unknown).length
  ```

- **src/utils/type-guards.ts:142** - Property access masking - should use proper types
  ```typescript
  * Instead of: Number(process.env.VARIABLE as unknown)
  ```

- **src/utils/type-guards.ts:157** - Property access masking - should use proper types
  ```typescript
  * Instead of: Boolean(process.env.VARIABLE as unknown)
  ```

- **src/utils/type-guards.ts:217** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someService as unknown).method()
  ```

- **src/utils/type-guards.ts:254** - Property access masking - should use proper types
  ```typescript
  * Instead of: (options as unknown).property
  ```

- **src/utils/type-guards.ts:286** - Property access masking - should use proper types
  ```typescript
  * Instead of: (someArray as unknown).map(...)
  ```

- **src/mcp/server.ts:211** - Property access masking - should use proper types
  ```typescript
  methods.push(...Object.keys((this.server)._tools) as unknown);
  ```

- **src/mcp/inspector-launcher.ts:101** - Property access masking - should use proper types
  ```typescript
  SERVER_PORT: ((port + 3) as unknown).toString(), // Use a different port for the inspector server
  ```

- **src/mcp/inspector-launcher.ts:149** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP Inspector stderr: ${(data as unknown)!.toString()}`);
  ```

- **src/schemas/error.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(err as unknown).message` patterns with proper validation.
  ```

- **src/schemas/runtime.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(Bun as unknown).argv` patterns with proper validation.
  ```

- **src/schemas/session-db-config.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(config as unknown)` patterns with proper validation.
  ```

- **src/domain/session/session-db.test.ts:195** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/storage/database-integrity-checker.ts:248** - Property access masking - should use proper types
  ```typescript
  const integrityResult = db.prepare("PRAGMA integrity_check").get() as unknown;
  ```

- **src/domain/storage/database-integrity-checker.ts:264** - Property access masking - should use proper types
  ```typescript
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as unknown;
  ```

- **src/domain/__tests__/tasks.test.ts:43** - Test assertion masking type errors - should be fixed
  ```typescript
  backends: [] as unknown,
  ```

- **src/domain/__tests__/tasks.test.ts:44** - Test assertion masking type errors - should be fixed
  ```typescript
  currentBackend: {} as unknown,
  ```

- **src/domain/__tests__/tasks.test.ts:58** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown; // Cast to any to avoid TypeScript errors with the deps parameter
  ```

- **src/domain/__tests__/tasks.test.ts:214** - Test assertion masking type errors - should be fixed
  ```typescript
  status: "INVALID-STATUS" as unknown,
  ```

- **src/domain/workspace/local-workspace-backend.ts:276** - Property access masking - should use proper types
  ```typescript
  throw new FileNotFoundError(workspaceDir, relativePath || ".", error as unknown);
  ```

- **src/domain/tasks/taskFunctions.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  const updatedTasks = setTaskStatus(testTasks, "#001", "INVALID" as unknown);
  ```

- **src/domain/tasks/task-backend-router.test.ts:270** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/tasks/task-backend-router.test.ts:285** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/tasks/task-backend-router.test.ts:301** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/tasks/task-backend-router.test.ts:322** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/tasks/githubBackendFactory.ts:26** - Property access masking - should use proper types
  ```typescript
  if (!config || !(config as unknown)!.githubToken || !(config as unknown)!.owner || !(config as unknown)!.repo) {
  ```

- **src/domain/tasks/githubBackendFactory.ts:33** - Property access masking - should use proper types
  ```typescript
  githubToken: (config as unknown)!.githubToken,
  ```

- **src/domain/tasks/githubBackendFactory.ts:34** - Property access masking - should use proper types
  ```typescript
  owner: (config as unknown)!.owner,
  ```

- **src/domain/tasks/githubBackendFactory.ts:35** - Property access masking - should use proper types
  ```typescript
  repo: (config as unknown)!.repo,
  ```

- **src/domain/tasks/githubBackendFactory.ts:36** - Property access masking - should use proper types
  ```typescript
  statusLabels: (config as unknown)!.statusLabels,
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:230** - Property access masking - should use proper types
  ```typescript
  labels: Object.values(this.statusLabels).join(",") as unknown,
  ```

- **src/domain/tasks/taskCommands.ts:531** - Property access masking - should use proper types
  ```typescript
  description = ((await readFile(filePath, "utf-8")) as unknown).toString();
  ```

- **src/domain/tasks/taskIO.ts:232** - Property access masking - should use proper types
  ```typescript
  const taskIdNum = taskId!.startsWith("#") ? (taskId as unknown)!.slice(1) : taskId;
  ```

- **src/utils/test-utils/index.ts:96** - Property access masking - should use proper types
  ```typescript
  const compatMock = ((...args: any[]) => mockFn(...args)) as unknown;
  ```

- **src/utils/test-utils/assertions.ts:108** - Property access masking - should use proper types
  ```typescript
  expect(part in (current as unknown)).toBeTruthy();
  ```

- **src/adapters/shared/response-formatters.ts:291** - Property access masking - should use proper types
  ```typescript
  .join(" | ") as unknown;
  ```

- **src/adapters/shared/legacy-command-registry.ts:171** - Property access masking - should use proper types
  ```typescript
  this.commands.set(commandDef.id!, commandDef as unknown as SharedCommand);
  ```

- **src/mcp/tools/tasks.ts:69** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks get ${(args as unknown)!.taskId} --json`;
  ```

- **src/mcp/tools/tasks.ts:75** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error getting task ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/tasks.ts:96** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks status get ${(args as unknown)!.taskId}`;
  ```

- **src/mcp/tools/tasks.ts:101** - Property access masking - should use proper types
  ```typescript
  taskId: (args as unknown)!.taskId,
  ```

- **src/mcp/tools/tasks.ts:105** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error getting task status for ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/tasks.ts:129** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks status set ${(args as unknown)!.taskId} ${args.status}`;
  ```

- **src/mcp/tools/tasks.ts:135** - Property access masking - should use proper types
  ```typescript
  taskId: (args as unknown)!.taskId,
  ```

- **src/mcp/tools/tasks.ts:139** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error setting task status for ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/session.ts:39** - Property access masking - should use proper types
  ```typescript
  const command = `minsky session get ${(args as unknown)!.session} --json`;
  ```

- **src/mcp/tools/session.ts:45** - Property access masking - should use proper types
  ```typescript
  log.error(`Error getting session ${(args as unknown)!.session}`, { error, _session: (args as unknown)!.session });
  ```

- **src/mcp/tools/session.ts:124** - Property access masking - should use proper types
  ```typescript
  if ((args as unknown)!.session) {
  ```

- **src/mcp/tools/session.ts:125** - Property access masking - should use proper types
  ```typescript
  command += ` --session ${(args as unknown)!.session}`;
  ```

- **src/mcp/tools/session.ts:137** - Property access masking - should use proper types
  ```typescript
  log.error("Error committing changes", { error, session: (args as unknown)!.session });
  ```

- **src/types/tasks/taskData.ts:103** - Property access masking - should use proper types
  ```typescript
  id: (task as unknown)!.id,
  ```

- **src/types/tasks/taskData.ts:104** - Property access masking - should use proper types
  ```typescript
  title: (task as unknown)!.title,
  ```

- **src/types/tasks/taskData.ts:105** - Property access masking - should use proper types
  ```typescript
  description: (task as unknown)!.description,
  ```

- **src/types/tasks/taskData.ts:106** - Property access masking - should use proper types
  ```typescript
  status: (task as unknown)!.status,
  ```

- **src/types/tasks/taskData.ts:120** - Property access masking - should use proper types
  ```typescript
  id: (taskData as unknown)!.id,
  ```

- **src/types/tasks/taskData.ts:121** - Property access masking - should use proper types
  ```typescript
  title: (taskData as unknown)!.title,
  ```

- **src/types/tasks/taskData.ts:122** - Property access masking - should use proper types
  ```typescript
  description: (taskData as unknown)!.description,
  ```

- **src/types/tasks/taskData.ts:123** - Property access masking - should use proper types
  ```typescript
  status: (taskData as unknown)!.status,
  ```

- **tests/adapters/mcp/session-edit-tools.test.ts:41** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/utils/test-utils/compatibility/mock-function.ts:319** - Property access masking - should use proper types
  ```typescript
  () => Promise.resolve(value) as unknown as ReturnType<T>
  ```

- **src/utils/test-utils/compatibility/mock-function.ts:327** - Property access masking - should use proper types
  ```typescript
  () => Promise.resolve(value) as unknown as ReturnType<T>
  ```

- **src/utils/test-utils/compatibility/mock-function.ts:335** - Property access masking - should use proper types
  ```typescript
  () => Promise.reject(value) as unknown as ReturnType<T>
  ```

- **src/utils/test-utils/compatibility/mock-function.ts:343** - Property access masking - should use proper types
  ```typescript
  () => Promise.reject(value) as unknown as ReturnType<T>
  ```

- **tests/adapters/cli/session.test.ts:603** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).sessionDb = {
  ```

- **tests/adapters/cli/session.test.ts:608** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).getSessionWorkdir = () => testWorkdir;
  ```

- **tests/adapters/cli/session.test.ts:611** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).push = async () => ({ workdir: testWorkdir, pushed: true });
  ```

- **tests/adapters/cli/session.test.ts:614** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).execInRepository = async (workdir: string, command: string) => {
  ```

- **src/domain/storage/backends/error-handling.ts:574** - Property access masking - should use proper types
  ```typescript
  type: (error).type as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:575** - Property access masking - should use proper types
  ```typescript
  severity: (error).severity as unknown,
  ```

- **src/domain/storage/backends/postgres-storage.ts:173** - Property access masking - should use proper types
  ```typescript
  .where(eq(postgresSessions.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/backends/postgres-storage.ts:187** - Property access masking - should use proper types
  ```typescript
  const results = await (this.drizzle.select() as unknown).from(postgresSessions);
  ```

- **src/domain/storage/backends/postgres-storage.ts:227** - Property access masking - should use proper types
  ```typescript
  .set(updateData) as unknown).where(eq(postgresSessions.session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:242** - Property access masking - should use proper types
  ```typescript
  .delete(postgresSessions) as unknown).where(eq(postgresSessions.session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:259** - Property access masking - should use proper types
  ```typescript
  .where(eq(postgresSessions.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:119** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.drizzleDb.select() as unknown).from(sessionsTable);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:184** - Property access masking - should use proper types
  ```typescript
  .where(eq(sessionsTable.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:200** - Property access masking - should use proper types
  ```typescript
  let query = (this.drizzleDb.select() as unknown).from(sessionsTable);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:227** - Property access masking - should use proper types
  ```typescript
  query = query.where(and(...conditions)) as unknown;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:292** - Property access masking - should use proper types
  ```typescript
  .set(updateData) as unknown).where(eq(sessionsTable.session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:308** - Property access masking - should use proper types
  ```typescript
  await (this.drizzleDb.delete(sessionsTable) as unknown).where(eq(sessionsTable.session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:328** - Property access masking - should use proper types
  ```typescript
  .where(eq(sessionsTable.session, id)) as unknown).limit(1);
  ```

- **src/adapters/cli/utils/error-handler.ts:136** - Property access masking - should use proper types
  ```typescript
  log.agent({ message: "Command result", result } as unknown);
  ```

- **tests/domain/commands/workspace.commands.test.ts:115** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **tests/domain/commands/workspace.commands.test.ts:189** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **tests/domain/commands/workspace.commands.test.ts:225** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

## Next Steps
1. Start with high priority items (356 items)
2. Review error-masking assertions first
3. Fix underlying type issues rather than masking them
4. Consider proper type guards for legitimate type bridging
5. Document any assertions that must remain
