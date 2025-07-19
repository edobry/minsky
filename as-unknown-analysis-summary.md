# "as unknown" Analysis Report

## Summary
- **Total assertions found**: 570
- **Analysis date**: 2025-07-17T15:54:56.845Z

## Distribution by Category
- **suspicious**: 133
- **error-masking**: 344
- **test-mocking**: 92
- **type-bridging**: 1

## Distribution by Priority
- **medium**: 159
- **high**: 344
- **low**: 67

## Recommendations
- 🚨 HIGH PRIORITY: 344 assertions are masking type errors and should be fixed immediately
- ⚠️  344 assertions are masking type errors - these reduce TypeScript effectiveness
- 🧪 92 assertions in tests - review for proper type alternatives
- 🌉 1 assertions for type bridging - consider proper type guards
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

- **codemods/safe-ast-fixer.ts:36** - Property access masking - should use proper types
  ```typescript
  console.log("🚀 Starting safe 'as unknown' fixes...");
  ```

- **codemods/safe-ast-fixer.ts:76** - Property access masking - should use proper types
  ```typescript
  if (!fullText.includes("as unknown")) {
  ```

- **codemods/safe-ast-fixer.ts:85** - Property access masking - should use proper types
  ```typescript
  // Pattern 1: Simple config property access like (config as unknown)!.title
  ```

- **codemods/safe-ast-fixer.ts:91** - Masking null/undefined type errors - dangerous
  ```typescript
  // Pattern 2: Return null/undefined as unknown
  ```

- **codemods/safe-ast-fixer.ts:92** - Masking null/undefined type errors - dangerous
  ```typescript
  if (fullText === "null as unknown" || fullText === "undefined as unknown") {
  ```

- **codemods/safe-ast-fixer.ts:109** - Property access masking - should use proper types
  ```typescript
  // Look for patterns like (config as unknown)!.property or (data as unknown).property
  ```

- **codemods/safe-ast-fixer.ts:117** - Property access masking - should use proper types
  ```typescript
  return fullText.includes("config as unknown") ||
  ```

- **codemods/safe-ast-fixer.ts:118** - Property access masking - should use proper types
  ```typescript
  fullText.includes("options as unknown") ||
  ```

- **codemods/safe-ast-fixer.ts:119** - Property access masking - should use proper types
  ```typescript
  fullText.includes("data as unknown") ||
  ```

- **codemods/safe-ast-fixer.ts:120** - Property access masking - should use proper types
  ```typescript
  fullText.includes("result as unknown");
  ```

- **codemods/safe-ast-fixer.ts:142** - Property access masking - should use proper types
  ```typescript
  // This transforms (config as unknown)!.title to config.title
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:24** - Test assertion masking type errors - should be fixed
  ```typescript
  const sessionRecord = await (sessionProvider as unknown)!.getSession(sessionName);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:25** - Test assertion masking type errors - should be fixed
  ```typescript
  if ((sessionProvider as unknown)!.isActive()) {
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:26** - Test assertion masking type errors - should be fixed
  ```typescript
  return (sessionProvider as unknown)!.config;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:40** - Test assertion masking type errors - should be fixed
  ```typescript
  if (sessionRecord && (sessionRecord as unknown)!.repoUrl) {
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:41** - Test assertion masking type errors - should be fixed
  ```typescript
  return (sessionRecord as unknown)!.repoUrl;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:43** - Test assertion masking type errors - should be fixed
  ```typescript
  const taskId = (sessionRecord as unknown)!.taskId;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:55** - Test assertion masking type errors - should be fixed
  ```typescript
  return sessionInfo ? (sessionInfo as unknown)!.session : null;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:56** - Test assertion masking type errors - should be fixed
  ```typescript
  const name = (sessionInfo as unknown)!.session;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:57** - Test assertion masking type errors - should be fixed
  ```typescript
  const upstream = (sessionInfo as unknown)!.upstreamRepository;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:71** - Test assertion masking type errors - should be fixed
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:72** - Test assertion masking type errors - should be fixed
  ```typescript
  const util = new ((await import("../utils/helper.js")) as unknown).Helper();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:84** - Test assertion masking type errors - should be fixed
  ```typescript
  const proc = ((await import("child_process")) as unknown).exec;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:85** - Test assertion masking type errors - should be fixed
  ```typescript
  const util = ((await import("util")) as unknown).promisify;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:91** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(sourceFile.getFullText()).toContain('((await import("child_process")) as unknown).exec');
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:92** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(sourceFile.getFullText()).toContain('((await import("util")) as unknown).promisify');
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:100** - Test assertion masking type errors - should be fixed
  ```typescript
  const value = (config as unknown).apiKey;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:101** - Test assertion masking type errors - should be fixed
  ```typescript
  const timeout = (config as unknown).timeout;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:102** - Test assertion masking type errors - should be fixed
  ```typescript
  const options = (config as unknown).database;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:115** - Test assertion masking type errors - should be fixed
  ```typescript
  const debug = (options as unknown).debug;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:116** - Test assertion masking type errors - should be fixed
  ```typescript
  const verbose = (options as unknown).verbose;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:130** - Test assertion masking type errors - should be fixed
  ```typescript
  const message = (error as unknown).message;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:131** - Test assertion masking type errors - should be fixed
  ```typescript
  const code = (err as unknown).code;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:132** - Test assertion masking type errors - should be fixed
  ```typescript
  const stack = (e as unknown).stack;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:147** - Test assertion masking type errors - should be fixed
  ```typescript
  const data = (taskProvider as unknown).getTasks();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:148** - Test assertion masking type errors - should be fixed
  ```typescript
  const result = (userService as unknown).getUser();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:149** - Test assertion masking type errors - should be fixed
  ```typescript
  const config = (storageBackend as unknown).getConfig();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:164** - Test assertion masking type errors - should be fixed
  ```typescript
  const result1 = (output as unknown) as string;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:165** - Test assertion masking type errors - should be fixed
  ```typescript
  const result2 = (result as unknown) as number;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:166** - Test assertion masking type errors - should be fixed
  ```typescript
  const result3 = (data as unknown) as boolean;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:181** - Test assertion masking type errors - should be fixed
  ```typescript
  return Promise.resolve(value) as unknown;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:182** - Test assertion masking type errors - should be fixed
  ```typescript
  return Promise.reject(error) as unknown;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:183** - Test assertion masking type errors - should be fixed
  ```typescript
  const p = Promise.resolve(data) as unknown;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:198** - Test assertion masking type errors - should be fixed
  ```typescript
  const p = (params as unknown);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:199** - Test assertion masking type errors - should be fixed
  ```typescript
  const r = (result as unknown);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:200** - Test assertion masking type errors - should be fixed
  ```typescript
  const c = (current as unknown);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:201** - Test assertion masking type errors - should be fixed
  ```typescript
  const t = (task as unknown);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:217** - Test assertion masking type errors - should be fixed
  ```typescript
  const complex = (someObject.deepProperty.methodCall() as unknown).value;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:218** - Test assertion masking type errors - should be fixed
  ```typescript
  const chained = (obj.method().then() as unknown).property;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:224** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(sourceFile.getFullText()).toContain("(someObject.deepProperty.methodCall() as unknown).value");
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:225** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(sourceFile.getFullText()).toContain("(obj.method().then() as unknown).property");
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:232** - Test assertion masking type errors - should be fixed
  ```typescript
  const session = (sessionInfo as unknown)!.session;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:235** - Test assertion masking type errors - should be fixed
  ```typescript
  const debug = (config as unknown).debug;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:238** - Test assertion masking type errors - should be fixed
  ```typescript
  const message = (error as unknown).message;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:241** - Test assertion masking type errors - should be fixed
  ```typescript
  const result = (output as unknown) as string;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:257** - Test assertion masking type errors - should be fixed
  ```typescript
  const sessionRecord = await (sessionProvider as unknown)!.getSession(sessionName);
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:258** - Test assertion masking type errors - should be fixed
  ```typescript
  if (sessionRecord && (sessionRecord as unknown)!.repoUrl) {
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:259** - Test assertion masking type errors - should be fixed
  ```typescript
  return (sessionRecord as unknown)!.repoUrl;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:261** - Test assertion masking type errors - should be fixed
  ```typescript
  return sessionInfo ? (sessionInfo as unknown)!.session : null;
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:274** - Test assertion masking type errors - should be fixed
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:275** - Test assertion masking type errors - should be fixed
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **codemods/comprehensive-as-unknown-fixer.test.ts:284** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(sourceFile.getFullText()).toContain('((await import("child_process")) as unknown).exec');
  ```

- **codemods/comprehensive-fixer.ts:37** - Property access masking - should use proper types
  ```typescript
  console.log("🔧 Starting comprehensive 'as unknown' pattern fixes...");
  ```

- **codemods/comprehensive-fixer.ts:136** - Property access masking - should use proper types
  ```typescript
  // Pattern: Promise.resolve(value) as unknown, return (result as unknown)
  ```

- **codemods/comprehensive-fixer.ts:197** - Property access masking - should use proper types
  ```typescript
  // Pattern: jest.fn() as unknown, mock objects as unknown
  ```

- **codemods/comprehensive-fixer.ts:231** - Property access masking - should use proper types
  ```typescript
  // Pattern: (obj.prop as unknown) for simple property access
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:13** - Property access masking - should use proper types
  ```typescript
  * 1. Session Object Property Access: (sessionProvider as unknown)!.method
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:14** - Property access masking - should use proper types
  ```typescript
  * 2. Dynamic Import Patterns: ((await import("module")) as unknown).Class
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:15** - Property access masking - should use proper types
  ```typescript
  * 3. Config Object Patterns: (config as unknown).property
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:16** - Property access masking - should use proper types
  ```typescript
  * 4. Error Handling Patterns: (error as unknown).property
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:17** - Property access masking - should use proper types
  ```typescript
  * 5. Provider/Service Patterns: (serviceProvider as unknown).method
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:18** - Property access masking - should use proper types
  ```typescript
  * 6. Redundant Cast Patterns: (value as unknown) as Type
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:19** - Property access masking - should use proper types
  ```typescript
  * 7. Promise Return Patterns: Promise.resolve(value) as unknown
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:20** - Property access masking - should use proper types
  ```typescript
  * 8. Simple Variable Patterns: (variable as unknown)
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:66** - Property access masking - should use proper types
  ```typescript
  console.log("🔧 Starting comprehensive 'as unknown' fixes...");
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:113** - Property access masking - should use proper types
  ```typescript
  * Fixes: (sessionProvider as unknown)!.method → sessionProvider.method
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:174** - Property access masking - should use proper types
  ```typescript
  // Replace the entire property access: (sessionXxx as unknown)!.prop → sessionXxx.prop
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:183** - Property access masking - should use proper types
  ```typescript
  * Fixes: ((await import("./module")) as unknown).Class → (await import("./module")).Class
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:274** - Property access masking - should use proper types
  ```typescript
  * Fixes: (config as unknown).property → config.property
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:339** - Property access masking - should use proper types
  ```typescript
  * Fixes: (error as unknown).property → error.property
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:404** - Property access masking - should use proper types
  ```typescript
  * Fixes: (serviceProvider as unknown).method → serviceProvider.method
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:517** - Property access masking - should use proper types
  ```typescript
  * Fixes: Promise.resolve(value) as unknown → Promise.resolve(value)
  ```

- **codemods/comprehensive-as-unknown-fixer.ts:680** - Property access masking - should use proper types
  ```typescript
  console.log(`\n✅ Comprehensive 'as unknown' fixes completed!`);
  ```

- **codemods/fix-explicit-any-types-proven.ts:96** - Property access masking - should use proper types
  ```typescript
  return match.replace("as any", "as unknown");
  ```

- **codemods/pattern-based-fixer.ts:58** - Property access masking - should use proper types
  ```typescript
  pattern: /Promise\.resolve\(([^)]+)\) as unknown/g,
  ```

- **codemods/pattern-based-fixer.ts:63** - Property access masking - should use proper types
  ```typescript
  pattern: /Promise\.reject\(([^)]+)\) as unknown/g,
  ```

- **codemods/pattern-based-fixer.ts:69** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*) as unknown\)/g,
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

- **codemods/enhanced-pattern-fixer.ts:7** - Property access masking - should use proper types
  ```typescript
  * - Session object property access patterns: (sessionProvider as unknown)!.method
  ```

- **codemods/enhanced-pattern-fixer.ts:8** - Property access masking - should use proper types
  ```typescript
  * - Dynamic import patterns: ((await import("module")) as unknown).Class
  ```

- **codemods/enhanced-pattern-fixer.ts:9** - Property access masking - should use proper types
  ```typescript
  * - SessionInfo property patterns: (sessionInfo as unknown)!.property
  ```

- **codemods/enhanced-pattern-fixer.ts:10** - Property access masking - should use proper types
  ```typescript
  * - Config object patterns: (config as unknown).property
  ```

- **codemods/enhanced-pattern-fixer.ts:57** - Property access masking - should use proper types
  ```typescript
  pattern: /\(config as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:62** - Property access masking - should use proper types
  ```typescript
  pattern: /\(options as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:69** - Property access masking - should use proper types
  ```typescript
  pattern: /\(\(await import\("([^"]+)"\)\) as unknown\)\.([A-Z][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:82** - Property access masking - should use proper types
  ```typescript
  pattern: /\(error as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:87** - Property access masking - should use proper types
  ```typescript
  pattern: /\(err as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:92** - Property access masking - should use proper types
  ```typescript
  pattern: /\(e as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:116** - Property access masking - should use proper types
  ```typescript
  pattern: /\(context as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:121** - Property access masking - should use proper types
  ```typescript
  pattern: /\(data as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ```

- **codemods/enhanced-pattern-fixer.ts:140** - Property access masking - should use proper types
  ```typescript
  pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*) as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
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

- **codemods/ast-type-cast-fixer.ts:338** - Property access masking - should use proper types
  ```typescript
  return text.includes("this.sessionProvider as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:339** - Property access masking - should use proper types
  ```typescript
  text.includes("this.pathResolver as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:340** - Property access masking - should use proper types
  ```typescript
  text.includes("this.workspaceBackend as unknown") ||
  ```

- **codemods/ast-type-cast-fixer.ts:341** - Property access masking - should use proper types
  ```typescript
  text.includes("this.config as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:364** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (sessions as unknown).find(), (results as unknown).map()
  ```

- **codemods/ast-type-cast-fixer.ts:382** - This context masking - likely type error
  ```typescript
  return text.includes("this as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:394** - Property access masking - should use proper types
  ```typescript
  return text.includes("process.env as unknown");
  ```

- **codemods/ast-type-cast-fixer.ts:416** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (format as unknown).timestamp(), (z.string() as unknown).optional()
  ```

- **codemods/ast-type-cast-fixer.ts:443** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (descriptions as unknown).SESSION_DESCRIPTION
  ```

- **codemods/ast-type-cast-fixer.ts:469** - Property access masking - should use proper types
  ```typescript
  // Match patterns like (logInfo as unknown).message, (result as unknown).status
  ```

- **codemods/ast-type-cast-fixer.ts:484** - Property access masking - should use proper types
  ```typescript
  this.log("🔍 Analyzing 'as unknown' assertions...");
  ```

- **codemods/ast-type-cast-fixer.ts:499** - Property access masking - should use proper types
  ```typescript
  if (asExpression.getText().includes("as unknown")) {
  ```

- **codemods/ast-type-cast-fixer.ts:506** - Property access masking - should use proper types
  ```typescript
  this.log(`📊 Found ${this.asUnknownIssues.length} 'as unknown' assertions`);
  ```

- **codemods/ast-type-cast-fixer.ts:571** - Property access masking - should use proper types
  ```typescript
  this.log("🔧 Applying 'as unknown' transformations...");
  ```

- **codemods/ast-type-cast-fixer.ts:655** - Property access masking - should use proper types
  ```typescript
  // e.g., (port + 3 as unknown).toString() would become port + 3.toString() which is invalid
  ```

- **codemods/enhanced-safe-fixer.ts:36** - Property access masking - should use proper types
  ```typescript
  console.log("🚀 Starting enhanced safe 'as unknown' fixes...");
  ```

- **codemods/enhanced-safe-fixer.ts:77** - Property access masking - should use proper types
  ```typescript
  if (!fullText.includes("as unknown")) {
  ```

- **src/domain/prepared-merge-commit-workflow.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  (require("./git") as unknown).preparePrFromParams = originalPreparePr;
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

- **src/domain/repository.ts:288** - Property access masking - should use proper types
  ```typescript
  ).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:386** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:410** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/schemas/session-db-config.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(config as unknown)` patterns with proper validation.
  ```

- **src/utils/type-guards.ts:142** - Property access masking - should use proper types
  ```typescript
  * Instead of: Number(process.env.VARIABLE as unknown)
  ```

- **src/utils/type-guards.ts:157** - Property access masking - should use proper types
  ```typescript
  * Instead of: Boolean(process.env.VARIABLE as unknown)
  ```

- **src/domain/session/session-db.test.ts:195** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
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

- **src/domain/__tests__/git-pr-workflow.test.ts:132** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:139** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:148** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:225** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:232** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:267** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/__tests__/git-pr-workflow.test.ts:273** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
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

- **tests/adapters/cli/session.test.ts:87** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown as SessionProviderInterface;
  ```

- **tests/adapters/mcp/session-edit-tools.test.ts:41** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
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

- **src/domain/storage/backends/sqlite-storage.ts:200** - Property access masking - should use proper types
  ```typescript
  let query = (this.drizzleDb.select() as unknown).from(sessionsTable);
  ```

- **src/adapters/cli/utils/error-handler.ts:136** - Property access masking - should use proper types
  ```typescript
  log.agent({ message: "Command result", result } as unknown);
  ```

## Next Steps
1. Start with high priority items (344 items)
2. Review error-masking assertions first
3. Fix underlying type issues rather than masking them
4. Consider proper type guards for legitimate type bridging
5. Document any assertions that must remain
