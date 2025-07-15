# "as unknown" Analysis Report

## Summary
- **Total assertions found**: 861
- **Analysis date**: 2025-07-15T02:35:30.614Z

## Distribution by Category
- **suspicious**: 171
- **error-masking**: 531
- **test-mocking**: 140
- **type-bridging**: 19

## Distribution by Priority
- **medium**: 219
- **high**: 531
- **low**: 111

## Recommendations
- 🚨 HIGH PRIORITY: 531 assertions are masking type errors and should be fixed immediately
- ⚠️  531 assertions are masking type errors - these reduce TypeScript effectiveness
- 🧪 140 assertions in tests - review for proper type alternatives
- 🌉 19 assertions for type bridging - consider proper type guards
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

- **src/errors/message-templates.ts:120** - Property access masking - should use proper types
  ```typescript
  parts.push(formatContextInfo(context as unknown));
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

- **src/errors/message-templates.ts:320** - Property access masking - should use proper types
  ```typescript
  return createSessionErrorMessage(sessionName, SessionErrorType.NOT_FOUND, context as unknown);
  ```

- **src/errors/message-templates.ts:330** - Property access masking - should use proper types
  ```typescript
  return createSessionErrorMessage(sessionName, SessionErrorType.ALREADY_EXISTS, context as unknown);
  ```

- **src/errors/message-templates.ts:340** - Property access masking - should use proper types
  ```typescript
  return createSessionErrorMessage(sessionName, SessionErrorType.INVALID, context as unknown);
  ```

- **src/errors/network-errors.test.ts:75** - Test assertion masking type errors - should be fixed
  ```typescript
  (eaddrinuseError as unknown)?.code = "EADDRINUSE";
  ```

- **src/errors/network-errors.test.ts:78** - Test assertion masking type errors - should be fixed
  ```typescript
  (eaccessError as unknown)?.code = "EACCES";
  ```

- **src/errors/network-errors.test.ts:92** - Test assertion masking type errors - should be fixed
  ```typescript
  (originalError as unknown)?.code = "EADDRINUSE";
  ```

- **src/errors/network-errors.test.ts:102** - Test assertion masking type errors - should be fixed
  ```typescript
  (originalError as unknown)?.code = "EACCES";
  ```

- **src/errors/network-errors.test.ts:112** - Test assertion masking type errors - should be fixed
  ```typescript
  (originalError as unknown)?.code = "SOMETHING_ELSE";
  ```

- **src/errors/base-errors.ts:23** - Property access masking - should use proper types
  ```typescript
  this.name = (this.constructor as unknown).name;
  ```

- **src/mcp/command-mapper.ts:98** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/command-mapper.ts:108** - Property access masking - should use proper types
  ```typescript
  (this.projectContext as unknown).repositoryPath &&
  ```

- **src/mcp/command-mapper.ts:115** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/command-mapper.ts:118** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/command-mapper.ts:165** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/command-mapper.ts:181** - Property access masking - should use proper types
  ```typescript
  (this.projectContext as unknown).repositoryPath &&
  ```

- **src/mcp/command-mapper.ts:188** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/server.ts:101** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/server.ts:157** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).on("connect", () => {
  ```

- **src/mcp/server.ts:162** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).on("disconnect", () => {
  ```

- **src/mcp/server.ts:179** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({ transportType: "stdio" });
  ```

- **src/mcp/server.ts:181** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({
  ```

- **src/mcp/server.ts:189** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({
  ```

- **src/mcp/server.ts:198** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({ transportType: "stdio" });
  ```

- **src/mcp/server.ts:209** - Property access masking - should use proper types
  ```typescript
  if ((this.server as unknown)._tools) {
  ```

- **src/mcp/server.ts:211** - Property access masking - should use proper types
  ```typescript
  methods.push(...Object.keys((this.server)._tools) as unknown);
  ```

- **src/mcp/fastmcp-command-mapper.ts:32** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/fastmcp-command-mapper.ts:49** - Property access masking - should use proper types
  ```typescript
  this.addTool(`session.${name}`, description, schema, handler as unknown);
  ```

- **src/mcp/fastmcp-command-mapper.ts:61** - Property access masking - should use proper types
  ```typescript
  this.addTool(`tasks.${name}`, description, schema, handler as unknown);
  ```

- **src/mcp/fastmcp-command-mapper.ts:73** - Property access masking - should use proper types
  ```typescript
  this.addTool(`git.${name}`, description, schema, handler as unknown);
  ```

- **src/mcp/fastmcp-command-mapper.ts:80** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/inspector-launcher.ts:101** - Property access masking - should use proper types
  ```typescript
  SERVER_PORT: ((port + 3) as unknown).toString(), // Use a different port for the inspector server
  ```

- **src/mcp/inspector-launcher.ts:149** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP Inspector stderr: ${(data as unknown)!.toString()}`);
  ```

- **src/domain/localGitBackend.ts:144** - Property access masking - should use proper types
  ```typescript
  return (this.cache as unknown).get(
  ```

- **src/domain/localGitBackend.ts:232** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/localGitBackend.ts:257** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/localGitBackend.ts:282** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/localGitBackend.ts:310** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/git.ts:1783** - Property access masking - should use proper types
  ```typescript
  const commitHash = ((await this.execInRepository(workdir, "git rev-parse HEAD")) as unknown).trim();
  ```

- **src/domain/git.ts:1787** - Property access masking - should use proper types
  ```typescript
  const mergedBy = ((await this.execInRepository(workdir, "git config user.name")) as unknown).trim();
  ```

- **src/domain/tasks.ts:531** - Property access masking - should use proper types
  ```typescript
  const updatedContent = matter.stringify(parsed.content, data as unknown);
  ```

- **src/domain/tasks.ts:677** - Property access masking - should use proper types
  ```typescript
  `Backend '${backend}' not found. Available backends: ${(this.backends.map((b) => b.name) as unknown).join(", ")}`
  ```

- **src/domain/tasks.ts:684** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).listTasks(options as unknown);
  ```

- **src/domain/tasks.ts:688** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getTask(id);
  ```

- **src/domain/tasks.ts:692** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getTaskStatus(id);
  ```

- **src/domain/tasks.ts:696** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).setTaskStatus(id, status);
  ```

- **src/domain/tasks.ts:700** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getWorkspacePath();
  ```

- **src/domain/tasks.ts:704** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).createTask(specPath, options as unknown);
  ```

- **src/domain/tasks.ts:731** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).deleteTask(id, options as unknown);
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

- **src/domain/prepared-merge-commit-workflow.test.ts:74** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).preparePr = preparePrSpy;
  ```

- **src/domain/prepared-merge-commit-workflow.test.ts:144** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).preparePr = correctPreparePrSpy;
  ```

- **src/domain/prepared-merge-commit-workflow.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  (require("../git.js") as unknown).preparePrFromParams = originalPreparePr;
  ```

- **src/domain/prepared-merge-commit-workflow.test.ts:321** - Test assertion masking type errors - should be fixed
  ```typescript
  (gitService as unknown).preparePr = preparePrWithConflictSpy;
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

- **src/domain/remoteGitBackend.ts:155** - Property access masking - should use proper types
  ```typescript
  return (this.cache as unknown).get(
  ```

- **src/domain/remoteGitBackend.ts:256** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/remoteGitBackend.ts:281** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/remoteGitBackend.ts:306** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
  ```

- **src/domain/remoteGitBackend.ts:334** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
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

- **src/domain/init.ts:31** - Property access masking - should use proper types
  ```typescript
  const validatedParams = initializeProjectParamsSchema.parse(params as unknown);
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

- **src/utils/git-exec-enhanced.ts:176** - Property access masking - should use proper types
  ```typescript
  ...(options as unknown)!.context || [],
  ```

- **src/utils/git-exec-enhanced.ts:196** - Property access masking - should use proper types
  ```typescript
  ...(options as unknown)!.context || [],
  ```

- **src/utils/git-exec-enhanced.ts:216** - Property access masking - should use proper types
  ```typescript
  ...(options as unknown)!.context || [],
  ```

- **src/utils/git-exec-enhanced.ts:236** - Property access masking - should use proper types
  ```typescript
  ...(options as unknown)!.context || [],
  ```

- **src/utils/git-exec-enhanced.ts:254** - Property access masking - should use proper types
  ```typescript
  ...(options as unknown)!.context || [],
  ```

- **src/utils/logger.ts:209** - Property access masking - should use proper types
  ```typescript
  agentLogger.debug(message, context as unknown);
  ```

- **src/utils/logger.ts:220** - Property access masking - should use proper types
  ```typescript
  agentLogger.info(message, context as unknown);
  ```

- **src/utils/logger.ts:231** - Property access masking - should use proper types
  ```typescript
  agentLogger.warn(message, context as unknown);
  ```

- **src/utils/logger.ts:260** - Property access masking - should use proper types
  ```typescript
  programLogger.error(message, context as unknown);
  ```

- **src/utils/logger.ts:277** - Property access masking - should use proper types
  ```typescript
  agentLogger.error(message, context as unknown);
  ```

- **src/utils/logger.ts:279** - Property access masking - should use proper types
  ```typescript
  agentLogger.error(message, context as unknown);
  ```

- **src/utils/logger.ts:330** - Property access masking - should use proper types
  ```typescript
  defaultLogger._internal.programLogger.error("Unhandled error or rejection, exiting.", error as unknown);
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

- **src/commands/mcp/index.ts:202** - Property access masking - should use proper types
  ```typescript
  const networkError = createNetworkError(error as unknown, port, options.host);
  ```

- **src/adapters/cli/cli-command-factory.ts:492** - Property access masking - should use proper types
  ```typescript
  log.cli(output as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:519** - Property access masking - should use proper types
  ```typescript
  log.cli(output as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:726** - Property access masking - should use proper types
  ```typescript
  } else if (typeof value === "object" && !Array.isArray(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:728** - Property access masking - should use proper types
  ```typescript
  result.push(...flatten(value as unknown, fullKey));
  ```

- **src/adapters/cli/cli-command-factory.ts:729** - Property access masking - should use proper types
  ```typescript
  } else if (Array.isArray(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:735** - Property access masking - should use proper types
  ```typescript
  result.push(...flatten(item as unknown, `${fullKey}[${index}]`));
  ```

- **src/adapters/cli/cli-command-factory.ts:787** - Property access masking - should use proper types
  ```typescript
  cliFactory.initialize(config as unknown);
  ```

- **src/adapters/mcp/integration-example.ts:83** - Property access masking - should use proper types
  ```typescript
  log.debug("MCP git.commit called with params:", params as unknown);
  ```

- **src/adapters/mcp/integration-example.ts:87** - Property access masking - should use proper types
  ```typescript
  message: (params as unknown)!.message,
  ```

- **src/adapters/mcp/integration-example.ts:117** - Property access masking - should use proper types
  ```typescript
  log.debug("MCP tasks.status.get called with params:", params as unknown);
  ```

- **src/adapters/mcp/integration-example.ts:120** - Property access masking - should use proper types
  ```typescript
  taskId: (params as unknown)!.taskId,
  ```

- **src/adapters/mcp/integration-example.ts:141** - Property access masking - should use proper types
  ```typescript
  log.debug("MCP session.list called with params:", params as unknown);
  ```

- **src/adapters/mcp/integration-example.ts:182** - Property access masking - should use proper types
  ```typescript
  log.debug("MCP rules.list called with params:", params as unknown);
  ```

- **src/adapters/shared/schema-bridge.ts:247** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[name] = param.schema.parse(value as unknown);
  ```

- **src/adapters/shared/schema-bridge.ts:257** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[name] = param.defaultValue;
  ```

- **src/adapters/shared/response-formatters.ts:62** - Property access masking - should use proper types
  ```typescript
  return this.formatJson(data as unknown, context as unknown);
  ```

- **src/adapters/shared/response-formatters.ts:66** - Property access masking - should use proper types
  ```typescript
  return this.formatText(data as unknown, context as unknown);
  ```

- **src/adapters/shared/response-formatters.ts:194** - Property access masking - should use proper types
  ```typescript
  output += `${index + 1}. ${this.itemFormatter!(item as unknown)}\n`;
  ```

- **src/adapters/shared/response-formatters.ts:198** - Property access masking - should use proper types
  ```typescript
  output += `${index + 1}. ${String(item as unknown)}\n`;
  ```

- **src/adapters/shared/response-formatters.ts:261** - Property access masking - should use proper types
  ```typescript
  columnWidths[col] = Math.max((columnWidths as unknown)[col], value.length);
  ```

- **src/adapters/shared/response-formatters.ts:269** - Property access masking - should use proper types
  ```typescript
  return header.padEnd((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:278** - Property access masking - should use proper types
  ```typescript
  return "-".repeat((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:289** - Property access masking - should use proper types
  ```typescript
  return value.padEnd((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:291** - Property access masking - should use proper types
  ```typescript
  .join(" | ") as unknown;
  ```

- **src/adapters/shared/legacy-command-registry.ts:167** - Property access masking - should use proper types
  ```typescript
  if (this.commands.has(commandDef.id) && !(options as unknown)!.allowOverwrite) {
  ```

- **src/adapters/shared/legacy-command-registry.ts:171** - Property access masking - should use proper types
  ```typescript
  this.commands.set(commandDef.id!, commandDef as unknown as SharedCommand);
  ```

- **src/adapters/shared/error-handling.ts:153** - Property access masking - should use proper types
  ```typescript
  (typeof process.env.NODE_DEBUG === "string" && (process.env.NODE_DEBUG as unknown).includes("minsky"))
  ```

- **src/adapters/shared/error-handling.ts:169** - Property access masking - should use proper types
  ```typescript
  const formattedError = SharedErrorHandler.formatError(error as unknown, debug);
  ```

- **src/adapters/shared/error-handling.ts:241** - Property access masking - should use proper types
  ```typescript
  const formattedError = SharedErrorHandler.formatError(error as unknown, debug);
  ```

- **src/adapters/shared/error-handling.ts:264** - Property access masking - should use proper types
  ```typescript
  const formattedError = SharedErrorHandler.formatError(error as unknown, debug);
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

- **src/domain/session/session-db.test.ts:195** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/ai/config-service.ts:71** - Property access masking - should use proper types
  ```typescript
  return (result.resolved.ai as any).default_provider || "openai" as unknown;
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

- **src/domain/storage/json-file-storage.ts:216** - Property access masking - should use proper types
  ```typescript
  const entity = entities.find((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/json-file-storage.ts:268** - Property access masking - should use proper types
  ```typescript
  const id = (entity as unknown)[this.idField];
  ```

- **src/domain/storage/json-file-storage.ts:269** - Property access masking - should use proper types
  ```typescript
  if (id && entities.some((e) => (e as unknown)[this.idField] === id)) {
  ```

- **src/domain/storage/json-file-storage.ts:308** - Property access masking - should use proper types
  ```typescript
  const index = entities.findIndex((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/json-file-storage.ts:348** - Property access masking - should use proper types
  ```typescript
  const index = entities.findIndex((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/database-integrity-checker.ts:248** - Property access masking - should use proper types
  ```typescript
  const integrityResult = db.prepare("PRAGMA integrity_check").get() as unknown;
  ```

- **src/domain/storage/database-integrity-checker.ts:264** - Property access masking - should use proper types
  ```typescript
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as unknown;
  ```

- **src/domain/workspace/local-workspace-backend.ts:276** - Property access masking - should use proper types
  ```typescript
  throw new FileNotFoundError(workspaceDir, relativePath || ".", error as unknown);
  ```

- **src/domain/repository/remote.ts:244** - Property access masking - should use proper types
  ```typescript
  (this.repoUrl as unknown).startsWith("git@") ||
  ```

- **src/domain/repository/remote.ts:245** - Property access masking - should use proper types
  ```typescript
  (this.repoUrl as unknown).startsWith("git://") ||
  ```

- **src/domain/repository/remote.ts:246** - Property access masking - should use proper types
  ```typescript
  (this.repoUrl as unknown).startsWith("http://") ||
  ```

- **src/domain/repository/remote.ts:247** - Property access masking - should use proper types
  ```typescript
  (this.repoUrl as unknown).startsWith("https://") ||
  ```

- **src/domain/repository/remote.ts:248** - Property access masking - should use proper types
  ```typescript
  (this.repoUrl as unknown).endsWith(".git");
  ```

- **src/domain/repository/remote.ts:293** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/remote.ts:371** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/local.ts:189** - Property access masking - should use proper types
  ```typescript
  if (!(this.repoUrl as unknown).includes("://") && !(this.repoUrl as unknown).includes("@")) {
  ```

- **src/domain/repository/github.ts:115** - Property access masking - should use proper types
  ```typescript
  const result = await (this.gitService as unknown).clone({
  ```

- **src/domain/repository/github.ts:188** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:199** - Property access masking - should use proper types
  ```typescript
  const gitStatus = await (this.gitService as unknown).getStatus(workdir);
  ```

- **src/domain/repository/github.ts:295** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:381** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:424** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:438** - Property access masking - should use proper types
  ```typescript
  const pullResult = await (this.gitService as unknown).pullLatest(workdir);
  ```

- **src/domain/repository/github.ts:464** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:97** - Property access masking - should use proper types
  ```typescript
  const result = await (this.storage as unknown).readState();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:102** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:113** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:120** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:167** - Property access masking - should use proper types
  ```typescript
  storageLocation: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:285** - Property access masking - should use proper types
  ```typescript
  storageLocation: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:292** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:295** - Property access masking - should use proper types
  ```typescript
  const result = await (this.storage as unknown).writeState(state);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:301** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:308** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:406** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:407** - Property access masking - should use proper types
  ```typescript
  return await (this.storage as unknown).getEntities();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:423** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:424** - Property access masking - should use proper types
  ```typescript
  return await (this.storage as unknown).getEntity(id);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:441** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:442** - Property access masking - should use proper types
  ```typescript
  return await (this.storage as unknown).createEntity(task);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:460** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:461** - Property access masking - should use proper types
  ```typescript
  return await (this.storage as unknown).updateEntity(id, updates);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:479** - Property access masking - should use proper types
  ```typescript
  await (this.storage as unknown).initialize();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:480** - Property access masking - should use proper types
  ```typescript
  return await (this.storage as unknown).deleteEntity(id);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:495** - Property access masking - should use proper types
  ```typescript
  return (this.storage as unknown).getStorageLocation();
  ```

- **src/domain/tasks/task-backend-router.ts:187** - Property access masking - should use proper types
  ```typescript
  return (this.specialWorkspaceManager as unknown).getWorkspacePath();
  ```

- **src/domain/tasks/task-backend-router.ts:209** - Property access masking - should use proper types
  ```typescript
  return (this.specialWorkspaceManager as unknown).performOperation(operation, callback as unknown);
  ```

- **src/domain/tasks/taskFunctions.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  const updatedTasks = setTaskStatus(testTasks, "#001", "INVALID" as unknown);
  ```

- **src/domain/tasks/task-backend-router.test.ts:70** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (markdownBackend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/task-backend-router.test.ts:78** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(typeof (markdownBackend as unknown).isInTreeBackend).toBe("undefined");
  ```

- **src/domain/tasks/task-backend-router.test.ts:96** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (jsonBackend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/task-backend-router.test.ts:104** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(typeof (jsonBackend as unknown).isInTreeBackend).toBe("undefined");
  ```

- **src/domain/tasks/task-backend-router.test.ts:122** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (jsonBackend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/task-backend-router.test.ts:130** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(typeof (jsonBackend as unknown).isInTreeBackend).toBe("undefined");
  ```

- **src/domain/tasks/task-backend-router.test.ts:148** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (jsonBackend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/task-backend-router.test.ts:156** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(typeof (jsonBackend as unknown).isInTreeBackend).toBe("undefined");
  ```

- **src/domain/tasks/task-backend-router.test.ts:176** - Test assertion masking type errors - should be fixed
  ```typescript
  (backend as unknown).isInTreeBackend = () => true;
  ```

- **src/domain/tasks/task-backend-router.test.ts:193** - Test assertion masking type errors - should be fixed
  ```typescript
  (backend as unknown).isInTreeBackend = () => false;
  ```

- **src/domain/tasks/task-backend-router.test.ts:226** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (backend as unknown).isInTreeBackend;
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

- **src/domain/tasks/githubIssuesTaskBackend.ts:174** - Property access masking - should use proper types
  ```typescript
  const response = await (this.octokit.rest.issues as unknown).listForRepo({
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:227** - Property access masking - should use proper types
  ```typescript
  const response = await (this.octokit.rest.issues as unknown).listForRepo({
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:230** - Property access masking - should use proper types
  ```typescript
  labels: Object.values(this.statusLabels).join(",") as unknown,
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:477** - Property access masking - should use proper types
  ```typescript
  return [(this.statusLabels as unknown)[status] || this.statusLabels.TODO];
  ```

- **src/domain/tasks/real-world-workflow.test.ts:39** - Test assertion masking type errors - should be fixed
  ```typescript
  expect((jsonBackend as unknown).getStorageLocation()).toBe(testJsonPath);
  ```

- **src/domain/tasks/real-world-workflow.test.ts:97** - Test assertion masking type errors - should be fixed
  ```typescript
  expect((jsonBackend as unknown).getStorageLocation()).toBe(expectedPath);
  ```

- **src/domain/tasks/taskService.ts:444** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getTaskSpecPath(id, task.title);
  ```

- **src/domain/tasks/taskCommands.ts:72** - Property access masking - should use proper types
  ```typescript
  const validParams = taskListParamsSchema.parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:347** - Property access masking - should use proper types
  ```typescript
  const validParams = taskCreateParamsSchema.parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:398** - Property access masking - should use proper types
  ```typescript
  const validParams = taskSpecContentParamsSchema.parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:508** - Property access masking - should use proper types
  ```typescript
  const validParams = taskCreateFromTitleAndDescriptionParamsSchema.parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:531** - Property access masking - should use proper types
  ```typescript
  description = ((await readFile(filePath, "utf-8")) as unknown).toString();
  ```

- **src/domain/tasks/special-workspace-integration.test.ts:96** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (backend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/special-workspace-integration.test.ts:119** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (backend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/special-workspace-integration.test.ts:182** - Test assertion masking type errors - should be fixed
  ```typescript
  delete (backend as unknown).isInTreeBackend;
  ```

- **src/domain/tasks/taskIO.ts:232** - Property access masking - should use proper types
  ```typescript
  const taskIdNum = taskId!.startsWith("#") ? (taskId as unknown)!.slice(1) : taskId;
  ```

- **src/domain/tasks/utils.test.ts:43** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(normalizeTaskId(input as unknown)).toBeNull();
  ```

- **src/utils/test-utils/index.ts:96** - Property access masking - should use proper types
  ```typescript
  const compatMock = ((...args: any[]) => mockFn(...args)) as unknown;
  ```

- **src/utils/test-utils/compatibility.test.ts:20** - Test assertion masking type errors - should be fixed
  ```typescript
  const expect = bunExpect as unknown;
  ```

- **src/utils/test-utils/assertions.ts:108** - Property access masking - should use proper types
  ```typescript
  expect(part in (current as unknown)).toBeTruthy();
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

- **src/adapters/cli/utils/error-handler.ts:26** - Property access masking - should use proper types
  ```typescript
  (typeof process.env.NODE_DEBUG === "string" && (process.env.NODE_DEBUG as unknown).includes("minsky"));
  ```

- **src/adapters/cli/utils/error-handler.ts:108** - Property access masking - should use proper types
  ```typescript
  log.error("CLI operation failed", error as unknown);
  ```

- **src/adapters/cli/utils/error-handler.ts:136** - Property access masking - should use proper types
  ```typescript
  log.agent({ message: "Command result", result } as unknown);
  ```

- **src/adapters/cli/utils/error-handler.ts:142** - Property access masking - should use proper types
  ```typescript
  options.formatter(result as unknown);
  ```

- **src/adapters/cli/utils/error-handler.ts:144** - Property access masking - should use proper types
  ```typescript
  log.cli(String(result as unknown));
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

- **tests/adapters/mcp/session-edit-tools.test.ts:41** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:258** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[paramName] = paramDef.defaultValue;
  ```

- **src/domain/storage/backends/error-handling.ts:92** - Property access masking - should use proper types
  ```typescript
  originalError: (this.originalError as unknown).message,
  ```

- **src/domain/storage/backends/error-handling.ts:105** - Property access masking - should use proper types
  ```typescript
  const classification = this.analyzeError(error as unknown, context as unknown);
  ```

- **src/domain/storage/backends/error-handling.ts:131** - Property access masking - should use proper types
  ```typescript
  return this.classifyJsonError(error as unknown, errorMessage);
  ```

- **src/domain/storage/backends/error-handling.ts:136** - Property access masking - should use proper types
  ```typescript
  return this.classifySqliteError(error as unknown, errorMessage);
  ```

- **src/domain/storage/backends/error-handling.ts:141** - Property access masking - should use proper types
  ```typescript
  return this.classifyPostgresError(error as unknown, errorMessage);
  ```

- **src/domain/storage/backends/error-handling.ts:568** - Property access masking - should use proper types
  ```typescript
  (this.errorCounts as unknown).set(key, currentCount + 1);
  ```

- **src/domain/storage/backends/error-handling.ts:569** - Property access masking - should use proper types
  ```typescript
  this.lastErrors.set(key, error as unknown);
  ```

- **src/domain/storage/backends/error-handling.ts:574** - Property access masking - should use proper types
  ```typescript
  type: (error).type as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:575** - Property access masking - should use proper types
  ```typescript
  severity: (error).severity as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:605** - Property access masking - should use proper types
  ```typescript
  (this.errorCounts as unknown).clear();
  ```

- **src/domain/storage/backends/postgres-storage.ts:76** - Property access masking - should use proper types
  ```typescript
  log.warn("Migration error (may be expected for new database):", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:88** - Property access masking - should use proper types
  ```typescript
  log.debug("Migration attempt failed:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:112** - Property access masking - should use proper types
  ```typescript
  log.error("Failed to initialize PostgreSQL storage:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:173** - Property access masking - should use proper types
  ```typescript
  .where(eq(postgresSessions.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/backends/postgres-storage.ts:175** - Property access masking - should use proper types
  ```typescript
  return result.length > 0 ? fromPostgresSelect((result as unknown)[0]) : null;
  ```

- **src/domain/storage/backends/postgres-storage.ts:187** - Property access masking - should use proper types
  ```typescript
  const results = await (this.drizzle.select() as unknown).from(postgresSessions);
  ```

- **src/domain/storage/backends/postgres-storage.ts:227** - Property access masking - should use proper types
  ```typescript
  .set(updateData as unknown) as unknown).where(eq(postgresSessions.session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:231** - Property access masking - should use proper types
  ```typescript
  log.error("Failed to update session in PostgreSQL:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:242** - Property access masking - should use proper types
  ```typescript
  .delete(postgresSessions) as unknown).where(eq(postgresSessions.session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:246** - Property access masking - should use proper types
  ```typescript
  log.error("Failed to delete session from PostgreSQL:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:259** - Property access masking - should use proper types
  ```typescript
  .where(eq(postgresSessions.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/backends/postgres-storage.ts:263** - Property access masking - should use proper types
  ```typescript
  log.error("Failed to check session existence in PostgreSQL:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:284** - Property access masking - should use proper types
  ```typescript
  log.error("Error closing PostgreSQL connection:", error as unknown);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:119** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.drizzleDb.select() as unknown).from(sessionsTable);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:146** - Property access masking - should use proper types
  ```typescript
  await (this.drizzleDb as unknown).transaction(async (tx) => {
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
  .set(updateData as unknown) as unknown).where(eq(sessionsTable.session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:308** - Property access masking - should use proper types
  ```typescript
  await (this.drizzleDb.delete(sessionsTable) as unknown).where(eq(sessionsTable.session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:328** - Property access masking - should use proper types
  ```typescript
  .where(eq(sessionsTable.session, id)) as unknown).limit(1);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:139** - Property access masking - should use proper types
  ```typescript
  const storage = StorageBackendFactory.createFromConfig(config as unknown);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:153** - Property access masking - should use proper types
  ```typescript
  await this.performBackendSpecificChecks(config as unknown, status);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:197** - Property access masking - should use proper types
  ```typescript
  await this.checkJsonBackendHealth(config as unknown, status);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:200** - Property access masking - should use proper types
  ```typescript
  await this.checkSqliteBackendHealth(config as unknown, status);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:203** - Property access masking - should use proper types
  ```typescript
  await this.checkPostgresBackendHealth(config as unknown, status);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:353** - Property access masking - should use proper types
  ```typescript
  const recentMetrics = (this.metrics as unknown).slice(-100); // Last 100 operations
  ```

- **src/domain/storage/monitoring/health-monitor.ts:494** - Property access masking - should use proper types
  ```typescript
  this.metrics = (this.metrics as unknown).slice(-this.MAX_METRICS);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:517** - Property access masking - should use proper types
  ```typescript
  return (this.metrics as unknown).slice(-count);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:539** - Property access masking - should use proper types
  ```typescript
  const avgResponse = totalOps > 0 ? (this.metrics as unknown).reduce((sum, m) => sum + m.duration, 0) / totalOps : 0;
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

- **src/utils/test-utils/compatibility/matchers.ts:118** - Property access masking - should use proper types
  ```typescript
  return `Any<${(this.expectedType as unknown)?.name || this.expectedType}>`;
  ```

- **src/utils/test-utils/compatibility/matchers.ts:122** - Property access masking - should use proper types
  ```typescript
  return `Any<${(this.expectedType as unknown)?.name || this.expectedType}>`;
  ```

## Next Steps
1. Start with high priority items (531 items)
2. Review error-masking assertions first
3. Fix underlying type issues rather than masking them
4. Consider proper type guards for legitimate type bridging
5. Document any assertions that must remain
