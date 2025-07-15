# "as unknown" Analysis Report

## Summary
- **Total assertions found**: 2356
- **Analysis date**: 2025-07-14T23:35:50.390Z

## Distribution by Category
- **error-masking**: 2052
- **test-mocking**: 140
- **suspicious**: 141
- **type-bridging**: 23

## Distribution by Priority
- **high**: 2052
- **medium**: 193
- **low**: 111

## Recommendations
- 🚨 HIGH PRIORITY: 2052 assertions are masking type errors and should be fixed immediately
- ⚠️  2052 assertions are masking type errors - these reduce TypeScript effectiveness
- 🧪 140 assertions in tests - review for proper type alternatives
- 🌉 23 assertions for type bridging - consider proper type guards
- 📋 Start with high priority items, then medium, then low
- 🔍 Focus on production code before test code
- 📚 Document any legitimate uses that must remain

## High Priority Items
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

- **as-unknown-ast-fixer.ts:406** - Property access masking - should use proper types
  ```typescript
  this.log("🔍 Analyzing 'as unknown' assertions...");
  ```

- **as-unknown-ast-fixer.ts:421** - Property access masking - should use proper types
  ```typescript
  if (asExpression.getText().includes("as unknown")) {
  ```

- **as-unknown-ast-fixer.ts:428** - Property access masking - should use proper types
  ```typescript
  this.log(`📊 Found ${this.asUnknownIssues.length} 'as unknown' assertions`);
  ```

- **as-unknown-ast-fixer.ts:493** - Property access masking - should use proper types
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

- **codemods/ast-type-cast-fixer.ts:80** - Property access masking - should use proper types
  ```typescript
  return asAnyExpression.replace('as any', 'as unknown');
  ```

- **codemods/ast-type-cast-fixer.ts:110** - Property access masking - should use proper types
  ```typescript
  // Find all AsExpression nodes (as any, as unknown, etc.)
  ```

- **src/errors/enhanced-error-templates.ts:108** - Property access masking - should use proper types
  ```typescript
  content: (validExamples.map(example => `• ${example}`) as unknown).join("\n")
  ```

- **src/errors/enhanced-error-templates.ts:181** - Property access masking - should use proper types
  ```typescript
  ...(declarationLine ? [{ label: "Declaration line", value: (declarationLine as unknown).toString() }] : []),
  ```

- **src/errors/enhanced-error-templates.ts:182** - Property access masking - should use proper types
  ```typescript
  ...(usageLine ? [{ label: "Usage line", value: (usageLine as unknown).toString() }] : [])
  ```

- **src/errors/enhanced-error-templates.ts:282** - Property access masking - should use proper types
  ```typescript
  }) as unknown).join("\n");
  ```

- **src/errors/enhanced-error-templates.ts:330** - Property access masking - should use proper types
  ```typescript
  { label: "Conflicted files", value: (conflictingFiles.length as unknown).toString() },
  ```

- **src/errors/enhanced-error-templates.ts:370** - Property access masking - should use proper types
  ```typescript
  }) as unknown).join("\n")
  ```

- **src/errors/enhanced-error-templates.ts:404** - Property access masking - should use proper types
  ```typescript
  { label: "Available backends", value: (availableBackends.length as unknown).toString() },
  ```

- **src/errors/network-errors.ts:87** - Property access masking - should use proper types
  ```typescript
  const errorCode = (originalError as unknown)?.code || "";
  ```

- **src/errors/network-errors.ts:95** - Property access masking - should use proper types
  ```typescript
  return new NetworkError(`Network error: ${(originalError as unknown).message}`, errorCode, port, host, originalError);
  ```

- **src/errors/network-errors.ts:135** - Property access masking - should use proper types
  ```typescript
  .getSuggestions().map((s) => `- ${s}`) as unknown).join("\n");
  ```

- **src/errors/message-templates.ts:75** - Property access masking - should use proper types
  ```typescript
  `${emoji} ${description}:\n   ${command}`) as unknown).join("\n\n");
  ```

- **src/errors/message-templates.ts:84** - Property access masking - should use proper types
  ```typescript
  const formatted = (contexts.map(({ label, value }) => `${label}: ${value}`) as unknown).join("\n");
  ```

- **src/errors/message-templates.ts:96** - Property access masking - should use proper types
  ```typescript
  parts.push((template as unknown).title);
  ```

- **src/errors/message-templates.ts:99** - Property access masking - should use proper types
  ```typescript
  if ((template as unknown)?.description) {
  ```

- **src/errors/message-templates.ts:101** - Property access masking - should use proper types
  ```typescript
  parts.push((template as unknown).description);
  ```

- **src/errors/message-templates.ts:105** - Property access masking - should use proper types
  ```typescript
  (template.sections as unknown).forEach(section => {
  ```

- **src/errors/message-templates.ts:108** - Property access masking - should use proper types
  ```typescript
  if ((section as unknown)?.title) {
  ```

- **src/errors/message-templates.ts:109** - Property access masking - should use proper types
  ```typescript
  const title = (section as unknown)?.emoji ? `${(section as unknown).emoji} ${(section as unknown).title}` : (section as unknown)?.title;
  ```

- **src/errors/message-templates.ts:114** - Property access masking - should use proper types
  ```typescript
  parts.push((section as unknown).content);
  ```

- **src/errors/message-templates.ts:120** - Property access masking - should use proper types
  ```typescript
  parts.push(formatContextInfo(context as unknown));
  ```

- **src/errors/message-templates.ts:137** - Property access masking - should use proper types
  ```typescript
  description: `The ${(resourceType as unknown).toLowerCase()} you're looking for doesn't exist or isn't accessible.`,
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
  return createSessionErrorMessage(sessionName, (SessionErrorType as unknown).NOT_FOUND, context as unknown);
  ```

- **src/errors/message-templates.ts:330** - Property access masking - should use proper types
  ```typescript
  return createSessionErrorMessage(sessionName, (SessionErrorType as unknown).ALREADY_EXISTS, context as unknown);
  ```

- **src/errors/message-templates.ts:340** - Property access masking - should use proper types
  ```typescript
  return createSessionErrorMessage(sessionName, (SessionErrorType as unknown).INVALID, context as unknown);
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

- **src/domain/localGitBackend.ts:48** - Property access masking - should use proper types
  ```typescript
  type: (RepositoryBackendType as unknown).LOCAL,
  ```

- **src/domain/localGitBackend.ts:53** - Property access masking - should use proper types
  ```typescript
  this.cache = (RepositoryMetadataCache as unknown).getInstance();
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

- **src/domain/git.ts:611** - Property access masking - should use proper types
  ```typescript
  const context = (createErrorContext().addCommand("minsky git pr") as unknown).build();
  ```

- **src/domain/git.ts:649** - Property access masking - should use proper types
  ```typescript
  const baseBranch = (stdout.trim() as unknown).replace("origin/", "");
  ```

- **src/domain/git.ts:664** - Property access masking - should use proper types
  ```typescript
  const baseBranch = (stdout.trim() as unknown).replace("origin/", "");
  ```

- **src/domain/git.ts:795** - Property access masking - should use proper types
  ```typescript
  if ((commits as unknown).includes("\x1f")) {
  ```

- **src/domain/git.ts:806** - Property access masking - should use proper types
  ```typescript
  const hash = (fields[0] as unknown).substring(0, 7);
  ```

- **src/domain/git.ts:817** - Property access masking - should use proper types
  ```typescript
  return (formattedEntries as unknown).join("\n");
  ```

- **src/domain/git.ts:874** - Property access masking - should use proper types
  ```typescript
  return (sections as unknown).join("\n");
  ```

- **src/domain/git.ts:1036** - Property access masking - should use proper types
  ```typescript
  const lines = (diffNameStatus.trim() as unknown).split("\n");
  ```

- **src/domain/git.ts:1044** - Property access masking - should use proper types
  ```typescript
  const lines = (uncommittedChanges.trim() as unknown).split("\n");
  ```

- **src/domain/git.ts:1061** - Property access masking - should use proper types
  ```typescript
  const modified = (modifiedOutput.trim() as unknown).split("\n").filter(Boolean);
  ```

- **src/domain/git.ts:1067** - Property access masking - should use proper types
  ```typescript
  const untracked = (untrackedOutput.trim() as unknown).split("\n").filter(Boolean);
  ```

- **src/domain/git.ts:1071** - Property access masking - should use proper types
  ```typescript
  const deleted = (deletedOutput.trim() as unknown).split("\n").filter(Boolean);
  ```

- **src/domain/git.ts:1178** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("UU") ||
  ```

- **src/domain/git.ts:1179** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("AA") ||
  ```

- **src/domain/git.ts:1180** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("DD");
  ```

- **src/domain/git.ts:1184** - Property access masking - should use proper types
  ```typescript
  UU: (status as unknown).includes("UU"),
  ```

- **src/domain/git.ts:1185** - Property access masking - should use proper types
  ```typescript
  AA: (status as unknown).includes("AA"),
  ```

- **src/domain/git.ts:1186** - Property access masking - should use proper types
  ```typescript
  DD: (status as unknown).includes("DD"),
  ```

- **src/domain/git.ts:1257** - Property access masking - should use proper types
  ```typescript
  if (!(remotes as unknown).includes(remote)) {
  ```

- **src/domain/git.ts:1374** - Property access masking - should use proper types
  ```typescript
  const sessionsIndex = (pathParts as unknown).indexOf("sessions");
  ```

- **src/domain/git.ts:1400** - Property access masking - should use proper types
  ```typescript
  createdAt: (new Date() as unknown).toISOString(),
  ```

- **src/domain/git.ts:1611** - Property access masking - should use proper types
  ```typescript
  const remoteBaseBranch = (baseBranch as unknown).startsWith("origin/")
  ```

- **src/domain/git.ts:1668** - Property access masking - should use proper types
  ```typescript
  const actualTitle = ((actualCommitMessage.stdout as unknown).trim() as unknown).split("\n")[0];
  ```

- **src/domain/git.ts:1676** - Property access masking - should use proper types
  ```typescript
  fullActual: (actualCommitMessage.stdout as unknown).trim(),
  ```

- **src/domain/git.ts:1688** - Property access masking - should use proper types
  ```typescript
  await (fs.unlink(commitMsgFile) as unknown).catch(() => {
  ```

- **src/domain/git.ts:1696** - Property access masking - should use proper types
  ```typescript
  await (fs.unlink(commitMsgFile) as unknown).catch(() => {
  ```

- **src/domain/git.ts:1706** - Property access masking - should use proper types
  ```typescript
  if (err instanceof Error && (err.message as unknown).includes("CONFLICT")) {
  ```

- **src/domain/git.ts:1753** - Property access masking - should use proper types
  ```typescript
  .replace(/[^\w-]/g, "") as unknown
  ```

- **src/domain/git.ts:1754** - Property access masking - should use proper types
  ```typescript
  ).replace(/--+/g, "-") as unknown
  ```

- **src/domain/git.ts:1784** - Property access masking - should use proper types
  ```typescript
  await this.execInRepository(workdir, `git merge --no-ff ${(options as unknown).prBranch}`);
  ```

- **src/domain/git.ts:1787** - Property access masking - should use proper types
  ```typescript
  const commitHash = ((await this.execInRepository(workdir, "git rev-parse HEAD")) as unknown).trim();
  ```

- **src/domain/git.ts:1790** - Property access masking - should use proper types
  ```typescript
  const mergeDate = (new Date() as unknown).toISOString();
  ```

- **src/domain/git.ts:1791** - Property access masking - should use proper types
  ```typescript
  const mergedBy = ((await this.execInRepository(workdir, "git config user.name")) as unknown).trim();
  ```

- **src/domain/git.ts:1797** - Property access masking - should use proper types
  ```typescript
  await this.execInRepository(workdir, `git push origin --delete ${(options as unknown).prBranch}`);
  ```

- **src/domain/git.ts:1800** - Property access masking - should use proper types
  ```typescript
  prBranch: (options as unknown).prBranch,
  ```

- **src/domain/git.ts:1820** - Property access masking - should use proper types
  ```typescript
  const result = (defaultBranch.trim() as unknown).replace(/^origin\//, "");
  ```

- **src/domain/git.ts:1844** - Property access masking - should use proper types
  ```typescript
  const { stdout } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1848** - Property access masking - should use proper types
  ```typescript
  const result = (stdout.trim() as unknown).replace(/^origin\//, "");
  ```

- **src/domain/git.ts:1873** - Property access masking - should use proper types
  ```typescript
  const { stdout } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1894** - Property access masking - should use proper types
  ```typescript
  const { stdout: status } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1903** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
  ```

- **src/domain/git.ts:1919** - Property access masking - should use proper types
  ```typescript
  const { stdout: stashList } = await (deps as unknown).execAsync(`git -C ${workdir} stash list`);
  ```

- **src/domain/git.ts:1926** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} stash pop`);
  ```

- **src/domain/git.ts:1943** - Property access masking - should use proper types
  ```typescript
  const { stdout: beforeHash } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1949** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} merge ${branch}`);
  ```

- **src/domain/git.ts:1954** - Property access masking - should use proper types
  ```typescript
  ((err.message as unknown).includes("Merge Conflicts Detected") ||
  ```

- **src/domain/git.ts:1955** - Property access masking - should use proper types
  ```typescript
  (err.message as unknown).includes("CONFLICT"))
  ```

- **src/domain/git.ts:1962** - Property access masking - should use proper types
  ```typescript
  const { stdout: status } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1966** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("UU") ||
  ```

- **src/domain/git.ts:1967** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("AA") ||
  ```

- **src/domain/git.ts:1968** - Property access masking - should use proper types
  ```typescript
  (status as unknown).includes("DD")
  ```

- **src/domain/git.ts:1971** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} merge --abort`);
  ```

- **src/domain/git.ts:1978** - Property access masking - should use proper types
  ```typescript
  const { stdout: afterHash } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:1997** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} add -A`);
  ```

- **src/domain/git.ts:2004** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} add .`);
  ```

- **src/domain/git.ts:2017** - Property access masking - should use proper types
  ```typescript
  const { stdout: beforeHash } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:2022** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} fetch ${remote}`);
  ```

- **src/domain/git.ts:2025** - Property access masking - should use proper types
  ```typescript
  const { stdout: afterHash } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:2045** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).mkdir(this.baseDir, { recursive: true });
  ```

- **src/domain/git.ts:2052** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).mkdir(sessionsDir, { recursive: true });
  ```

- **src/domain/git.ts:2064** - Property access masking - should use proper types
  ```typescript
  const dirContents = await (deps as unknown).readdir(workdir);
  ```

- **src/domain/git.ts:2075** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(cloneCmd);
  ```

- **src/domain/git.ts:2080** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).access(gitDir);
  ```

- **src/domain/git.ts:2098** - Property access masking - should use proper types
  ```typescript
  const record = await (deps as unknown).getSession(options.session);
  ```

- **src/domain/git.ts:2103** - Property access masking - should use proper types
  ```typescript
  const workdir = (deps as unknown).getSessionWorkdir(options.session);
  ```

- **src/domain/git.ts:2105** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
  ```

- **src/domain/git.ts:2122** - Property access masking - should use proper types
  ```typescript
  const record = await (deps as unknown).getSession(options.session);
  ```

- **src/domain/git.ts:2126** - Property access masking - should use proper types
  ```typescript
  workdir = (deps as unknown).getSessionWorkdir(options.session);
  ```

- **src/domain/git.ts:2131** - Property access masking - should use proper types
  ```typescript
  const { stdout: branchOut } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:2139** - Property access masking - should use proper types
  ```typescript
  const { stdout: branchOut } = await (deps as unknown).execAsync(
  ```

- **src/domain/git.ts:2146** - Property access masking - should use proper types
  ```typescript
  const { stdout: remotesOut } = await (deps as unknown).execAsync(`git -C ${workdir} remote`);
  ```

- **src/domain/git.ts:2148** - Property access masking - should use proper types
  ```typescript
  if (!(remotes as unknown).includes(remote)) {
  ```

- **src/domain/git.ts:2160** - Property access masking - should use proper types
  ```typescript
  await (deps as unknown).execAsync(pushCmd);
  ```

- **src/domain/git.ts:2202** - Property access masking - should use proper types
  ```typescript
  return (ConflictDetectionService as unknown).predictConflicts(repoPath, sourceBranch, targetBranch);
  ```

- **src/domain/git.ts:2213** - Property access masking - should use proper types
  ```typescript
  return (ConflictDetectionService as unknown).analyzeBranchDivergence(
  ```

- **src/domain/git.ts:2233** - Property access masking - should use proper types
  ```typescript
  return (ConflictDetectionService as unknown).mergeWithConflictPrevention(
  ```

- **src/domain/git.ts:2253** - Property access masking - should use proper types
  ```typescript
  return (ConflictDetectionService as unknown).smartSessionUpdate(
  ```

- **src/domain/git.ts:2313** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown).noStage) {
  ```

- **src/domain/git.ts:2314** - Property access masking - should use proper types
  ```typescript
  if ((params as unknown).all) {
  ```

- **src/domain/git.ts:2315** - Property access masking - should use proper types
  ```typescript
  await git.stageAll((params as unknown).repo);
  ```

- **src/domain/git.ts:2317** - Property access masking - should use proper types
  ```typescript
  await git.stageModified((params as unknown).repo);
  ```

- **src/domain/git.ts:2321** - Property access masking - should use proper types
  ```typescript
  const commitHash = await (git as unknown).commit(
  ```

- **src/domain/git.ts:2322** - Property access masking - should use proper types
  ```typescript
  (params as unknown).message,
  ```

- **src/domain/git.ts:2323** - Property access masking - should use proper types
  ```typescript
  (params as unknown).repo,
  ```

- **src/domain/git.ts:2324** - Property access masking - should use proper types
  ```typescript
  (params as unknown).amend
  ```

- **src/domain/git.ts:2329** - Property access masking - should use proper types
  ```typescript
  message: (params as unknown).message,
  ```

- **src/domain/git.ts:2333** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown).session,
  ```

- **src/domain/git.ts:2334** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown).repo,
  ```

- **src/domain/git.ts:2335** - Property access masking - should use proper types
  ```typescript
  message: (params as unknown).message,
  ```

- **src/domain/git.ts:2336** - Property access masking - should use proper types
  ```typescript
  all: (params as unknown).all,
  ```

- **src/domain/git.ts:2337** - Property access masking - should use proper types
  ```typescript
  amend: (params as unknown).amend,
  ```

- **src/domain/git.ts:2439** - Property access masking - should use proper types
  ```typescript
  const result = await (git as unknown).branch({
  ```

- **src/domain/tasks.ts:152** - Property access masking - should use proper types
  ```typescript
  if (options && (options as unknown).status) {
  ```

- **src/domain/tasks.ts:153** - Property access masking - should use proper types
  ```typescript
  return tasks.filter((task) => (task as unknown).status === (options as unknown).status);
  ```

- **src/domain/tasks.ts:163** - Property access masking - should use proper types
  ```typescript
  const exactMatch = tasks.find((task) => (task as unknown).id === id);
  ```

- **src/domain/tasks.ts:173** - Property access masking - should use proper types
  ```typescript
  const taskNumericId = parseInt((task.id as unknown).replace(/^#/, ""), 10);
  ```

- **src/domain/tasks.ts:184** - Property access masking - should use proper types
  ```typescript
  return task ? (task as unknown).status : null;
  ```

- **src/domain/tasks.ts:188** - Property access masking - should use proper types
  ```typescript
  if (!(Object.values(TASK_STATUS) as unknown).includes(status as TaskStatus)) {
  ```

- **src/domain/tasks.ts:189** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Status must be one of: ${(Object.values(TASK_STATUS) as unknown).join(", ")}`);
  ```

- **src/domain/tasks.ts:200** - Property access masking - should use proper types
  ```typescript
  const canonicalId = (task as unknown).id;
  ```

- **src/domain/tasks.ts:201** - Property access masking - should use proper types
  ```typescript
  const idNum = canonicalId.startsWith("#") ? (canonicalId as unknown).slice(1) : canonicalId;
  ```

- **src/domain/tasks.ts:205** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks.ts:208** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("```")) {
  ```

- **src/domain/tasks.ts:213** - Property access masking - should use proper types
  ```typescript
  if ((line as unknown).includes(`[#${idNum}]`)) {
  ```

- **src/domain/tasks.ts:219** - Property access masking - should use proper types
  ```typescript
  await fs.writeFile(this.filePath, (updatedLines as unknown).join("\n"), "utf-8");
  ```

- **src/domain/tasks.ts:223** - Property access masking - should use proper types
  ```typescript
  const taskIdNum = taskId.startsWith("#") ? (taskId as unknown).slice(1) : taskId;
  ```

- **src/domain/tasks.ts:224** - Property access masking - should use proper types
  ```typescript
  const normalizedTitle = (title.toLowerCase() as unknown).replace(/[^a-z0-9]+/g, "-");
  ```

- **src/domain/tasks.ts:251** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks.ts:256** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("```")) {
  ```

- **src/domain/tasks.ts:341** - Property access masking - should use proper types
  ```typescript
  const fullSpecPath = (specPath as unknown).startsWith("/") ? specPath : join(this.workspacePath, specPath);
  ```

- **src/domain/tasks.ts:353** - Property access masking - should use proper types
  ```typescript
  const titleLine = lines.find((line) => (line as unknown).startsWith("# "));
  ```

- **src/domain/tasks.ts:362** - Property access masking - should use proper types
  ```typescript
  const titleWithIdMatch = (titleLine as unknown).match(/^# Task #(\d+): (.+)$/);
  ```

- **src/domain/tasks.ts:363** - Property access masking - should use proper types
  ```typescript
  const titleWithoutIdMatch = (titleLine as unknown).match(/^# Task: (.+)$/);
  ```

- **src/domain/tasks.ts:364** - Property access masking - should use proper types
  ```typescript
  const cleanTitleMatch = (titleLine as unknown).match(/^# (.+)$/);
  ```

- **src/domain/tasks.ts:382** - Property access masking - should use proper types
  ```typescript
  if ((title as unknown).startsWith("Task ")) {
  ```

- **src/domain/tasks.ts:401** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("## ")) break;
  ```

- **src/domain/tasks.ts:413** - Property access masking - should use proper types
  ```typescript
  if (existingTask && !(options as unknown).force) {
  ```

- **src/domain/tasks.ts:421** - Property access masking - should use proper types
  ```typescript
  const id = parseInt((task as unknown).id.slice(1));
  ```

- **src/domain/tasks.ts:427** - Property access masking - should use proper types
  ```typescript
  const taskIdNum = (taskId as unknown).slice(1); // Remove the # prefix for file naming
  ```

- **src/domain/tasks.ts:430** - Property access masking - should use proper types
  ```typescript
  const normalizedTitle = (title.toLowerCase() as unknown).replace(/[^a-z0-9]+/g, "-");
  ```

- **src/domain/tasks.ts:452** - Property access masking - should use proper types
  ```typescript
  if (!(options as unknown).force) {
  ```

- **src/domain/tasks.ts:524** - Property access masking - should use proper types
  ```typescript
  const data = (parsed as unknown).data || {};
  ```

- **src/domain/tasks.ts:525** - Property access masking - should use proper types
  ```typescript
  (data as unknown).merge_info = {
  ```

- **src/domain/tasks.ts:526** - Property access masking - should use proper types
  ```typescript
  ...(data as unknown).merge_info,
  ```

- **src/domain/tasks.ts:531** - Property access masking - should use proper types
  ```typescript
  const updatedContent = (matter as unknown).stringify((parsed as unknown).content, data as unknown);
  ```

- **src/domain/tasks.ts:556** - Property access masking - should use proper types
  ```typescript
  const taskIdNum = (task as unknown).id.startsWith("#") ? (task as unknown).id.slice(1) : (task as unknown).id;
  ```

- **src/domain/tasks.ts:561** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks.ts:566** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("```")) {
  ```

- **src/domain/tasks.ts:573** - Property access masking - should use proper types
  ```typescript
  if ((line as unknown).includes(`[#${taskIdNum}]`)) {
  ```

- **src/domain/tasks.ts:585** - Property access masking - should use proper types
  ```typescript
  await fs.writeFile(this.filePath, (updatedLines as unknown).join("\n"), "utf-8");
  ```

- **src/domain/tasks.ts:674** - Property access masking - should use proper types
  ```typescript
  const selectedBackend = this.backends.find((b) => (b as unknown).name === backend);
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

- **src/domain/tasks.ts:721** - Property access masking - should use proper types
  ```typescript
  const task = await (backend as unknown).getTask(normalizedId);
  ```

- **src/domain/tasks.ts:731** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).deleteTask(id, options as unknown);
  ```

- **src/domain/repository-uri.ts:69** - Property access masking - should use proper types
  ```typescript
  normalized: (normalizedInfo as unknown).name,
  ```

- **src/domain/repository-uri.ts:73** - Property access masking - should use proper types
  ```typescript
  switch ((normalizedInfo as unknown).format) {
  ```

- **src/domain/repository-uri.ts:75** - Property access masking - should use proper types
  ```typescript
  (components as unknown).type = (RepositoryURIType as unknown)?.HTTPS;
  ```

- **src/domain/repository-uri.ts:76** - Property access masking - should use proper types
  ```typescript
  (components as unknown).scheme = "https";
  ```

- **src/domain/repository-uri.ts:79** - Property access masking - should use proper types
  ```typescript
  (components as unknown).type = (RepositoryURIType as unknown)?.SSH;
  ```

- **src/domain/repository-uri.ts:80** - Property access masking - should use proper types
  ```typescript
  (components as unknown).scheme = "ssh";
  ```

- **src/domain/repository-uri.ts:83** - Property access masking - should use proper types
  ```typescript
  (components as unknown).type = (RepositoryURIType as unknown)?.LOCAL_FILE;
  ```

- **src/domain/repository-uri.ts:84** - Property access masking - should use proper types
  ```typescript
  (components as unknown).scheme = "file";
  ```

- **src/domain/repository-uri.ts:87** - Property access masking - should use proper types
  ```typescript
  (components as unknown).type = (RepositoryURIType as unknown)?.LOCAL_PATH;
  ```

- **src/domain/repository-uri.ts:90** - Property access masking - should use proper types
  ```typescript
  (components as unknown).type = (RepositoryURIType as unknown)?.GITHUB_SHORTHAND;
  ```

- **src/domain/repository-uri.ts:95** - Property access masking - should use proper types
  ```typescript
  if (!(normalizedInfo as unknown).isLocal) {
  ```

- **src/domain/repository-uri.ts:97** - Property access masking - should use proper types
  ```typescript
  (components as unknown).owner = owner;
  ```

- **src/domain/repository-uri.ts:98** - Property access masking - should use proper types
  ```typescript
  (components as unknown)!.repo = repo;
  ```

- **src/domain/repository-uri.ts:101** - Property access masking - should use proper types
  ```typescript
  if ((components as unknown)?.type === (RepositoryURIType as unknown)?.HTTPS) {
  ```

- **src/domain/repository-uri.ts:103** - Property access masking - should use proper types
  ```typescript
  const url = new URL((normalizedInfo as unknown).uri);
  ```

- **src/domain/repository-uri.ts:104** - Property access masking - should use proper types
  ```typescript
  (components as unknown).host = url?.hostname;
  ```

- **src/domain/repository-uri.ts:108** - Property access masking - should use proper types
  ```typescript
  } else if ((components as unknown)?.type === (RepositoryURIType as unknown)?.SSH) {
  ```

- **src/domain/repository-uri.ts:112** - Property access masking - should use proper types
  ```typescript
  (components as unknown).host = match[1];
  ```

- **src/domain/repository-uri.ts:117** - Property access masking - should use proper types
  ```typescript
  if ((components as unknown)?.type === (RepositoryURIType as unknown)?.LOCAL_FILE) {
  ```

- **src/domain/repository-uri.ts:118** - Property access masking - should use proper types
  ```typescript
  (components as unknown).path = (normalizedInfo.uri as unknown).replace(/^file:\/\//, "");
  ```

- **src/domain/repository-uri.ts:120** - Property access masking - should use proper types
  ```typescript
  (components as unknown).path = (normalizedInfo as unknown)?.uri;
  ```

- **src/domain/repository-uri.ts:128** - Property access masking - should use proper types
  ```typescript
  type: (RepositoryURIType as unknown).LOCAL_PATH,
  ```

- **src/domain/repository-uri.ts:145** - Property access masking - should use proper types
  ```typescript
  return (result as unknown)!.name as unknown;
  ```

- **src/domain/repository-uri.ts:199** - Property access masking - should use proper types
  ```typescript
  return (normalized as unknown).isLocal;
  ```

- **src/domain/git.test.ts:174** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:181** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:238** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:245** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:254** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:331** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:338** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:373** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:379** - Test assertion masking type errors - should be fixed
  ```typescript
  ) as unknown,
  ```

- **src/domain/git.test.ts:410** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:435** - Test assertion masking type errors - should be fixed
  ```typescript
  })) as unknown,
  ```

- **src/domain/git.test.ts:448** - Test assertion masking type errors - should be fixed
  ```typescript
  })) as unknown,
  ```

- **src/domain/git.test.ts:462** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:485** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:503** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:523** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:540** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:566** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:594** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:613** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:632** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:658** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:677** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:697** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:716** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:720** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:764** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:792** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:796** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:818** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:822** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:825** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:845** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/git.test.ts:867** - Test assertion masking type errors - should be fixed
  ```typescript
  }) as unknown,
  ```

- **src/domain/session.ts:2052** - Property access masking - should use proper types
  ```typescript
  typeof (taskService as unknown).getTaskSpecData === "function"
  ```

- **src/domain/session.ts:2054** - Property access masking - should use proper types
  ```typescript
  const taskSpec = await (taskService as unknown).getTaskSpecData(taskId);
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

- **src/domain/rules.ts:12** - Property access masking - should use proper types
  ```typescript
  const matter = (grayMatterNamespace as unknown).default || grayMatterNamespace;
  ```

- **src/domain/rules.ts:102** - Property access masking - should use proper types
  ```typescript
  const formats: RuleFormat[] = (options as unknown).format ? [(options as unknown).format] : ["cursor", "generic"];
  ```

- **src/domain/rules.ts:107** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:115** - Property access masking - should use proper types
  ```typescript
  if (!(file as unknown).endsWith(".mdc")) continue;
  ```

- **src/domain/rules.ts:120** - Property access masking - should use proper types
  ```typescript
  debug: (options as unknown).debug,
  ```

- **src/domain/rules.ts:124** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).tag && (!(rule as unknown).tags || !(rule.tags as unknown).includes((options as unknown).tag))) {
  ```

- **src/domain/rules.ts:159** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:160** - Property access masking - should use proper types
  ```typescript
  log.debug("Getting rule", { id: bareId, requestedFormat: (options as unknown).format });
  ```

- **src/domain/rules.ts:164** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).format) {
  ```

- **src/domain/rules.ts:165** - Property access masking - should use proper types
  ```typescript
  const requestedFormat = (options as unknown).format;
  ```

- **src/domain/rules.ts:169** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:177** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:189** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:192** - Property access masking - should use proper types
  ```typescript
  dataKeys: Object.keys(data as unknown) as unknown,
  ```

- **src/domain/rules.ts:199** - Property access masking - should use proper types
  ```typescript
  name: (data as unknown).name,
  ```

- **src/domain/rules.ts:200** - Property access masking - should use proper types
  ```typescript
  description: (data as unknown).description,
  ```

- **src/domain/rules.ts:201** - Property access masking - should use proper types
  ```typescript
  globs: (data as unknown).globs,
  ```

- **src/domain/rules.ts:202** - Property access masking - should use proper types
  ```typescript
  alwaysApply: (data as unknown).alwaysApply,
  ```

- **src/domain/rules.ts:203** - Property access masking - should use proper types
  ```typescript
  tags: (data as unknown).tags,
  ```

- **src/domain/rules.ts:211** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:222** - Property access masking - should use proper types
  ```typescript
  const frontmatterEndIndex = (((content) as unknown).toString() as unknown).indexOf("---", 3);
  ```

- **src/domain/rules.ts:223** - Property access masking - should use proper types
  ```typescript
  if ((content as unknown).startsWith("---") && frontmatterEndIndex > 0) {
  ```

- **src/domain/rules.ts:224** - Property access masking - should use proper types
  ```typescript
  extractedContent = ((((content).toString().substring(frontmatterEndIndex + 3)) as unknown).toString() as unknown).trim();
  ```

- **src/domain/rules.ts:238** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:253** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).format === format) continue;
  ```

- **src/domain/rules.ts:258** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:266** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:277** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:280** - Property access masking - should use proper types
  ```typescript
  dataKeys: Object.keys(data as unknown) as unknown,
  ```

- **src/domain/rules.ts:286** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).format && format !== (options as unknown).format) {
  ```

- **src/domain/rules.ts:288** - Property access masking - should use proper types
  ```typescript
  const requestedFormat = (options as unknown).format;
  ```

- **src/domain/rules.ts:294** - Property access masking - should use proper types
  ```typescript
  name: (data as unknown).name,
  ```

- **src/domain/rules.ts:295** - Property access masking - should use proper types
  ```typescript
  description: (data as unknown).description,
  ```

- **src/domain/rules.ts:296** - Property access masking - should use proper types
  ```typescript
  globs: (data as unknown).globs,
  ```

- **src/domain/rules.ts:297** - Property access masking - should use proper types
  ```typescript
  alwaysApply: (data as unknown).alwaysApply,
  ```

- **src/domain/rules.ts:298** - Property access masking - should use proper types
  ```typescript
  tags: (data as unknown).tags,
  ```

- **src/domain/rules.ts:309** - Property access masking - should use proper types
  ```typescript
  name: (data as unknown).name,
  ```

- **src/domain/rules.ts:310** - Property access masking - should use proper types
  ```typescript
  description: (data as unknown).description,
  ```

- **src/domain/rules.ts:311** - Property access masking - should use proper types
  ```typescript
  globs: (data as unknown).globs,
  ```

- **src/domain/rules.ts:312** - Property access masking - should use proper types
  ```typescript
  alwaysApply: (data as unknown).alwaysApply,
  ```

- **src/domain/rules.ts:313** - Property access masking - should use proper types
  ```typescript
  tags: (data as unknown).tags,
  ```

- **src/domain/rules.ts:320** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:330** - Property access masking - should use proper types
  ```typescript
  const frontmatterEndIndex = (((content) as unknown).toString() as unknown).indexOf("---", 3);
  ```

- **src/domain/rules.ts:331** - Property access masking - should use proper types
  ```typescript
  if ((content as unknown).startsWith("---") && frontmatterEndIndex > 0) {
  ```

- **src/domain/rules.ts:332** - Property access masking - should use proper types
  ```typescript
  extractedContent = ((((content).toString().substring(frontmatterEndIndex + 3)) as unknown).toString() as unknown).trim();
  ```

- **src/domain/rules.ts:344** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:355** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).debug) {
  ```

- **src/domain/rules.ts:356** - Property access masking - should use proper types
  ```typescript
  log.error("Rule not found in any format", { id: bareId, requestedFormat: (options as unknown).format });
  ```

- **src/domain/rules.ts:359** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).format) {
  ```

- **src/domain/rules.ts:361** - Property access masking - should use proper types
  ```typescript
  `Rule '${id}' not found in '${(options as unknown).format}' format or any other available format`
  ```

- **src/domain/rules.ts:376** - Property access masking - should use proper types
  ```typescript
  const format = (options as unknown).format || "cursor";
  ```

- **src/domain/rules.ts:384** - Property access masking - should use proper types
  ```typescript
  if (existsSync(filePath) && !(options as unknown).overwrite) {
  ```

- **src/domain/rules.ts:390** - Property access masking - should use proper types
  ```typescript
  (Object.entries(meta) as unknown).forEach(([key, value]) => {
  ```

- **src/domain/rules.ts:406** - Property access masking - should use proper types
  ```typescript
  globs: (cleanMeta as unknown).globs,
  ```

- **src/domain/rules.ts:429** - Property access masking - should use proper types
  ```typescript
  if (!(options as unknown).content && !(options as unknown).meta) {
  ```

- **src/domain/rules.ts:436** - Property access masking - should use proper types
  ```typescript
  name: (rule as unknown).name,
  ```

- **src/domain/rules.ts:437** - Property access masking - should use proper types
  ```typescript
  description: (rule as unknown).description,
  ```

- **src/domain/rules.ts:438** - Property access masking - should use proper types
  ```typescript
  globs: (rule as unknown).globs,
  ```

- **src/domain/rules.ts:439** - Property access masking - should use proper types
  ```typescript
  alwaysApply: (rule as unknown).alwaysApply,
  ```

- **src/domain/rules.ts:440** - Property access masking - should use proper types
  ```typescript
  tags: (rule as unknown).tags,
  ```

- **src/domain/rules.ts:444** - Property access masking - should use proper types
  ```typescript
  const mergedMeta = { ...currentRuleMeta, ...(options as unknown).meta };
  ```

- **src/domain/rules.ts:449** - Property access masking - should use proper types
  ```typescript
  (Object.prototype.hasOwnProperty as unknown).call(mergedMeta, key) &&
  ```

- **src/domain/rules.ts:457** - Property access masking - should use proper types
  ```typescript
  const updatedContent = (options as unknown).content || (rule as unknown).content;
  ```

- **src/domain/rules.ts:463** - Property access masking - should use proper types
  ```typescript
  await fs.writeFile((rule as unknown).path, fileContent, "utf-8");
  ```

- **src/domain/rules.ts:466** - Property access masking - should use proper types
  ```typescript
  _path: (rule as unknown).path,
  ```

- **src/domain/rules.ts:468** - Property access masking - should use proper types
  ```typescript
  format: (rule as unknown).format,
  ```

- **src/domain/rules.ts:469** - Property access masking - should use proper types
  ```typescript
  contentChanged: !!(options as unknown).content,
  ```

- **src/domain/rules.ts:470** - Property access masking - should use proper types
  ```typescript
  metaChanged: !!(options as unknown).meta,
  ```

- **src/domain/rules.ts:473** - Property access masking - should use proper types
  ```typescript
  return this.getRule(id, { format: (rule as unknown).format, debug: (ruleOptions as unknown).debug }); // Re-fetch to get updated rule
  ```

- **src/domain/rules.ts:482** - Property access masking - should use proper types
  ```typescript
  format: (options as unknown).format,
  ```

- **src/domain/rules.ts:483** - Property access masking - should use proper types
  ```typescript
  tag: (options as unknown).tag,
  ```

- **src/domain/rules.ts:487** - Property access masking - should use proper types
  ```typescript
  if (!(options as unknown).query) {
  ```

- **src/domain/rules.ts:491** - Property access masking - should use proper types
  ```typescript
  const searchTerm = (options.query as unknown).toLowerCase();
  ```

- **src/domain/rules.ts:496** - Property access masking - should use proper types
  ```typescript
  if ((((rule.content.toLowerCase()) as unknown).toString() as unknown).includes(searchTerm)) {
  ```

- **src/domain/rules.ts:501** - Property access masking - should use proper types
  ```typescript
  if ((rule as unknown).name && (rule.name.toLowerCase() as unknown).includes(searchTerm)) {
  ```

- **src/domain/rules.ts:506** - Property access masking - should use proper types
  ```typescript
  if ((rule as unknown).description && (rule.description.toLowerCase() as unknown).includes(searchTerm)) {
  ```

- **src/domain/rules.ts:511** - Property access masking - should use proper types
  ```typescript
  if ((rule as unknown).tags && (rule.tags as unknown).some((tag) => (tag.toLowerCase() as unknown).includes(searchTerm))) {
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

- **src/domain/remoteGitBackend.ts:60** - Property access masking - should use proper types
  ```typescript
  this.cache = (RepositoryMetadataCache as unknown).getInstance();
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

- **src/domain/uri-utils.ts:99** - Property access masking - should use proper types
  ```typescript
  if ((normalizedUri as unknown).startsWith("https://")) {
  ```

- **src/domain/uri-utils.ts:102** - Property access masking - should use proper types
  ```typescript
  const match = (normalizedUri as unknown).match(/https:\/\/[^\/]+\/([^\/]+)\/([^\/]+?)(\.git)?$/);
  ```

- **src/domain/uri-utils.ts:108** - Property access masking - should use proper types
  ```typescript
  const repo = (match[2] as unknown).replace(/\.git$/, "");
  ```

- **src/domain/uri-utils.ts:114** - Property access masking - should use proper types
  ```typescript
  else if ((normalizedUri as unknown).includes("@") && (normalizedUri as unknown).includes(":")) {
  ```

- **src/domain/uri-utils.ts:117** - Property access masking - should use proper types
  ```typescript
  const match = (normalizedUri as unknown).match(/[^@]+@[^:]+:([^\/]+)\/([^\/]+?)(\.git)?$/);
  ```

- **src/domain/uri-utils.ts:123** - Property access masking - should use proper types
  ```typescript
  const repo = (match[2] as unknown).replace(/\.git$/, "");
  ```

- **src/domain/uri-utils.ts:129** - Property access masking - should use proper types
  ```typescript
  else if ((normalizedUri as unknown).startsWith("file://")) {
  ```

- **src/domain/uri-utils.ts:143** - Property access masking - should use proper types
  ```typescript
  else if ((normalizedUri as unknown).startsWith("/") || (normalizedUri as unknown).match(/^[A-Z]:\\/i)) {
  ```

- **src/domain/uri-utils.ts:161** - Property access masking - should use proper types
  ```typescript
  else if ((normalizedUri as unknown).match(/^[^\/]+\/[^\/]+$/)) {
  ```

- **src/domain/uri-utils.ts:215** - Property access masking - should use proper types
  ```typescript
  if ((normalized as unknown)?.format === targetFormat) {
  ```

- **src/domain/uri-utils.ts:216** - Property access masking - should use proper types
  ```typescript
  return (normalized as unknown).uri;
  ```

- **src/domain/uri-utils.ts:220** - Property access masking - should use proper types
  ```typescript
  if ((normalized as unknown)?.isLocal) {
  ```

- **src/domain/uri-utils.ts:222** - Property access masking - should use proper types
  ```typescript
  return (normalized.uri as unknown).replace(/^file:\/\//, "");
  ```

- **src/domain/uri-utils.ts:225** - Property access masking - should use proper types
  ```typescript
  return (normalized.uri as unknown).startsWith("file://") ? (normalized as unknown)?.uri : `file://${(normalized as unknown).uri}`;
  ```

- **src/domain/uri-utils.ts:231** - Property access masking - should use proper types
  ```typescript
  const [org, repo] = (normalized.name as unknown).split("/");
  ```

- **src/domain/uri-utils.ts:254** - Property access masking - should use proper types
  ```typescript
  const [owner, repo] = (normalized.name as unknown).split("/");
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

- **src/domain/validationUtils.ts:5** - Property access masking - should use proper types
  ```typescript
  return !(value as unknown).includes("\n");
  ```

- **src/domain/validationUtils.ts:11** - Property access masking - should use proper types
  ```typescript
  if (value && (value as unknown).includes("\n")) {
  ```

- **src/domain/validationUtils.ts:12** - Property access masking - should use proper types
  ```typescript
  return (validateSingleLineDescription as unknown).errorMessage;
  ```

- **src/domain/init.ts:13** - Property access masking - should use proper types
  ```typescript
  enabled: (z.boolean().optional() as unknown).default(true),
  ```

- **src/domain/init.ts:15** - Property access masking - should use proper types
  ```typescript
  port: (z.number() as unknown).optional(),
  ```

- **src/domain/init.ts:19** - Property access masking - should use proper types
  ```typescript
  mcpOnly: (z.boolean().optional() as unknown).default(false),
  ```

- **src/domain/init.ts:20** - Property access masking - should use proper types
  ```typescript
  overwrite: (z.boolean().optional() as unknown).default(false),
  ```

- **src/domain/init.ts:31** - Property access masking - should use proper types
  ```typescript
  const validatedParams = (initializeProjectParamsSchema as unknown).parse(params as unknown);
  ```

- **src/domain/init.ts:139** - Property access masking - should use proper types
  ```typescript
  if (!(fileSystem as unknown).existsSync(dirPath)) {
  ```

- **src/domain/init.ts:140** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).mkdirSync(dirPath, { recursive: true });
  ```

- **src/domain/init.ts:153** - Property access masking - should use proper types
  ```typescript
  if ((fileSystem as unknown).existsSync(filePath)) {
  ```

- **src/domain/init.ts:165** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(filePath, content);
  ```

- **src/domain/init.ts:499** - Property access masking - should use proper types
  ```typescript
  if ((fileSystem as unknown).existsSync(tasksFilePath) && !overwrite) {
  ```

- **src/domain/init.ts:504** - Property access masking - should use proper types
  ```typescript
  if (!(fileSystem as unknown).existsSync(tasksDirPath)) {
  ```

- **src/domain/init.ts:505** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).mkdirSync(tasksDirPath, { recursive: true });
  ```

- **src/domain/init.ts:509** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(tasksFilePath, "# Minsky Tasks\n\n- [ ] Example task\n");
  ```

- **src/domain/init.ts:516** - Property access masking - should use proper types
  ```typescript
  if (!(fileSystem as unknown).existsSync(rulesDirPath)) {
  ```

- **src/domain/init.ts:517** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).mkdirSync(rulesDirPath, { recursive: true });
  ```

- **src/domain/init.ts:525** - Property access masking - should use proper types
  ```typescript
  if ((fileSystem as unknown).existsSync(workflowRulePath) && !overwrite) {
  ```

- **src/domain/init.ts:529** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(workflowRulePath, getMinskyRuleContent());
  ```

- **src/domain/init.ts:530** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(indexRulePath, getRulesIndexContent());
  ```

- **src/domain/init.ts:539** - Property access masking - should use proper types
  ```typescript
  if (!(fileSystem as unknown).existsSync(cursorDirPath)) {
  ```

- **src/domain/init.ts:540** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).mkdirSync(cursorDirPath, { recursive: true });
  ```

- **src/domain/init.ts:543** - Property access masking - should use proper types
  ```typescript
  if ((fileSystem as unknown).existsSync(mcpConfigPath) && !overwrite) {
  ```

- **src/domain/init.ts:548** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(mcpConfigPath, getMCPConfigContent(mcp));
  ```

- **src/domain/init.ts:552** - Property access masking - should use proper types
  ```typescript
  if (!(fileSystem as unknown).existsSync(mcpRuleFilePath) || overwrite) {
  ```

- **src/domain/init.ts:553** - Property access masking - should use proper types
  ```typescript
  (fileSystem as unknown).writeFileSync(mcpRuleFilePath, getMCPRuleContent());
  ```

- **src/domain/repository.ts:243** - Property access masking - should use proper types
  ```typescript
  switch ((config as unknown).type) {
  ```

- **src/domain/repository.ts:244** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).LOCAL: {
  ```

- **src/domain/repository.ts:248** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).REMOTE: {
  ```

- **src/domain/repository.ts:252** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).GITHUB: {
  ```

- **src/domain/repository.ts:259** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir(session);
  ```

- **src/domain/repository.ts:260** - Property access masking - should use proper types
  ```typescript
  return await (gitService as unknown).clone({
  ```

- **src/domain/repository.ts:261** - Property access masking - should use proper types
  ```typescript
  repoUrl: (config as unknown).url || "",
  ```

- **src/domain/repository.ts:270** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:271** - Property access masking - should use proper types
  ```typescript
  const sessions = await (sessionDb as unknown).listSessions();
  ```

- **src/domain/repository.ts:272** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:273** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === repoName);
  ```

- **src/domain/repository.ts:277** - Property access masking - should use proper types
  ```typescript
  session = (repoSession as unknown).session;
  ```

- **src/domain/repository.ts:280** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:281** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir(session);
  ```

- **src/domain/repository.ts:283** - Property access masking - should use proper types
  ```typescript
  const gitStatus = await (gitService as unknown).getStatus(workdir);
  ```

- **src/domain/repository.ts:288** - Property access masking - should use proper types
  ```typescript
  ).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:314** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:315** - Property access masking - should use proper types
  ```typescript
  const sessions = await (sessionDb as unknown).listSessions();
  ```

- **src/domain/repository.ts:316** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:317** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === repoName);
  ```

- **src/domain/repository.ts:321** - Property access masking - should use proper types
  ```typescript
  session = (repoSession as unknown).session;
  ```

- **src/domain/repository.ts:324** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:325** - Property access masking - should use proper types
  ```typescript
  return (gitService as unknown).getSessionWorkdir(session);
  ```

- **src/domain/repository.ts:330** - Property access masking - should use proper types
  ```typescript
  if (!(config as unknown).url) {
  ```

- **src/domain/repository.ts:348** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:349** - Property access masking - should use proper types
  ```typescript
  const sessions = await (sessionDb as unknown).listSessions();
  ```

- **src/domain/repository.ts:350** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:351** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === repoName);
  ```

- **src/domain/repository.ts:357** - Property access masking - should use proper types
  ```typescript
  const sessionName = (repoSession as unknown).session;
  ```

- **src/domain/repository.ts:358** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir(sessionName);
  ```

- **src/domain/repository.ts:368** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:369** - Property access masking - should use proper types
  ```typescript
  const sessions = await (sessionDb as unknown).listSessions();
  ```

- **src/domain/repository.ts:370** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:371** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === repoName);
  ```

- **src/domain/repository.ts:377** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir((repoSession as unknown).session);
  ```

- **src/domain/repository.ts:378** - Property access masking - should use proper types
  ```typescript
  await (gitService as unknown).pullLatest(workdir);
  ```

- **src/domain/repository.ts:382** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:383** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir(session);
  ```

- **src/domain/repository.ts:386** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:398** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:399** - Property access masking - should use proper types
  ```typescript
  const sessions = await (sessionDb as unknown).listSessions();
  ```

- **src/domain/repository.ts:400** - Property access masking - should use proper types
  ```typescript
  const repoName = normalizeRepoName((config as unknown).url || "");
  ```

- **src/domain/repository.ts:401** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === repoName);
  ```

- **src/domain/repository.ts:407** - Property access masking - should use proper types
  ```typescript
  const workdir = (gitService as unknown).getSessionWorkdir((repoSession as unknown).session);
  ```

- **src/domain/repository.ts:410** - Property access masking - should use proper types
  ```typescript
  await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
  ```

- **src/domain/repository.ts:417** - Property access masking - should use proper types
  ```typescript
  type: (RepositoryBackendType as unknown).GITHUB,
  ```

- **src/domain/repository.ts:418** - Property access masking - should use proper types
  ```typescript
  url: (config as unknown).url,
  ```

- **src/domain/repository.ts:427** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Unsupported repository backend type: ${(config as unknown).type}`);
  ```

- **src/domain/repository.ts:452** - Property access masking - should use proper types
  ```typescript
  let backendType = (RepositoryBackendType as unknown).LOCAL;
  ```

- **src/domain/repository.ts:460** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:461** - Property access masking - should use proper types
  ```typescript
  const sessionRecord = await (sessionDb as unknown).getSession(session);
  ```

- **src/domain/repository.ts:465** - Property access masking - should use proper types
  ```typescript
  repositoryUri = (sessionRecord as unknown).repoUrl;
  ```

- **src/domain/repository.ts:467** - Property access masking - should use proper types
  ```typescript
  ((sessionRecord as unknown).backendType as RepositoryBackendType) || (RepositoryBackendType as unknown).LOCAL;
  ```

- **src/domain/repository.ts:472** - Property access masking - should use proper types
  ```typescript
  const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
  ```

- **src/domain/repository.ts:473** - Property access masking - should use proper types
  ```typescript
  const sessionRecord = await (sessionDb as unknown).getSessionByTaskId(normalizedTaskId);
  ```

- **src/domain/repository.ts:477** - Property access masking - should use proper types
  ```typescript
  repositoryUri = (sessionRecord as unknown).repoUrl;
  ```

- **src/domain/repository.ts:479** - Property access masking - should use proper types
  ```typescript
  ((sessionRecord as unknown).backendType as RepositoryBackendType) || (RepositoryBackendType as unknown).LOCAL;
  ```

- **src/domain/repository.ts:503** - Property access masking - should use proper types
  ```typescript
  if ((normalized as unknown).isLocal) {
  ```

- **src/domain/repository.ts:504** - Property access masking - should use proper types
  ```typescript
  backendType = (RepositoryBackendType as unknown).LOCAL;
  ```

- **src/domain/repository.ts:507** - Property access masking - should use proper types
  ```typescript
  if (backendType === (RepositoryBackendType as unknown).LOCAL) {
  ```

- **src/domain/repository.ts:508** - Property access masking - should use proper types
  ```typescript
  backendType = (RepositoryBackendType as unknown).GITHUB;
  ```

- **src/domain/repository.ts:514** - Property access masking - should use proper types
  ```typescript
  if ((normalized as unknown).isLocal) {
  ```

- **src/domain/repository.ts:516** - Property access masking - should use proper types
  ```typescript
  (normalized as unknown).format === UriFormat.FILE
  ```

- **src/domain/repository.ts:517** - Property access masking - should use proper types
  ```typescript
  ? (normalized.uri as unknown).replace(/^file:\/\//, "")
  ```

- **src/domain/repository.ts:518** - Property access masking - should use proper types
  ```typescript
  : (normalized as unknown).uri;
  ```

- **src/domain/repository.ts:522** - Property access masking - should use proper types
  ```typescript
  uri: (normalized as unknown).uri,
  ```

- **src/domain/repository.ts:523** - Property access masking - should use proper types
  ```typescript
  name: (normalized as unknown).name,
  ```

- **src/domain/repository.ts:524** - Property access masking - should use proper types
  ```typescript
  isLocal: (normalized as unknown).isLocal,
  ```

- **src/domain/repository.ts:527** - Property access masking - should use proper types
  ```typescript
  format: (normalized as unknown).format,
  ```

- **src/domain/repository.ts:549** - Property access masking - should use proper types
  ```typescript
  uri: (options as unknown).repo,
  ```

- **src/domain/repository.ts:550** - Property access masking - should use proper types
  ```typescript
  session: (options as unknown).session,
  ```

- **src/domain/repository.ts:554** - Property access masking - should use proper types
  ```typescript
  if ((repository as unknown).isLocal) {
  ```

- **src/domain/repository.ts:555** - Property access masking - should use proper types
  ```typescript
  return (repository as unknown).path || "";
  ```

- **src/domain/repository.ts:558** - Property access masking - should use proper types
  ```typescript
  return (repository as unknown).uri;
  ```

- **src/domain/repo-utils.ts:39** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).repo) {
  ```

- **src/domain/repo-utils.ts:40** - Property access masking - should use proper types
  ```typescript
  return (options as unknown).repo;
  ```

- **src/domain/repo-utils.ts:43** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).session) {
  ```

- **src/domain/repo-utils.ts:44** - Property access masking - should use proper types
  ```typescript
  const record = await (deps.sessionProvider as unknown).getSession((options as unknown).session);
  ```

- **src/domain/repo-utils.ts:46** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Session '${(options as unknown).session}' not found.`);
  ```

- **src/domain/repo-utils.ts:48** - Property access masking - should use proper types
  ```typescript
  return (record as unknown).repoUrl;
  ```

- **src/domain/repo-utils.ts:53** - Property access masking - should use proper types
  ```typescript
  const { stdout } = await (deps as unknown).execCwd("git rev-parse --show-toplevel");
  ```

- **src/domain/repo-utils.ts:57** - Property access masking - should use proper types
  ```typescript
  return (deps as unknown).getCurrentDirectory();
  ```

- **src/schemas/git.ts:24** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/git.ts:38** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/git.ts:49** - Property access masking - should use proper types
  ```typescript
  ...(commonRepoSchema as unknown).shape,
  ```

- **src/schemas/git.ts:57** - Property access masking - should use proper types
  ```typescript
  export const createPrParamsSchema = (gitCommonOptionsSchema as unknown).extend({
  ```

- **src/schemas/git.ts:58** - Property access masking - should use proper types
  ```typescript
  debug: (z.boolean().optional() as unknown).describe("Enable debug logging"),
  ```

- **src/schemas/git.ts:59** - Property access masking - should use proper types
  ```typescript
  noStatusUpdate: (z.boolean().optional() as unknown).describe("Skip updating task status"),
  ```

- **src/schemas/git.ts:60** - Property access masking - should use proper types
  ```typescript
  taskId: (taskIdSchema.optional() as unknown).describe("Task ID associated with this PR"),
  ```

- **src/schemas/git.ts:61** - Property access masking - should use proper types
  ```typescript
  json: (z.boolean().optional() as unknown).describe("Return output as JSON"),
  ```

- **src/schemas/git.ts:69** - Property access masking - should use proper types
  ```typescript
  export const commitChangesParamsSchema = (gitCommonOptionsSchema as unknown).extend({
  ```

- **src/schemas/git.ts:71** - Property access masking - should use proper types
  ```typescript
  amend: (z.boolean().optional() as unknown).describe("Amend the previous commit"),
  ```

- **src/schemas/git.ts:72** - Property access masking - should use proper types
  ```typescript
  all: (z.boolean().optional() as unknown).describe("Stage all changes including deletions"),
  ```

- **src/schemas/git.ts:73** - Property access masking - should use proper types
  ```typescript
  noStage: (z.boolean().optional() as unknown).describe("Skip staging changes"),
  ```

- **src/schemas/git.ts:93** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/tasks.ts:32** - Property access masking - should use proper types
  ```typescript
  export const taskListParamsSchema = (commonCommandOptionsSchema as unknown).extend({
  ```

- **src/schemas/tasks.ts:34** - Property access masking - should use proper types
  ```typescript
  limit: (z.number().optional() as unknown).describe("Limit the number of tasks returned"),
  ```

- **src/schemas/tasks.ts:50** - Property access masking - should use proper types
  ```typescript
  export const taskGetParamsSchema = (commonCommandOptionsSchema as unknown).extend({
  ```

- **src/schemas/tasks.ts:55** - Property access masking - should use proper types
  ```typescript
  ]) as unknown).describe("Task ID or array of task IDs to retrieve"),
  ```

- **src/schemas/tasks.ts:77** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/tasks.ts:95** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/tasks.ts:116** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine(
  ```

- **src/schemas/tasks.ts:119** - Property access masking - should use proper types
  ```typescript
  return (data as unknown).description || (data as unknown).descriptionPath as unknown;
  ```

- **src/schemas/tasks.ts:150** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).description || (data as unknown).descriptionPath, {
  ```

- **src/schemas/tasks.ts:169** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/tasks.ts:187** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/error.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(err as unknown).message` patterns with proper validation.
  ```

- **src/schemas/session.ts:17** - Property access masking - should use proper types
  ```typescript
  session: (sessionNameSchema as unknown).describe("Unique name of the session"),
  ```

- **src/schemas/session.ts:22** - Property access masking - should use proper types
  ```typescript
  taskId: (taskIdSchema.optional() as unknown).describe("Task ID associated with the session"),
  ```

- **src/schemas/session.ts:29** - Property access masking - should use proper types
  ```typescript
  }) as unknown).describe("Remote repository configuration"),
  ```

- **src/schemas/session.ts:50** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).name !== undefined || (data as unknown).task !== undefined, {
  ```

- **src/schemas/session.ts:64** - Property access masking - should use proper types
  ```typescript
  name: (sessionNameSchema.optional() as unknown).describe("Name for the new session"),
  ```

- **src/schemas/session.ts:65** - Property access masking - should use proper types
  ```typescript
  repo: (repoPathSchema.optional() as unknown).describe("Repository to start the session in"),
  ```

- **src/schemas/session.ts:66** - Property access masking - should use proper types
  ```typescript
  task: (taskIdSchema.optional() as unknown).describe("Task ID to associate with the session"),
  ```

- **src/schemas/session.ts:81** - Property access masking - should use proper types
  ```typescript
  if (!(data as unknown).task && !(data as unknown).description) {
  ```

- **src/schemas/session.ts:85** - Property access masking - should use proper types
  ```typescript
  return (data as unknown).name || (data as unknown).task || (data as unknown).description;
  ```

- **src/schemas/session.ts:106** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).name !== undefined || (data as unknown).task !== undefined, {
  ```

- **src/schemas/session.ts:123** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).name !== undefined || (data as unknown).task !== undefined, {
  ```

- **src/schemas/session.ts:149** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).name !== undefined || (data as unknown).task !== undefined, {
  ```

- **src/schemas/session.ts:167** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => (data as unknown).name !== undefined || (data as unknown).task !== undefined || (data as unknown).repo !== undefined, {
  ```

- **src/schemas/session.ts:193** - Property access masking - should use proper types
  ```typescript
  .merge(commonCommandOptionsSchema) as unknown).refine((data) => !((data as unknown).body && (data as unknown).bodyPath), {
  ```

- **src/schemas/session.ts:213** - Property access masking - should use proper types
  ```typescript
  }) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/session.ts:223** - Property access masking - should use proper types
  ```typescript
  export const sessionInspectParamsSchema = (z.object({}) as unknown).merge(commonCommandOptionsSchema);
  ```

- **src/schemas/runtime.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(Bun as unknown).argv` patterns with proper validation.
  ```

- **src/schemas/common.ts:15** - Property access masking - should use proper types
  ```typescript
  .min(1, "Path cannot be empty") as unknown).describe("File or directory path");
  ```

- **src/schemas/common.ts:25** - Property access masking - should use proper types
  ```typescript
  .min(1, "Repository URI cannot be empty") as unknown).describe("Repository URI");
  ```

- **src/schemas/common.ts:48** - Property access masking - should use proper types
  ```typescript
  normalized = (normalized as unknown).substring(5); // "task#".length
  ```

- **src/schemas/common.ts:53** - Property access masking - should use proper types
  ```typescript
  normalized = (normalized as unknown).substring(1);
  ```

- **src/schemas/common.ts:64** - Property access masking - should use proper types
  ```typescript
  }) as unknown).refine((val) => /^#[a-zA-Z0-9_]+$/.test(val), {
  ```

- **src/schemas/common.ts:72** - Property access masking - should use proper types
  ```typescript
  (z.boolean().optional().default(false) as unknown).describe(_description);
  ```

- **src/schemas/common.ts:89** - Property access masking - should use proper types
  ```typescript
  }) as unknown).partial();
  ```

- **src/schemas/common.ts:107** - Property access masking - should use proper types
  ```typescript
  session: (sessionSchema.optional() as unknown).describe("Session name"),
  ```

- **src/schemas/common.ts:110** - Property access masking - should use proper types
  ```typescript
  json: (z.boolean().optional() as unknown).describe("Return output as JSON"),
  ```

- **src/schemas/init.ts:15** - Property access masking - should use proper types
  ```typescript
  mcp: (z.union([z.string(), z.boolean()]) as unknown).optional(),
  ```

- **src/schemas/init.ts:19** - Property access masking - should use proper types
  ```typescript
  mcpOnly: (z.boolean() as unknown).optional(),
  ```

- **src/schemas/init.ts:20** - Property access masking - should use proper types
  ```typescript
  overwrite: (z.boolean() as unknown).optional(),
  ```

- **src/schemas/session-db-config.ts:5** - Property access masking - should use proper types
  ```typescript
  * replacing unsafe `(config as unknown)` patterns with proper validation.
  ```

- **src/utils/git-exec-enhanced.ts:52** - Property access masking - should use proper types
  ```typescript
  const startTime = (Date as unknown).now();
  ```

- **src/utils/git-exec-enhanced.ts:61** - Property access masking - should use proper types
  ```typescript
  const executionTimeMs = (Date as unknown).now() - startTime;
  ```

- **src/utils/git-exec-enhanced.ts:71** - Property access masking - should use proper types
  ```typescript
  const executionTimeMs = (Date as unknown).now() - startTime;
  ```

- **src/utils/git-exec-enhanced.ts:123** - Property access masking - should use proper types
  ```typescript
  (line as unknown).includes("CONFLICT") && (line as unknown).includes(" in ")
  ```

- **src/utils/git-exec-enhanced.ts:146** - Property access masking - should use proper types
  ```typescript
  (conflictFiles as unknown).forEach(file => {
  ```

- **src/utils/git-exec-enhanced.ts:147** - Property access masking - should use proper types
  ```typescript
  if ((output as unknown).includes(`CONFLICT (content): Merge conflict in ${file}`)) {
  ```

- **src/utils/git-exec-enhanced.ts:149** - Property access masking - should use proper types
  ```typescript
  } else if ((output as unknown).includes(`CONFLICT (add/add): Merge conflict in ${file}`)) {
  ```

- **src/utils/git-exec-enhanced.ts:151** - Property access masking - should use proper types
  ```typescript
  } else if ((output as unknown).includes(`CONFLICT (modify/delete): ${file}`)) {
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

- **src/utils/filter-messages.ts:36** - Property access masking - should use proper types
  ```typescript
  const status = (options as unknown)!.status;
  ```

- **src/utils/filter-messages.ts:41** - Property access masking - should use proper types
  ```typescript
  else if (!(options as unknown)!.all) {
  ```

- **src/utils/package-manager.ts:74** - Property access masking - should use proper types
  ```typescript
  const detectedPackageManager = (options as unknown)!.packageManager || detectPackageManager(repoPath);
  ```

- **src/utils/package-manager.ts:93** - Property access masking - should use proper types
  ```typescript
  if (!(options as unknown)!.quiet) {
  ```

- **src/utils/package-manager.ts:100** - Property access masking - should use proper types
  ```typescript
  stdio: (options as unknown)!.quiet ? "ignore" : "inherit",
  ```

- **src/utils/package-manager.ts:104** - Property access masking - should use proper types
  ```typescript
  const output = result ? (result as unknown).toString() : "";
  ```

- **src/utils/paths.ts:110** - Property access masking - should use proper types
  ```typescript
  if ((filePath as unknown).startsWith("~/")) {
  ```

- **src/utils/paths.ts:111** - Property access masking - should use proper types
  ```typescript
  return join(process.env.HOME || homedir(), (filePath as unknown).slice(2));
  ```

- **src/utils/param-schemas.ts:19** - Property access masking - should use proper types
  ```typescript
  export const optionalString = (description: string) => (z.string().describe(description) as unknown).optional();
  ```

- **src/utils/param-schemas.ts:30** - Property access masking - should use proper types
  ```typescript
  (z.boolean().describe(description) as unknown).optional();
  ```

- **src/utils/param-schemas.ts:39** - Property access masking - should use proper types
  ```typescript
  export const sessionParam = optionalString((descriptions as unknown).SESSION_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:44** - Property access masking - should use proper types
  ```typescript
  export const repoParam = optionalString((descriptions as unknown).REPO_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:49** - Property access masking - should use proper types
  ```typescript
  export const upstreamRepoParam = optionalString((descriptions as unknown).UPSTREAM_REPO_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:58** - Property access masking - should use proper types
  ```typescript
  export const jsonParam = optionalBoolean((descriptions as unknown).JSON_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:63** - Property access masking - should use proper types
  ```typescript
  export const debugParam = optionalBoolean((descriptions as unknown).DEBUG_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:72** - Property access masking - should use proper types
  ```typescript
  export const taskIdParam = optionalString((descriptions as unknown).TASK_ID_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:77** - Property access masking - should use proper types
  ```typescript
  export const taskStatusFilterParam = optionalString((descriptions as unknown).TASK_STATUS_FILTER_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:82** - Property access masking - should use proper types
  ```typescript
  export const taskStatusParam = requiredString((descriptions as unknown).TASK_STATUS_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:87** - Property access masking - should use proper types
  ```typescript
  export const taskAllParam = optionalBoolean((descriptions as unknown).TASK_ALL_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:96** - Property access masking - should use proper types
  ```typescript
  export const backendParam = optionalString((descriptions as unknown).BACKEND_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:101** - Property access masking - should use proper types
  ```typescript
  export const taskBackendParam = optionalString((descriptions as unknown).TASK_BACKEND_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:110** - Property access masking - should use proper types
  ```typescript
  export const forceParam = optionalBoolean((descriptions as unknown).FORCE_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:115** - Property access masking - should use proper types
  ```typescript
  export const overwriteParam = optionalBoolean((descriptions as unknown).OVERWRITE_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:124** - Property access masking - should use proper types
  ```typescript
  export const remoteParam = optionalString((descriptions as unknown).GIT_REMOTE_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:129** - Property access masking - should use proper types
  ```typescript
  export const branchParam = optionalString((descriptions as unknown).GIT_BRANCH_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:134** - Property access masking - should use proper types
  ```typescript
  export const gitForceParam = optionalBoolean((descriptions as unknown).GIT_FORCE_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:139** - Property access masking - should use proper types
  ```typescript
  export const noStatusUpdateParam = optionalBoolean((descriptions as unknown).NO_STATUS_UPDATE_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:148** - Property access masking - should use proper types
  ```typescript
  export const ruleContentParam = optionalString((descriptions as unknown).RULE_CONTENT_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:153** - Property access masking - should use proper types
  ```typescript
  export const ruleDescriptionParam = optionalString((descriptions as unknown).RULE_DESCRIPTION_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:158** - Property access masking - should use proper types
  ```typescript
  export const ruleNameParam = optionalString((descriptions as unknown).RULE_NAME_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:163** - Property access masking - should use proper types
  ```typescript
  export const ruleFormatParam = optionalString((descriptions as unknown).RULE_FORMAT_DESCRIPTION);
  ```

- **src/utils/param-schemas.ts:168** - Property access masking - should use proper types
  ```typescript
  export const ruleTagsParam = optionalString((descriptions as unknown).RULE_TAGS_DESCRIPTION);
  ```

- **src/utils/logger.ts:33** - Property access masking - should use proper types
  ```typescript
  const envMode = (process.env.MINSKY_LOG_MODE as unknown) || null;
  ```

- **src/utils/logger.ts:34** - Property access masking - should use proper types
  ```typescript
  const envLevel = (process.env.LOGLEVEL as unknown) || null;
  ```

- **src/utils/logger.ts:35** - Property access masking - should use proper types
  ```typescript
  const envAgentLogs = (process.env.ENABLE_AGENT_LOGS as unknown) === "true";
  ```

- **src/utils/logger.ts:107** - Property access masking - should use proper types
  ```typescript
  (format as unknown).timestamp(),
  ```

- **src/utils/logger.ts:120** - Property access masking - should use proper types
  ```typescript
  typeof (logInfo as unknown).message === "string"
  ```

- **src/utils/logger.ts:121** - Property access masking - should use proper types
  ```typescript
  ? (logInfo as unknown).message
  ```

- **src/utils/logger.ts:129** - Property access masking - should use proper types
  ```typescript
  const metadata = (Object.keys(logInfo) as unknown).reduce(
  ```

- **src/utils/logger.ts:131** - Property access masking - should use proper types
  ```typescript
  if ((["level", "message", "timestamp", "stack"] as unknown).includes(key)) {
  ```

- **src/utils/logger.ts:140** - Property access masking - should use proper types
  ```typescript
  if ((Object as unknown).keysmetadata.length > 0) {
  ```

- **src/utils/logger.ts:161** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).add(new transports.Console({ stderrLevels: [] })); // Ensure only stdout
  ```

- **src/utils/logger.ts:162** - Property access masking - should use proper types
  ```typescript
  (agentLogger.exceptions as unknown).handle(
  ```

- **src/utils/logger.ts:165** - Property access masking - should use proper types
  ```typescript
  (agentLogger.rejections as unknown).handle(
  ```

- **src/utils/logger.ts:183** - Property access masking - should use proper types
  ```typescript
  (programLogger.exceptions as unknown).handle(new transports.Console({ format: programLogFormat }));
  ```

- **src/utils/logger.ts:184** - Property access masking - should use proper types
  ```typescript
  (programLogger.rejections as unknown).handle(new transports.Console({ format: programLogFormat }));
  ```

- **src/utils/logger.ts:199** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).info(message);
  ```

- **src/utils/logger.ts:209** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).debug(message, context as unknown);
  ```

- **src/utils/logger.ts:211** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).debug(message);
  ```

- **src/utils/logger.ts:220** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).info(message, context as unknown);
  ```

- **src/utils/logger.ts:222** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).info(message);
  ```

- **src/utils/logger.ts:231** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).warn(message, context as unknown);
  ```

- **src/utils/logger.ts:233** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).warn(message);
  ```

- **src/utils/logger.ts:244** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).error(`${message}: ${(context as unknown).message}`);
  ```

- **src/utils/logger.ts:245** - Property access masking - should use proper types
  ```typescript
  if ((context as unknown).stack) {
  ```

- **src/utils/logger.ts:246** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).error((context as unknown).stack);
  ```

- **src/utils/logger.ts:251** - Property access masking - should use proper types
  ```typescript
  ((context as unknown).originalError || (context as unknown).stack)
  ```

- **src/utils/logger.ts:253** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).error(
  ```

- **src/utils/logger.ts:256** - Property access masking - should use proper types
  ```typescript
  if ((context as unknown).stack) {
  ```

- **src/utils/logger.ts:257** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).error((context as unknown).stack);
  ```

- **src/utils/logger.ts:260** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).error(message, context as unknown);
  ```

- **src/utils/logger.ts:267** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).error(message, {
  ```

- **src/utils/logger.ts:268** - Property access masking - should use proper types
  ```typescript
  originalError: (context as unknown).message,
  ```

- **src/utils/logger.ts:269** - Property access masking - should use proper types
  ```typescript
  stack: (context as unknown).stack,
  ```

- **src/utils/logger.ts:270** - Property access masking - should use proper types
  ```typescript
  name: (context as unknown).name,
  ```

- **src/utils/logger.ts:275** - Property access masking - should use proper types
  ```typescript
  ((context as unknown).originalError || (context as unknown).stack)
  ```

- **src/utils/logger.ts:277** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).error(message, context as unknown);
  ```

- **src/utils/logger.ts:279** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).error(message, context as unknown);
  ```

- **src/utils/logger.ts:283** - Property access masking - should use proper types
  ```typescript
  cli: (message: any) => (programLogger as unknown).info(String(message)),
  ```

- **src/utils/logger.ts:284** - Property access masking - should use proper types
  ```typescript
  cliWarn: (message: any) => (programLogger as unknown).warn(String(message)),
  ```

- **src/utils/logger.ts:285** - Property access masking - should use proper types
  ```typescript
  cliError: (message: any) => (programLogger as unknown).error(String(message)),
  ```

- **src/utils/logger.ts:288** - Property access masking - should use proper types
  ```typescript
  (agentLogger as unknown).level = level;
  ```

- **src/utils/logger.ts:289** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).level = level;
  ```

- **src/utils/logger.ts:292** - Property access masking - should use proper types
  ```typescript
  cliDebug: (message: any) => (programLogger as unknown).debug(String(message)),
  ```

- **src/utils/logger.ts:297** - Property access masking - should use proper types
  ```typescript
  (programLogger as unknown).debug(String(message));
  ```

- **src/utils/logger.ts:330** - Property access masking - should use proper types
  ```typescript
  (defaultLogger._internal.programLogger as unknown).error("Unhandled error or rejection, exiting.", error as unknown);
  ```

- **src/utils/logger.ts:356** - Property access masking - should use proper types
  ```typescript
  log.cli(`Is Terminal (TTY): ${Boolean((process.stdout as unknown).isTTY)}`);
  ```

- **src/utils/rules-helpers.ts:22** - Property access masking - should use proper types
  ```typescript
  return (content as unknown).toString();
  ```

- **src/utils/test-utils.ts:42** - Property access masking - should use proper types
  ```typescript
  const processExitSpy = spyOn(process, "exit" as unknown).mockImplementation(() => { throw new Error("process.exit called"); });
  ```

- **src/utils/repository-utils.ts:41** - Property access masking - should use proper types
  ```typescript
  if (!(RepositoryMetadataCache as unknown)!.instance) {
  ```

- **src/utils/repository-utils.ts:42** - Property access masking - should use proper types
  ```typescript
  (RepositoryMetadataCache as unknown)!.instance = new RepositoryMetadataCache();
  ```

- **src/utils/repository-utils.ts:44** - Property access masking - should use proper types
  ```typescript
  return (RepositoryMetadataCache as unknown)!.instance;
  ```

- **src/utils/repository-utils.ts:56** - Property access masking - should use proper types
  ```typescript
  const cacheEntry = (this.cache as unknown).get(key) as CacheEntry<T> | undefined;
  ```

- **src/utils/repository-utils.ts:57** - Property access masking - should use proper types
  ```typescript
  const now = (Date as unknown).now();
  ```

- **src/utils/repository-utils.ts:60** - Property access masking - should use proper types
  ```typescript
  if (cacheEntry && now - (cacheEntry as unknown)?.timestamp < ttl) {
  ```

- **src/utils/repository-utils.ts:61** - Property access masking - should use proper types
  ```typescript
  return (cacheEntry as unknown)!.data;
  ```

- **src/utils/repository-utils.ts:66** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).set(key, { data, timestamp: now });
  ```

- **src/utils/repository-utils.ts:77** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).set(key, { data, timestamp: (Date as unknown).now() });
  ```

- **src/utils/repository-utils.ts:86** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).delete(key);
  ```

- **src/utils/repository-utils.ts:97** - Property access masking - should use proper types
  ```typescript
  if ((key as unknown).startsWith(prefix)) {
  ```

- **src/utils/repository-utils.ts:98** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).delete(key);
  ```

- **src/utils/repository-utils.ts:107** - Property access masking - should use proper types
  ```typescript
  (this.cache as unknown).clear();
  ```

- **src/utils/test-helpers.ts:22** - Property access masking - should use proper types
  ```typescript
  if ((_options as unknown)!.recursive) {
  ```

- **src/utils/test-helpers.ts:44** - Property access masking - should use proper types
  ```typescript
  if ((_options as unknown)!.recursive) {
  ```

- **src/utils/test-helpers.ts:45** - Property access masking - should use proper types
  ```typescript
  const children = Array.from(virtualFS.keys()).filter((key) => (key as unknown).startsWith(`${path}/`));
  ```

- **src/utils/test-helpers.ts:68** - Property access masking - should use proper types
  ```typescript
  if (!file || (file as unknown)?.isDirectory) {
  ```

- **src/utils/test-helpers.ts:71** - Property access masking - should use proper types
  ```typescript
  return (file as unknown)?.content || "";
  ```

- **src/utils/test-helpers.ts:100** - Property access masking - should use proper types
  ```typescript
  return `/tmp/${prefix}-${(process as any)?.pid || 0}-${(Date as any).now()}-${(Math.random().toString(UUID_LENGTH) as unknown).substring(2, SHORT_ID_LENGTH)}`;
  ```

- **src/utils/test-helpers.ts:179** - Property access masking - should use proper types
  ```typescript
  if (!result || (result as unknown)!.status === null) {
  ```

- **src/utils/test-helpers.ts:184** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown)!.status !== 0) {
  ```

- **src/utils/test-helpers.ts:185** - Property access masking - should use proper types
  ```typescript
  log.error(`Command failed with status ${(result as unknown)!.status}`);
  ```

- **src/utils/test-helpers.ts:186** - Property access masking - should use proper types
  ```typescript
  log.error(`Stderr: ${(result as unknown)!.stderr}`);
  ```

- **src/mcp/command-mapper.ts:27** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (projectContext as unknown).repositoryPath,
  ```

- **src/mcp/command-mapper.ts:84** - Property access masking - should use proper types
  ```typescript
  const normalizedName = this.normalizeMethodName((command as unknown).name);
  ```

- **src/mcp/command-mapper.ts:89** - Property access masking - should use proper types
  ```typescript
  originalName: (command as unknown).name,
  ```

- **src/mcp/command-mapper.ts:90** - Property access masking - should use proper types
  ```typescript
  description: (command as unknown).description,
  ```

- **src/mcp/command-mapper.ts:91** - Property access masking - should use proper types
  ```typescript
  hasParameters: (command as unknown).parameters ? true : false,
  ```

- **src/mcp/command-mapper.ts:98** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/command-mapper.ts:100** - Property access masking - should use proper types
  ```typescript
  description: (command as unknown).description,
  ```

- **src/mcp/command-mapper.ts:101** - Property access masking - should use proper types
  ```typescript
  parameters: (command as unknown).parameters || z.object({}),
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

- **src/mcp/command-mapper.ts:151** - Property access masking - should use proper types
  ```typescript
  if ((normalizedName as unknown).includes(".")) {
  ```

- **src/mcp/command-mapper.ts:165** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).addTool({
  ```

- **src/mcp/command-mapper.ts:167** - Property access masking - should use proper types
  ```typescript
  description: `${(command as unknown).description} (underscore alias)`,
  ```

- **src/mcp/command-mapper.ts:168** - Property access masking - should use proper types
  ```typescript
  parameters: (command as unknown).parameters || z.object({}),
  ```

- **src/mcp/command-mapper.ts:181** - Property access masking - should use proper types
  ```typescript
  (this.projectContext as unknown).repositoryPath &&
  ```

- **src/mcp/command-mapper.ts:188** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/command-mapper.ts:231** - Property access masking - should use proper types
  ```typescript
  const hasRepositoryPath = (Object.keys(parameters.shape) as unknown).includes("repositoryPath");
  ```

- **src/mcp/command-mapper.ts:236** - Property access masking - should use proper types
  ```typescript
  extendedParameters = (parameters as unknown).extend({
  ```

- **src/mcp/command-mapper.ts:270** - Property access masking - should use proper types
  ```typescript
  const hasRepositoryPath = (Object.keys(parameters.shape) as unknown).includes("repositoryPath");
  ```

- **src/mcp/command-mapper.ts:274** - Property access masking - should use proper types
  ```typescript
  extendedParameters = (parameters as unknown).extend({
  ```

- **src/mcp/command-mapper.ts:308** - Property access masking - should use proper types
  ```typescript
  const hasRepositoryPath = (Object.keys(parameters.shape) as unknown).includes("repositoryPath");
  ```

- **src/mcp/command-mapper.ts:312** - Property access masking - should use proper types
  ```typescript
  extendedParameters = (parameters as unknown).extend({
  ```

- **src/mcp/command-mapper.ts:346** - Property access masking - should use proper types
  ```typescript
  const hasRepositoryPath = (Object.keys(parameters.shape) as unknown).includes("repositoryPath");
  ```

- **src/mcp/command-mapper.ts:350** - Property access masking - should use proper types
  ```typescript
  extendedParameters = (parameters as unknown).extend({
  ```

- **src/mcp/server.ts:99** - Property access masking - should use proper types
  ```typescript
  this.projectContext = (options as unknown).projectContext || createProjectContextFromCwd();
  ```

- **src/mcp/server.ts:101** - Property access masking - should use proper types
  ```typescript
  repositoryPath: (this.projectContext as unknown).repositoryPath,
  ```

- **src/mcp/server.ts:115** - Property access masking - should use proper types
  ```typescript
  name: (options as unknown).name || "Minsky MCP Server",
  ```

- **src/mcp/server.ts:116** - Property access masking - should use proper types
  ```typescript
  version: (options as unknown).version || "1.0.0", // Should be dynamically pulled from package.json
  ```

- **src/mcp/server.ts:117** - Property access masking - should use proper types
  ```typescript
  /* TODO: Verify if transportType is valid property */ transportType: (options as unknown).transportType || "stdio",
  ```

- **src/mcp/server.ts:120** - Property access masking - should use proper types
  ```typescript
  /* TODO: Verify if endpoint is valid property */ endpoint: (options.sse as unknown).endpoint || "/sse",
  ```

- **src/mcp/server.ts:121** - Property access masking - should use proper types
  ```typescript
  port: (options.sse as unknown).port || 8080,
  ```

- **src/mcp/server.ts:122** - Property access masking - should use proper types
  ```typescript
  host: (options.sse as unknown).host || "localhost",
  ```

- **src/mcp/server.ts:123** - Property access masking - should use proper types
  ```typescript
  path: (options.sse as unknown).path || "/sse",
  ```

- **src/mcp/server.ts:126** - Property access masking - should use proper types
  ```typescript
  endpoint: (options.httpStream as unknown).endpoint || "/mcp",
  ```

- **src/mcp/server.ts:127** - Property access masking - should use proper types
  ```typescript
  port: (options.httpStream as unknown).port || 8080,
  ```

- **src/mcp/server.ts:132** - Property access masking - should use proper types
  ```typescript
  const serverName = (this.options as unknown).name || "Minsky MCP Server";
  ```

- **src/mcp/server.ts:141** - Property access masking - should use proper types
  ```typescript
  enabled: (this.options as unknown).transportType !== "stdio",
  ```

- **src/mcp/server.ts:157** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).on("connect", () => {
  ```

- **src/mcp/server.ts:162** - Property access masking - should use proper types
  ```typescript
  (this.server as unknown).on("disconnect", () => {
  ```

- **src/mcp/server.ts:174** - Property access masking - should use proper types
  ```typescript
  if (!(this.options as unknown).transportType) {
  ```

- **src/mcp/server.ts:175** - Property access masking - should use proper types
  ```typescript
  (this.options as unknown).transportType = "stdio";
  ```

- **src/mcp/server.ts:178** - Property access masking - should use proper types
  ```typescript
  if ((this.options as unknown).transportType === "stdio") {
  ```

- **src/mcp/server.ts:179** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({ transportType: "stdio" });
  ```

- **src/mcp/server.ts:180** - Property access masking - should use proper types
  ```typescript
  } else if ((this.options as unknown).transportType === "sse" && (this.options as unknown).sse) {
  ```

- **src/mcp/server.ts:181** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({
  ```

- **src/mcp/server.ts:185** - Property access masking - should use proper types
  ```typescript
  port: (this.options.sse as unknown).port || 8080,
  ```

- **src/mcp/server.ts:188** - Property access masking - should use proper types
  ```typescript
  } else if ((this.options as unknown).transportType === "httpStream" && (this.options as unknown).httpStream) {
  ```

- **src/mcp/server.ts:189** - Property access masking - should use proper types
  ```typescript
  await (this.server as unknown).start({
  ```

- **src/mcp/server.ts:193** - Property access masking - should use proper types
  ```typescript
  port: (this.options.httpStream as unknown).port || 8080,
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
  methods.push(...Object.keys((this.server as unknown)._tools) as unknown);
  ```

- **src/mcp/fastmcp-server.ts:38** - Property access masking - should use proper types
  ```typescript
  name: (options as unknown).name ?? "Minsky MCP Server",
  ```

- **src/mcp/fastmcp-server.ts:39** - Property access masking - should use proper types
  ```typescript
  version: (options as unknown).version ?? "1.0.0",
  ```

- **src/mcp/fastmcp-server.ts:40** - Property access masking - should use proper types
  ```typescript
  /* TODO: Verify if transportType is valid property */ transportType: (options as unknown).transportType ?? "stdio",
  ```

- **src/mcp/fastmcp-server.ts:41** - Property access masking - should use proper types
  ```typescript
  projectContext: (options as unknown).projectContext ?? createProjectContextFromCwd(),
  ```

- **src/mcp/fastmcp-server.ts:43** - Property access masking - should use proper types
  ```typescript
  host: (options.sse as unknown).host ?? "localhost",
  ```

- **src/mcp/fastmcp-server.ts:44** - Property access masking - should use proper types
  ```typescript
  path: (options.sse as unknown).path ?? "/sse",
  ```

- **src/mcp/fastmcp-server.ts:45** - Property access masking - should use proper types
  ```typescript
  port: (options.sse as unknown).port ?? 3000
  ```

- **src/mcp/fastmcp-server.ts:48** - Property access masking - should use proper types
  ```typescript
  endpoint: (options.httpStream as unknown).endpoint ?? "/mcp",
  ```

- **src/mcp/fastmcp-server.ts:49** - Property access masking - should use proper types
  ```typescript
  port: (options.httpStream as unknown).port ?? 8080
  ```

- **src/mcp/fastmcp-server.ts:53** - Property access masking - should use proper types
  ```typescript
  this.projectContext = (this.options as unknown).projectContext;
  ```

- **src/mcp/fastmcp-server.ts:57** - Property access masking - should use proper types
  ```typescript
  name: (this.options as unknown).name,
  ```

- **src/mcp/fastmcp-server.ts:58** - Property access masking - should use proper types
  ```typescript
  version: (this.options as unknown).version,
  ```

- **src/mcp/fastmcp-server.ts:80** - Property access masking - should use proper types
  ```typescript
  log.agent(`Starting ${(this.options as unknown).name} with ${(this.options as unknown).transportType} transport`);
  ```

- **src/mcp/fastmcp-server.ts:82** - Property access masking - should use proper types
  ```typescript
  if ((this.options as unknown).transportType === "stdio") {
  ```

- **src/mcp/fastmcp-server.ts:85** - Property access masking - should use proper types
  ```typescript
  } else if ((this.options as unknown).transportType === "sse") {
  ```

- **src/mcp/fastmcp-server.ts:90** - Property access masking - should use proper types
  ```typescript
  port: (this.options.sse as unknown).port
  ```

- **src/mcp/fastmcp-server.ts:94** - Property access masking - should use proper types
  ```typescript
  `MCP Server started with HTTP Stream transport (SSE fallback) on port ${(this.options.sse as unknown).port}`
  ```

- **src/mcp/fastmcp-server.ts:96** - Property access masking - should use proper types
  ```typescript
  } else if ((this.options as unknown).transportType === "httpStream") {
  ```

- **src/mcp/fastmcp-server.ts:100** - Property access masking - should use proper types
  ```typescript
  port: (this.options.httpStream as unknown).port
  ```

- **src/mcp/fastmcp-server.ts:104** - Property access masking - should use proper types
  ```typescript
  `MCP Server started with HTTP Stream transport on port ${(this.options.httpStream as unknown).port}`
  ```

- **src/mcp/fastmcp-server.ts:107** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Unsupported transport type: ${(this.options as unknown).transportType}`);
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

- **src/mcp/fastmcp-command-mapper.ts:81** - Property access masking - should use proper types
  ```typescript
  name: (command as unknown).name,
  ```

- **src/mcp/fastmcp-command-mapper.ts:82** - Property access masking - should use proper types
  ```typescript
  description: (command as unknown).description,
  ```

- **src/mcp/inspector-launcher.ts:101** - Property access masking - should use proper types
  ```typescript
  SERVER_PORT: ((port + 3) as unknown).toString(), // Use a different port for the inspector server
  ```

- **src/mcp/inspector-launcher.ts:106** - Property access masking - should use proper types
  ```typescript
  (env as unknown).MCP_AUTO_OPEN_ENABLED = "false";
  ```

- **src/mcp/inspector-launcher.ts:110** - Property access masking - should use proper types
  ```typescript
  (env as unknown).DANGEROUSLY_OMIT_AUTH = "true";
  ```

- **src/mcp/inspector-launcher.ts:133** - Property access masking - should use proper types
  ```typescript
  if (!(inspectorProcess as unknown).pid) {
  ```

- **src/mcp/inspector-launcher.ts:141** - Property access masking - should use proper types
  ```typescript
  (inspectorProcess as unknown).on("error", (error) => {
  ```

- **src/mcp/inspector-launcher.ts:148** - Property access masking - should use proper types
  ```typescript
  (inspectorProcess.stderr as unknown).on("data", (data) => {
  ```

- **src/mcp/inspector-launcher.ts:149** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP Inspector stderr: ${(data as unknown)!.toString()}`);
  ```

- **src/mcp/inspector-launcher.ts:152** - Property access masking - should use proper types
  ```typescript
  (inspectorProcess as unknown).on("exit", (code, signal) => {
  ```

- **src/commands/mcp/index.ts:38** - Property access masking - should use proper types
  ```typescript
  (mcpCommand as unknown).description("Model Context Protocol (MCP) server commands");
  ```

- **src/commands/mcp/index.ts:42** - Property access masking - should use proper types
  ```typescript
  (startCommand as unknown).description("Start the MCP server");
  ```

- **src/commands/mcp/index.ts:46** - Property access masking - should use proper types
  ```typescript
  .option("-p, --port <port>", "Port for HTTP Stream server", (DEFAULT_DEV_PORT as unknown).toString())
  ```

- **src/commands/mcp/index.ts:53** - Property access masking - should use proper types
  ```typescript
  .option("--inspector-port <port>", "Port for the MCP inspector", (INSPECTOR_PORT as unknown).toString()) as unknown).action(async (options) => {
  ```

- **src/commands/mcp/index.ts:57** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).httpStream) {
  ```

- **src/commands/mcp/index.ts:62** - Property access masking - should use proper types
  ```typescript
  const port = parseInt((options as unknown).port, 10);
  ```

- **src/commands/mcp/index.ts:66** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).repo) {
  ```

- **src/commands/mcp/index.ts:67** - Property access masking - should use proper types
  ```typescript
  const repositoryPath = path.resolve((options as unknown).repo);
  ```

- **src/commands/mcp/index.ts:85** - Property access masking - should use proper types
  ```typescript
  if ((SharedErrorHandler as unknown).isDebugMode() && error instanceof Error) {
  ```

- **src/commands/mcp/index.ts:95** - Property access masking - should use proper types
  ```typescript
  host: (options as unknown).host,
  ```

- **src/commands/mcp/index.ts:98** - Property access masking - should use proper types
  ```typescript
  inspectorPort: (options as unknown).inspectorPort,
  ```

- **src/commands/mcp/index.ts:109** - Property access masking - should use proper types
  ```typescript
  host: (options as unknown).host,
  ```

- **src/commands/mcp/index.ts:120** - Property access masking - should use proper types
  ```typescript
  (server as unknown).getFastMCPServer(),
  ```

- **src/commands/mcp/index.ts:121** - Property access masking - should use proper types
  ```typescript
  (server as unknown).getProjectContext()
  ```

- **src/commands/mcp/index.ts:137** - Property access masking - should use proper types
  ```typescript
  await (server as unknown).start();
  ```

- **src/commands/mcp/index.ts:141** - Property access masking - should use proper types
  ```typescript
  log.cli(`Repository path: ${(projectContext as unknown).repositoryPath}`);
  ```

- **src/commands/mcp/index.ts:144** - Property access masking - should use proper types
  ```typescript
  log.cli(`Listening on ${(options as unknown).host}:${port}`);
  ```

- **src/commands/mcp/index.ts:148** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).withInspector) {
  ```

- **src/commands/mcp/index.ts:155** - Property access masking - should use proper types
  ```typescript
  const inspectorPort = parseInt((options as unknown).inspectorPort, 10);
  ```

- **src/commands/mcp/index.ts:163** - Property access masking - should use proper types
  ```typescript
  mcpHost: transportType !== "stdio" ? (options as unknown).host : undefined,
  ```

- **src/commands/mcp/index.ts:166** - Property access masking - should use proper types
  ```typescript
  if ((inspectorResult as unknown).success) {
  ```

- **src/commands/mcp/index.ts:168** - Property access masking - should use proper types
  ```typescript
  log.cli(`Open your browser at ${(inspectorResult as unknown).url} to access the inspector`);
  ```

- **src/commands/mcp/index.ts:170** - Property access masking - should use proper types
  ```typescript
  log.cliError(`Failed to start MCP Inspector: ${(inspectorResult as unknown).error}`);
  ```

- **src/commands/mcp/index.ts:191** - Property access masking - should use proper types
  ```typescript
  transportType: (options as unknown).httpStream ? "httpStream" : "stdio",
  ```

- **src/commands/mcp/index.ts:192** - Property access masking - should use proper types
  ```typescript
  port: (options as unknown).port,
  ```

- **src/commands/mcp/index.ts:193** - Property access masking - should use proper types
  ```typescript
  host: (options as unknown).host,
  ```

- **src/commands/mcp/index.ts:194** - Property access masking - should use proper types
  ```typescript
  withInspector: (options as unknown).withInspector || false,
  ```

- **src/commands/mcp/index.ts:202** - Property access masking - should use proper types
  ```typescript
  const networkError = createNetworkError(error as unknown, port, (options as unknown).host);
  ```

- **src/commands/mcp/index.ts:203** - Property access masking - should use proper types
  ```typescript
  const isDebug = (SharedErrorHandler as unknown).isDebugMode();
  ```

- **src/commands/mcp/index.ts:218** - Property access masking - should use proper types
  ```typescript
  if ((SharedErrorHandler as unknown).isDebugMode() && error instanceof Error && (error as any).stack) {
  ```

- **src/commands/config/show.ts:19** - Property access masking - should use proper types
  ```typescript
  .option("--working-dir <dir>", "Working directory", process.cwd()) as unknown).action(async (options: ShowOptions) => {
  ```

- **src/commands/config/show.ts:23** - Property access masking - should use proper types
  ```typescript
  backend: (config as unknown).get("backend"),
  ```

- **src/commands/config/show.ts:24** - Property access masking - should use proper types
  ```typescript
  backendConfig: (config as unknown).get("backendConfig"),
  ```

- **src/commands/config/show.ts:25** - Property access masking - should use proper types
  ```typescript
  credentials: (config as unknown).get("credentials"),
  ```

- **src/commands/config/show.ts:26** - Property access masking - should use proper types
  ```typescript
  sessiondb: (config as unknown).get("sessiondb"),
  ```

- **src/commands/config/show.ts:27** - Property access masking - should use proper types
  ```typescript
  ai: (config as unknown).has("ai") ? (config as unknown).get("ai") : undefined,
  ```

- **src/commands/config/show.ts:30** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).json) {
  ```

- **src/commands/config/show.ts:46** - Property access masking - should use proper types
  ```typescript
  await Bun.write(Bun.stdout, `Backend: ${(resolved as unknown).backend}\n`);
  ```

- **src/commands/config/show.ts:50** - Property access masking - should use proper types
  ```typescript
  for (const [backend, config] of Object.entries((resolved as unknown).backendConfig)) {
  ```

- **src/commands/config/show.ts:62** - Property access masking - should use proper types
  ```typescript
  for (const [service, creds] of Object.entries((resolved as unknown).credentials)) {
  ```

- **src/commands/config/show.ts:66** - Property access masking - should use proper types
  ```typescript
  if ((credsObj as unknown).source) {
  ```

- **src/commands/config/show.ts:67** - Property access masking - should use proper types
  ```typescript
  await Bun.write(Bun.stdout, `    Source: ${(credsObj as unknown).source}\n`);
  ```

- **src/commands/config/show.ts:69** - Property access masking - should use proper types
  ```typescript
  if ((credsObj as unknown).token) {
  ```

- **src/commands/config/list.ts:18** - Property access masking - should use proper types
  ```typescript
  .option("--json", "Output in JSON format", false) as unknown).action(async (options: ListOptions) => {
  ```

- **src/commands/config/list.ts:21** - Property access masking - should use proper types
  ```typescript
  const sources = (config.util as unknown).getConfigSources();
  ```

- **src/commands/config/list.ts:23** - Property access masking - should use proper types
  ```typescript
  backend: (config as unknown).get("backend"),
  ```

- **src/commands/config/list.ts:24** - Property access masking - should use proper types
  ```typescript
  backendConfig: (config as unknown).get("backendConfig"),
  ```

- **src/commands/config/list.ts:25** - Property access masking - should use proper types
  ```typescript
  credentials: (config as unknown).get("credentials"),
  ```

- **src/commands/config/list.ts:26** - Property access masking - should use proper types
  ```typescript
  sessiondb: (config as unknown).get("sessiondb"),
  ```

- **src/commands/config/list.ts:27** - Property access masking - should use proper types
  ```typescript
  ai: (config as unknown).has("ai") ? (config as unknown).get("ai") : undefined,
  ```

- **src/commands/config/list.ts:30** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).json) {
  ```

- **src/commands/config/list.ts:34** - Property access masking - should use proper types
  ```typescript
  name: (source as unknown).name,
  ```

- **src/commands/config/list.ts:35** - Property access masking - should use proper types
  ```typescript
  original: (source as unknown).original,
  ```

- **src/commands/config/list.ts:36** - Property access masking - should use proper types
  ```typescript
  parsed: (source as unknown).parsed
  ```

- **src/commands/config/list.ts:57** - Property access masking - should use proper types
  ```typescript
  await Bun.write(Bun.stdout, `  ${sources.indexOf(source) + 1}. ${(source as unknown).name}\n`);
  ```

- **src/commands/config/list.ts:61** - Property access masking - should use proper types
  ```typescript
  await Bun.write(Bun.stdout, `Backend: ${(resolved as unknown).backend}\n`);
  ```

- **src/commands/config/list.ts:63** - Property access masking - should use proper types
  ```typescript
  if ((resolved as unknown).sessiondb) {
  ```

- **src/commands/config/list.ts:64** - Property access masking - should use proper types
  ```typescript
  await Bun.write(Bun.stdout, `SessionDB Backend: ${(resolved.sessiondb as unknown).backend}\n`);
  ```

- **src/commands/config/index.ts:13** - Property access masking - should use proper types
  ```typescript
  .description("Configuration management commands") as unknown).addHelpText(
  ```

- **src/commands/config/index.ts:24** - Property access masking - should use proper types
  ```typescript
  (configCmd as unknown).addCommand(createConfigListCommand());
  ```

- **src/commands/config/index.ts:25** - Property access masking - should use proper types
  ```typescript
  (configCmd as unknown).addCommand(createConfigShowCommand());
  ```

- **src/domain/session/session-db.test.ts:195** - Test assertion masking type errors - should be fixed
  ```typescript
  } as unknown;
  ```

- **src/domain/session/session-db.ts:69** - Property access masking - should use proper types
  ```typescript
  state.sessions.find((s) => (s.taskId as unknown).replace(/^#/, "") === normalizedTaskId) ||
  ```

- **src/domain/session/session-adapter.ts:146** - Property access masking - should use proper types
  ```typescript
  await this.writeDb((newState as unknown).sessions);
  ```

- **src/domain/session/session-adapter.ts:158** - Property access masking - should use proper types
  ```typescript
  await this.writeDb((newState as unknown).sessions);
  ```

- **src/domain/session/session-adapter.ts:174** - Property access masking - should use proper types
  ```typescript
  await this.writeDb((newState as unknown).sessions);
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

- **src/domain/workspace/special-workspace-manager.ts:303** - Property access masking - should use proper types
  ```typescript
  const startTime = (Date as unknown).now();
  ```

- **src/domain/workspace/special-workspace-manager.ts:305** - Property access masking - should use proper types
  ```typescript
  while ((Date as unknown).now() - startTime < this?.lockTimeoutMs) {
  ```

- **src/domain/workspace/special-workspace-manager.ts:313** - Property access masking - should use proper types
  ```typescript
  if ((Date as unknown).now() - (lockInfo as unknown)?.timestamp > this?.lockTimeoutMs) {
  ```

- **src/domain/workspace/local-workspace-backend.ts:35** - Property access masking - should use proper types
  ```typescript
  if ((relativeToBoundary as unknown).startsWith("..") || relativeToBoundary === "..") {
  ```

- **src/domain/workspace/local-workspace-backend.ts:63** - Property access masking - should use proper types
  ```typescript
  name: (relativePath.split("/") as unknown).pop() || relativePath,
  ```

- **src/domain/workspace/local-workspace-backend.ts:66** - Property access masking - should use proper types
  ```typescript
  size: stats.isFile() ? (stats as unknown)?.size : undefined,
  ```

- **src/domain/workspace/local-workspace-backend.ts:132** - Property access masking - should use proper types
  ```typescript
  const tempPath = `${fullPath}.tmp.${(Date as unknown).now()}`;
  ```

- **src/domain/workspace/local-workspace-backend.ts:262** - Property access masking - should use proper types
  ```typescript
  return (fileInfos as unknown).sort((a, b) => {
  ```

- **src/domain/workspace/local-workspace-backend.ts:264** - Property access masking - should use proper types
  ```typescript
  if ((a as unknown)?.type !== (b as unknown)?.type) {
  ```

- **src/domain/workspace/local-workspace-backend.ts:265** - Property access masking - should use proper types
  ```typescript
  return (a as unknown)?.type === "directory" ? -1 : 1;
  ```

- **src/domain/workspace/local-workspace-backend.ts:267** - Property access masking - should use proper types
  ```typescript
  return (a.name as unknown).localeCompare((b as unknown).name);
  ```

- **src/domain/workspace/local-workspace-backend.ts:276** - Property access masking - should use proper types
  ```typescript
  throw new FileNotFoundError(workspaceDir, relativePath || ".", error as unknown);
  ```

- **src/domain/storage/json-file-storage.ts:100** - Property access masking - should use proper types
  ```typescript
  this.filePath = (options as unknown).filePath;
  ```

- **src/domain/storage/json-file-storage.ts:101** - Property access masking - should use proper types
  ```typescript
  this.initializeState = (options as unknown).initializeState;
  ```

- **src/domain/storage/json-file-storage.ts:102** - Property access masking - should use proper types
  ```typescript
  this.idField = (options as unknown).idField || "id";
  ```

- **src/domain/storage/json-file-storage.ts:103** - Property access masking - should use proper types
  ```typescript
  this.entitiesField = (options as unknown).entitiesField;
  ```

- **src/domain/storage/json-file-storage.ts:104** - Property access masking - should use proper types
  ```typescript
  this.prettyPrint = (options as unknown).prettyPrint !== false;
  ```

- **src/domain/storage/json-file-storage.ts:120** - Property access masking - should use proper types
  ```typescript
  const dataStr = typeof data === "string" ? data : String((data as unknown).toString());
  ```

- **src/domain/storage/json-file-storage.ts:123** - Property access masking - should use proper types
  ```typescript
  if (!(((dataStr) as unknown).toString() as unknown).trim()) {
  ```

- **src/domain/storage/json-file-storage.ts:148** - Property access masking - should use proper types
  ```typescript
  log.error(`Error reading database file ${this.filePath}: ${(typedError as unknown).message}`);
  ```

- **src/domain/storage/json-file-storage.ts:178** - Property access masking - should use proper types
  ```typescript
  (serializationError.message as unknown).includes("circular")
  ```

- **src/domain/storage/json-file-storage.ts:194** - Property access masking - should use proper types
  ```typescript
  log.error(`Error writing database file ${this.filePath}: ${(typedError as unknown).message}`);
  ```

- **src/domain/storage/json-file-storage.ts:210** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/json-file-storage.ts:214** - Property access masking - should use proper types
  ```typescript
  const state = (result as unknown).data;
  ```

- **src/domain/storage/json-file-storage.ts:216** - Property access masking - should use proper types
  ```typescript
  const entity = entities.find((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/json-file-storage.ts:228** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/json-file-storage.ts:232** - Property access masking - should use proper types
  ```typescript
  const state = (result as unknown).data;
  ```

- **src/domain/storage/json-file-storage.ts:241** - Property access masking - should use proper types
  ```typescript
  for (const [key, value] of Object.entries(options as unknown)) {
  ```

- **src/domain/storage/json-file-storage.ts:256** - Property access masking - should use proper types
  ```typescript
  return (FileOperationLock as unknown).withLock(this.filePath, async () => {
  ```

- **src/domain/storage/json-file-storage.ts:258** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:260** - Property access masking - should use proper types
  ```typescript
  `Failed to read database state: ${(result.error as unknown).message || "Unknown error"}`
  ```

- **src/domain/storage/json-file-storage.ts:264** - Property access masking - should use proper types
  ```typescript
  const state = (result as unknown).data || this.initializeState();
  ```

- **src/domain/storage/json-file-storage.ts:268** - Property access masking - should use proper types
  ```typescript
  const id = (entity as unknown)[this.idField];
  ```

- **src/domain/storage/json-file-storage.ts:269** - Property access masking - should use proper types
  ```typescript
  if (id && (entities as unknown).some((e) => (e as unknown)[this.idField] === id)) {
  ```

- **src/domain/storage/json-file-storage.ts:281** - Property access masking - should use proper types
  ```typescript
  if (!(writeResult as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:282** - Property access masking - should use proper types
  ```typescript
  throw (writeResult as unknown).error || new Error("Failed to write database state");
  ```

- **src/domain/storage/json-file-storage.ts:296** - Property access masking - should use proper types
  ```typescript
  return (FileOperationLock as unknown).withLock(this.filePath, async () => {
  ```

- **src/domain/storage/json-file-storage.ts:298** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:300** - Property access masking - should use proper types
  ```typescript
  `Failed to read database state: ${(result.error as unknown).message || "Unknown error"}`
  ```

- **src/domain/storage/json-file-storage.ts:304** - Property access masking - should use proper types
  ```typescript
  const state = (result as unknown).data || this.initializeState();
  ```

- **src/domain/storage/json-file-storage.ts:308** - Property access masking - should use proper types
  ```typescript
  const index = entities.findIndex((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/json-file-storage.ts:322** - Property access masking - should use proper types
  ```typescript
  if (!(writeResult as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:323** - Property access masking - should use proper types
  ```typescript
  throw (writeResult as unknown).error || new Error("Failed to write database state");
  ```

- **src/domain/storage/json-file-storage.ts:336** - Property access masking - should use proper types
  ```typescript
  return (FileOperationLock as unknown).withLock(this.filePath, async () => {
  ```

- **src/domain/storage/json-file-storage.ts:338** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:340** - Property access masking - should use proper types
  ```typescript
  `Failed to read database state: ${(result.error as unknown).message || "Unknown error"}`
  ```

- **src/domain/storage/json-file-storage.ts:344** - Property access masking - should use proper types
  ```typescript
  const state = (result as unknown).data || this.initializeState();
  ```

- **src/domain/storage/json-file-storage.ts:348** - Property access masking - should use proper types
  ```typescript
  const index = entities.findIndex((e) => (e as unknown)[this.idField] === id);
  ```

- **src/domain/storage/json-file-storage.ts:361** - Property access masking - should use proper types
  ```typescript
  if (!(writeResult as unknown).success) {
  ```

- **src/domain/storage/json-file-storage.ts:362** - Property access masking - should use proper types
  ```typescript
  throw (writeResult as unknown).error || new Error("Failed to write database state");
  ```

- **src/domain/storage/json-file-storage.ts:400** - Property access masking - should use proper types
  ```typescript
  return (writeResult as unknown).success;
  ```

- **src/domain/storage/database-integrity-checker.ts:248** - Property access masking - should use proper types
  ```typescript
  const integrityResult = db.prepare("PRAGMA integrity_check").get() as unknown;
  ```

- **src/domain/storage/database-integrity-checker.ts:264** - Property access masking - should use proper types
  ```typescript
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as unknown;
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:54** - Property access masking - should use proper types
  ```typescript
  this.workspacePath = (options as unknown).workspacePath;
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:63** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).dbFilePath) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:65** - Property access masking - should use proper types
  ```typescript
  dbFilePath = (options as unknown).dbFilePath;
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:82** - Property access masking - should use proper types
  ```typescript
  lastUpdated: (new Date() as unknown).toISOString(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:86** - Property access masking - should use proper types
  ```typescript
  createdAt: (new Date() as unknown).toISOString(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:97** - Property access masking - should use proper types
  ```typescript
  const result = await (this.storage as unknown).readState();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:98** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:101** - Property access masking - should use proper types
  ```typescript
  error: (result as unknown).error,
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:102** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:107** - Property access masking - should use proper types
  ```typescript
  const tasks = (result.data as unknown).tasks || [];
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:113** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:120** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:127** - Property access masking - should use proper types
  ```typescript
  const fullPath = (specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:165** - Property access masking - should use proper types
  ```typescript
  lastUpdated: (new Date() as unknown).toISOString(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:167** - Property access masking - should use proper types
  ```typescript
  storageLocation: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:177** - Property access masking - should use proper types
  ```typescript
  const lines = ((content as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:185** - Property access masking - should use proper types
  ```typescript
  if ((trimmed as unknown).startsWith("# ")) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:186** - Property access masking - should use proper types
  ```typescript
  const headerText = (trimmed as unknown).slice(2);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:189** - Property access masking - should use proper types
  ```typescript
  const taskMatch = (headerText as unknown).match(/^Task\s+#?([A-Za-z0-9_]+):\s*(.+)$/);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:192** - Property access masking - should use proper types
  ```typescript
  title = (taskMatch[2] as unknown).trim();
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:199** - Property access masking - should use proper types
  ```typescript
  } else if ((trimmed as unknown).startsWith("## ") && inDescription) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:216** - Property access masking - should use proper types
  ```typescript
  return `# ${(spec as unknown).title}\n\n## Context\n\n${(spec as unknown).description}\n`;
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:283** - Property access masking - should use proper types
  ```typescript
  lastUpdated: (new Date() as unknown).toISOString(),
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

- **src/domain/tasks/jsonFileTaskBackend.ts:298** - Property access masking - should use proper types
  ```typescript
  success: (result as unknown).success,
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:299** - Property access masking - should use proper types
  ```typescript
  error: (result as unknown).error,
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:300** - Property access masking - should use proper types
  ```typescript
  bytesWritten: (result as unknown).bytesWritten,
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:301** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:308** - Property access masking - should use proper types
  ```typescript
  filePath: (this.storage as unknown).getStorageLocation(),
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:315** - Property access masking - should use proper types
  ```typescript
  const fullPath = (specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:355** - Property access masking - should use proper types
  ```typescript
  if (deleted && (existingTask as unknown).specPath) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:358** - Property access masking - should use proper types
  ```typescript
  const fullSpecPath = (existingTask.specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:359** - Property access masking - should use proper types
  ```typescript
  ? (existingTask as unknown).specPath
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:360** - Property access masking - should use proper types
  ```typescript
  : join(this.workspacePath, (existingTask as unknown).specPath);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:364** - Property access masking - should use proper types
  ```typescript
  log.debug(`Spec file could not be deleted: ${(existingTask as unknown).specPath}`, {
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

- **src/domain/tasks/jsonFileTaskBackend.ts:516** - Property access masking - should use proper types
  ```typescript
  const lines = ((content as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:520** - Property access masking - should use proper types
  ```typescript
  if ((trimmed as unknown).startsWith("- [ ] ") || (trimmed as unknown).startsWith("- [x] ")) {
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:521** - Property access masking - should use proper types
  ```typescript
  const completed = (trimmed as unknown).startsWith("- [x] ");
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:522** - Property access masking - should use proper types
  ```typescript
  const taskLine = (trimmed as unknown).slice(SIZE_6); // Remove '- [ ] ' or '- [x] '
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:525** - Property access masking - should use proper types
  ```typescript
  const idMatch = (taskLine as unknown).match(/\[#(\d+)\]/);
  ```

- **src/domain/tasks/jsonFileTaskBackend.ts:526** - Property access masking - should use proper types
  ```typescript
  const linkMatch = (taskLine as unknown).match(/\[([^\]]+)\]\(([^)]+)\)/);
  ```

- **src/domain/tasks/task-backend-router.ts:53** - Property access masking - should use proper types
  ```typescript
  const constructorName = (backend.constructor.name as unknown).toLowerCase();
  ```

- **src/domain/tasks/task-backend-router.ts:56** - Property access masking - should use proper types
  ```typescript
  if (backend instanceof MarkdownTaskBackend || (constructorName as unknown).includes("markdowntaskbackend")) {
  ```

- **src/domain/tasks/task-backend-router.ts:65** - Property access masking - should use proper types
  ```typescript
  if (backend instanceof JsonFileTaskBackend || (constructorName as unknown).includes("jsonfiletaskbackend")) {
  ```

- **src/domain/tasks/task-backend-router.ts:109** - Property access masking - should use proper types
  ```typescript
  if ((filePath as unknown).includes("process/tasks.json") || (filePath as unknown).includes("process/.minsky/")) {
  ```

- **src/domain/tasks/task-backend-router.ts:118** - Property access masking - should use proper types
  ```typescript
  if ((filePath as unknown).includes(".minsky/tasks.json")) {
  ```

- **src/domain/tasks/task-backend-router.ts:151** - Property access masking - should use proper types
  ```typescript
  if ((dbPath as unknown).includes("process/") || (dbPath as unknown).includes(".git/")) {
  ```

- **src/domain/tasks/task-backend-router.ts:184** - Property access masking - should use proper types
  ```typescript
  this.specialWorkspaceManager = await (SpecialWorkspaceManager as unknown).create(this.repoUrl);
  ```

- **src/domain/tasks/task-backend-router.ts:187** - Property access masking - should use proper types
  ```typescript
  return (this.specialWorkspaceManager as unknown).getWorkspacePath();
  ```

- **src/domain/tasks/task-backend-router.ts:206** - Property access masking - should use proper types
  ```typescript
  this.specialWorkspaceManager = await (SpecialWorkspaceManager as unknown).create(this.repoUrl);
  ```

- **src/domain/tasks/task-backend-router.ts:209** - Property access masking - should use proper types
  ```typescript
  return (this.specialWorkspaceManager as unknown).performOperation(operation, callback as unknown);
  ```

- **src/domain/tasks/task-backend-router.ts:222** - Property access masking - should use proper types
  ```typescript
  return (backend.constructor.name.toLowerCase() as unknown).includes("github") ||
  ```

- **src/domain/tasks/task-backend-router.ts:223** - Property access masking - should use proper types
  ```typescript
  (backend.name.toLowerCase() as unknown).includes("github");
  ```

- **src/domain/tasks/task-backend-router.ts:228** - Property access masking - should use proper types
  ```typescript
  return (backend.constructor.name.toLowerCase() as unknown).includes("sqlite") ||
  ```

- **src/domain/tasks/task-backend-router.ts:229** - Property access masking - should use proper types
  ```typescript
  (backend.constructor.name.toLowerCase() as unknown).includes("sql");
  ```

- **src/domain/tasks/task-backend-router.ts:234** - Property access masking - should use proper types
  ```typescript
  return (backend.constructor.name.toLowerCase() as unknown).includes("postgres") ||
  ```

- **src/domain/tasks/task-backend-router.ts:235** - Property access masking - should use proper types
  ```typescript
  (backend.constructor.name.toLowerCase() as unknown).includes("pg");
  ```

- **src/domain/tasks/task-backend-router.ts:243** - Property access masking - should use proper types
  ```typescript
  if (typeof (backend as unknown).getStorageLocation === "function") {
  ```

- **src/domain/tasks/task-backend-router.ts:244** - Property access masking - should use proper types
  ```typescript
  return (backend as unknown).getStorageLocation();
  ```

- **src/domain/tasks/task-backend-router.ts:249** - Property access masking - should use proper types
  ```typescript
  return (backend as unknown).filePath;
  ```

- **src/domain/tasks/task-backend-router.ts:253** - Property access masking - should use proper types
  ```typescript
  return (backend as unknown).fileName;
  ```

- **src/domain/tasks/task-backend-router.ts:266** - Property access masking - should use proper types
  ```typescript
  return (backend as unknown).dbPath;
  ```

- **src/domain/tasks/task-backend-router.ts:270** - Property access masking - should use proper types
  ```typescript
  return (backend as unknown).databasePath;
  ```

- **src/domain/tasks/taskFunctions.test.ts:240** - Test assertion masking type errors - should be fixed
  ```typescript
  const updatedTasks = setTaskStatus(testTasks, "#001", "INVALID" as unknown);
  ```

- **src/domain/tasks/taskConstants.ts:71** - Property access masking - should use proper types
  ```typescript
  return (Object.values(TASK_STATUS) as unknown).includes(status as TaskStatus);
  ```

- **src/domain/tasks/taskConstants.ts:87** - Property access masking - should use proper types
  ```typescript
  }) as unknown).join("|");
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

- **src/domain/tasks/githubBackendFactory.ts:20** - Property access masking - should use proper types
  ```typescript
  const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await (Promise as unknown).all([
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

- **src/domain/tasks/githubBackendConfig.ts:32** - Property access masking - should use proper types
  ```typescript
  }) as unknown).toString() as unknown).trim();
  ```

- **src/domain/tasks/githubBackendConfig.ts:37** - Property access masking - should use proper types
  ```typescript
  const sshMatch = (remoteUrl as unknown).match(/git@github\.com:([^\/]+)\/([^\.]+)/);
  ```

- **src/domain/tasks/githubBackendConfig.ts:38** - Property access masking - should use proper types
  ```typescript
  const httpsMatch = (remoteUrl as unknown).match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);
  ```

- **src/domain/tasks/githubBackendConfig.ts:44** - Property access masking - should use proper types
  ```typescript
  repo: (match[2] as unknown).replace(/\.git$/, ""), // Remove .git suffix
  ```

- **src/domain/tasks/githubBackendConfig.ts:91** - Property access masking - should use proper types
  ```typescript
  owner: (repoInfo as unknown).owner,
  ```

- **src/domain/tasks/githubBackendConfig.ts:92** - Property access masking - should use proper types
  ```typescript
  repo: (repoInfo as unknown).repo,
  ```

- **src/domain/tasks/githubBackendConfig.ts:109** - Property access masking - should use proper types
  ```typescript
  await (octokit.rest.issues as unknown).getLabel({
  ```

- **src/domain/tasks/githubBackendConfig.ts:124** - Property access masking - should use proper types
  ```typescript
  await (octokit.rest.issues as unknown).createLabel({
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:97** - Property access masking - should use proper types
  ```typescript
  const sshMatch = (remoteUrl as unknown).match(/git@github\.com:([^\/]+)\/([^\.]+)/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:98** - Property access masking - should use proper types
  ```typescript
  const httpsMatch = (remoteUrl as unknown).match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:104** - Property access masking - should use proper types
  ```typescript
  repo: (match[2] as unknown).replace(/\.git$/, ""), // Remove .git suffix
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:173** - Property access masking - should use proper types
  ```typescript
  const labelQueries = (Object.values(this.statusLabels) as unknown).join(",");
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:174** - Property access masking - should use proper types
  ```typescript
  const response = await (this.octokit.rest.issues as unknown).listForRepo({
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:182** - Property access masking - should use proper types
  ```typescript
  const issues = (response as unknown).data;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:218** - Property access masking - should use proper types
  ```typescript
  const taskIdMatch = (fileName as unknown).match(/^(\d+)-/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:227** - Property access masking - should use proper types
  ```typescript
  const response = await (this.octokit.rest.issues as unknown).listForRepo({
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:230** - Property access masking - should use proper types
  ```typescript
  labels: (Object.values(this.statusLabels) as unknown).join(",") as unknown,
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:236** - Property access masking - should use proper types
  ```typescript
  return (issue.title as unknown).includes(taskId) || (issue.body as unknown).includes(taskId);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:247** - Property access masking - should use proper types
  ```typescript
  const specContent = `# Task ${taskId}: ${(issue as unknown).title}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:253** - Property access masking - should use proper types
  ```typescript
  ${(issue as unknown).body || "No description provided"}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:256** - Property access masking - should use proper types
  ```typescript
  - Issue: #${(issue as unknown).number}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:257** - Property access masking - should use proper types
  ```typescript
  - URL: ${(issue as unknown).html_url}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:258** - Property access masking - should use proper types
  ```typescript
  - State: ${(issue as unknown).state}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:259** - Property access masking - should use proper types
  ```typescript
  - Created: ${(issue as unknown).created_at}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:260** - Property access masking - should use proper types
  ```typescript
  - Updated: ${(issue as unknown).updated_at}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:263** - Property access masking - should use proper types
  ```typescript
  ${(issue.labels.map((label) => `- ${typeof label === "string" ? label : label.name}`) as unknown).join("\n")}
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:306** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:317** - Property access masking - should use proper types
  ```typescript
  if ((trimmed as unknown).startsWith("# ")) {
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:318** - Property access masking - should use proper types
  ```typescript
  title = ((trimmed as unknown).substring(2) as unknown).trim();
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:320** - Property access masking - should use proper types
  ```typescript
  const taskIdMatch = (title as unknown).match(/^Task (#\d+):/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:322** - Property access masking - should use proper types
  ```typescript
  (metadata as unknown).taskId = taskIdMatch[1];
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:323** - Property access masking - should use proper types
  ```typescript
  title = ((title as unknown).substring(taskIdMatch[0].length) as unknown).trim();
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:325** - Property access masking - should use proper types
  ```typescript
  } else if ((trimmed as unknown).startsWith("## ")) {
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:326** - Property access masking - should use proper types
  ```typescript
  currentSection = ((trimmed.substring(3) as unknown).trim() as unknown).toLowerCase();
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:335** - Property access masking - should use proper types
  ```typescript
  description = (descriptionLines as unknown).join("\n");
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:347** - Property access masking - should use proper types
  ```typescript
  let content = `# Task ${(metadata as unknown).taskId || "#000"}: ${title}\n\n`;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:354** - Property access masking - should use proper types
  ```typescript
  if ((metadata as unknown).githubIssue) {
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:355** - Property access masking - should use proper types
  ```typescript
  const githubIssue = (metadata as unknown).githubIssue as unknown;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:357** - Property access masking - should use proper types
  ```typescript
  content += `- Issue: #${(githubIssue as unknown).number}\n`;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:358** - Property access masking - should use proper types
  ```typescript
  content += `- URL: ${(githubIssue as unknown).html_url}\n`;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:359** - Property access masking - should use proper types
  ```typescript
  content += `- State: ${(githubIssue as unknown).state}\n\n`;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:442** - Property access masking - should use proper types
  ```typescript
  title: (task as unknown).title,
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:443** - Property access masking - should use proper types
  ```typescript
  body: (task as unknown).description,
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:444** - Property access masking - should use proper types
  ```typescript
  labels: this.getLabelsForTaskStatus((task as unknown).status),
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:445** - Property access masking - should use proper types
  ```typescript
  state: (task as unknown).status === "DONE" ? "closed" : "open",
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:451** - Property access masking - should use proper types
  ```typescript
  const titleMatch = (issue.title as unknown).match(/#(\d+)/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:457** - Property access masking - should use proper types
  ```typescript
  const bodyMatch = (issue.body as unknown).match(/Task ID: #(\d+)/);
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:463** - Property access masking - should use proper types
  ```typescript
  return `#${(issue as unknown).number}`;
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:468** - Property access masking - should use proper types
  ```typescript
  if ((issue.labels as unknown).some((l: any) => (l as unknown).name === label)) {
  ```

- **src/domain/tasks/githubIssuesTaskBackend.ts:477** - Property access masking - should use proper types
  ```typescript
  return [(this.statusLabels as unknown)[status] || this.statusLabels.TODO];
  ```

- **src/domain/tasks/taskFunctions.ts:21** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/taskFunctions.ts:26** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("```")) {
  ```

- **src/domain/tasks/taskFunctions.ts:45** - Property access masking - should use proper types
  ```typescript
  if ((subline.trim() as unknown).startsWith("```")) break;
  ```

- **src/domain/tasks/taskFunctions.ts:48** - Property access masking - should use proper types
  ```typescript
  description += `${(subline.trim() as unknown).replace(/^- /, "") ?? ""}\n`;
  ```

- **src/domain/tasks/taskFunctions.ts:82** - Property access masking - should use proper types
  ```typescript
  }) as unknown).join("\n\n");
  ```

- **src/domain/tasks/taskFunctions.ts:95** - Property access masking - should use proper types
  ```typescript
  const exactMatch = tasks.find((task) => (task as unknown).id === id);
  ```

- **src/domain/tasks/taskFunctions.ts:109** - Property access masking - should use proper types
  ```typescript
  const taskNumericId = parseInt((task.id as unknown).replace(/^#/, ""), 10);
  ```

- **src/domain/tasks/taskFunctions.ts:152** - Property access masking - should use proper types
  ```typescript
  const id = parseInt((task.id as unknown).replace(/^#/, ""), 10);
  ```

- **src/domain/tasks/taskFunctions.ts:178** - Property access masking - should use proper types
  ```typescript
  (task as unknown).id === normalizedId ||
  ```

- **src/domain/tasks/taskFunctions.ts:179** - Property access masking - should use proper types
  ```typescript
  parseInt((task.id as unknown).replace(/^#/, ""), 10) === parseInt(normalizedId.replace(/^#/, ""), 10)
  ```

- **src/domain/tasks/taskFunctions.ts:195** - Property access masking - should use proper types
  ```typescript
  if (!(newTask as unknown).id || !normalizeTaskId((newTask as unknown).id)) {
  ```

- **src/domain/tasks/taskFunctions.ts:203** - Property access masking - should use proper types
  ```typescript
  const existingTask = getTaskById(tasks, (newTask as unknown).id);
  ```

- **src/domain/tasks/taskFunctions.ts:206** - Property access masking - should use proper types
  ```typescript
  return tasks.map((task) => ((task as unknown).id === (existingTask as unknown).id ? newTask : task));
  ```

- **src/domain/tasks/taskFunctions.ts:225** - Property access masking - should use proper types
  ```typescript
  if ((filter as unknown).status && (task as unknown).status !== (filter as unknown).status) {
  ```

- **src/domain/tasks/taskFunctions.ts:230** - Property access masking - should use proper types
  ```typescript
  if ((filter as unknown).id) {
  ```

- **src/domain/tasks/taskFunctions.ts:232** - Property access masking - should use proper types
  ```typescript
  if (/^\d+$/.test((filter as unknown).id)) {
  ```

- **src/domain/tasks/taskFunctions.ts:234** - Property access masking - should use proper types
  ```typescript
  const filterNum = parseInt((filter as unknown).id, 10);
  ```

- **src/domain/tasks/taskFunctions.ts:235** - Property access masking - should use proper types
  ```typescript
  const taskNum = parseInt((task.id as unknown).replace(/\D/g, ""), 10);
  ```

- **src/domain/tasks/taskFunctions.ts:243** - Property access masking - should use proper types
  ```typescript
  const normalizedFilterId = normalizeTaskId((filter as unknown).id);
  ```

- **src/domain/tasks/taskFunctions.ts:244** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((task as unknown).id);
  ```

- **src/domain/tasks/taskFunctions.ts:263** - Property access masking - should use proper types
  ```typescript
  if ((filter as unknown).title && typeof (filter as unknown).title === "string") {
  ```

- **src/domain/tasks/taskFunctions.ts:264** - Property access masking - should use proper types
  ```typescript
  return (task.title.toLowerCase() as unknown).includes((filter.title as unknown).toLowerCase());
  ```

- **src/domain/tasks/taskFunctions.ts:268** - Property access masking - should use proper types
  ```typescript
  if ((filter as unknown).title && (filter as unknown).title instanceof RegExp) {
  ```

- **src/domain/tasks/taskFunctions.ts:269** - Property access masking - should use proper types
  ```typescript
  return (filter.title as unknown).test((task as unknown).title);
  ```

- **src/domain/tasks/taskFunctions.ts:273** - Property access masking - should use proper types
  ```typescript
  if ((filter as unknown).hasSpecPath !== undefined) {
  ```

- **src/domain/tasks/taskFunctions.ts:274** - Property access masking - should use proper types
  ```typescript
  return (filter as unknown).hasSpecPath ? !!task.specPath : !task.specPath;
  ```

- **src/domain/tasks/taskFunctions.ts:291** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/taskFunctions.ts:294** - Property access masking - should use proper types
  ```typescript
  const titleLine = lines.find((line) => (line as unknown).startsWith("# "));
  ```

- **src/domain/tasks/taskFunctions.ts:303** - Property access masking - should use proper types
  ```typescript
  const titleWithIdMatch = (titleLine as unknown).match(/^# Task #(\d+): (.+)$/);
  ```

- **src/domain/tasks/taskFunctions.ts:304** - Property access masking - should use proper types
  ```typescript
  const titleWithoutIdMatch = (titleLine as unknown).match(/^# Task: (.+)$/);
  ```

- **src/domain/tasks/taskFunctions.ts:305** - Property access masking - should use proper types
  ```typescript
  const cleanTitleMatch = (titleLine as unknown).match(/^# (.+)$/);
  ```

- **src/domain/tasks/taskFunctions.ts:321** - Property access masking - should use proper types
  ```typescript
  if (!(title as unknown).startsWith("Task ")) {
  ```

- **src/domain/tasks/taskFunctions.ts:333** - Property access masking - should use proper types
  ```typescript
  if ((line.trim() as unknown).startsWith("## ")) break;
  ```

- **src/domain/tasks/taskFunctions.ts:354** - Property access masking - should use proper types
  ```typescript
  const titleLine = `# ${(spec as unknown).title}`;
  ```

- **src/domain/tasks/taskFunctions.ts:359** - Property access masking - should use proper types
  ```typescript
  ${(spec as unknown).description}
  ```

- **src/domain/tasks/real-world-workflow.test.ts:39** - Test assertion masking type errors - should be fixed
  ```typescript
  expect((jsonBackend as unknown).getStorageLocation()).toBe(testJsonPath);
  ```

- **src/domain/tasks/real-world-workflow.test.ts:97** - Test assertion masking type errors - should be fixed
  ```typescript
  expect((jsonBackend as unknown).getStorageLocation()).toBe(expectedPath);
  ```

- **src/domain/tasks/markdownTaskBackend.ts:60** - Property access masking - should use proper types
  ```typescript
  this.workspacePath = (config as unknown).workspacePath;
  ```

- **src/domain/tasks/markdownTaskBackend.ts:178** - Property access masking - should use proper types
  ```typescript
  if (!(tasksResult as unknown).success || !(tasksResult as unknown).content) {
  ```

- **src/domain/tasks/markdownTaskBackend.ts:183** - Property access masking - should use proper types
  ```typescript
  const tasks = this.parseTasks((tasksResult as unknown).content);
  ```

- **src/domain/tasks/markdownTaskBackend.ts:186** - Property access masking - should use proper types
  ```typescript
  (task as unknown).id === id ||
  ```

- **src/domain/tasks/markdownTaskBackend.ts:187** - Property access masking - should use proper types
  ```typescript
  (task as unknown).id === `#${id}` ||
  ```

- **src/domain/tasks/markdownTaskBackend.ts:188** - Property access masking - should use proper types
  ```typescript
  (task as unknown).id.slice(1) === id
  ```

- **src/domain/tasks/markdownTaskBackend.ts:197** - Property access masking - should use proper types
  ```typescript
  const updatedTasks = tasks.filter((task) => (task as unknown).id !== (taskToDelete as unknown).id);
  ```

- **src/domain/tasks/markdownTaskBackend.ts:203** - Property access masking - should use proper types
  ```typescript
  if (!(saveResult as unknown).success) {
  ```

- **src/domain/tasks/markdownTaskBackend.ts:205** - Property access masking - should use proper types
  ```typescript
  error: (saveResult.error as unknown).message,
  ```

- **src/domain/tasks/markdownTaskBackend.ts:211** - Property access masking - should use proper types
  ```typescript
  if ((taskToDelete as unknown).specPath) {
  ```

- **src/domain/tasks/markdownTaskBackend.ts:213** - Property access masking - should use proper types
  ```typescript
  const fullSpecPath = (taskToDelete.specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/markdownTaskBackend.ts:214** - Property access masking - should use proper types
  ```typescript
  ? (taskToDelete as unknown).specPath
  ```

- **src/domain/tasks/markdownTaskBackend.ts:215** - Property access masking - should use proper types
  ```typescript
  : join(this.workspacePath, (taskToDelete as unknown).specPath);
  ```

- **src/domain/tasks/markdownTaskBackend.ts:244** - Property access masking - should use proper types
  ```typescript
  const fullPath = (specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/markdownTaskBackend.ts:291** - Property access masking - should use proper types
  ```typescript
  return (matter as unknown).stringify(markdownContent, (spec as unknown).metadata);
  ```

- **src/domain/tasks/markdownTaskBackend.ts:304** - Property access masking - should use proper types
  ```typescript
  const fullPath = (specPath as unknown).startsWith("/")
  ```

- **src/domain/tasks/markdownTaskBackend.ts:334** - Property access masking - should use proper types
  ```typescript
  return files.filter((file) => (file as unknown).startsWith(`${taskId}-`));
  ```

- **src/domain/tasks/taskService.ts:98** - Property access masking - should use proper types
  ```typescript
  const selectedBackend = this.backends.find((b) => (b as unknown).name === backend);
  ```

- **src/domain/tasks/taskService.ts:101** - Property access masking - should use proper types
  ```typescript
  `Backend '${backend}' not found. Available backends: ${(this.backends.map((b) => b.name) as unknown).join(", ")}`
  ```

- **src/domain/tasks/taskService.ts:114** - Property access masking - should use proper types
  ```typescript
  const result = await (this.currentBackend as unknown).getTasksData();
  ```

- **src/domain/tasks/taskService.ts:115** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:120** - Property access masking - should use proper types
  ```typescript
  let tasks = (this.currentBackend as unknown).parseTasks((result as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:124** - Property access masking - should use proper types
  ```typescript
  tasks = tasks.filter((task) => (task as unknown).status === options.status);
  ```

- **src/domain/tasks/taskService.ts:144** - Property access masking - should use proper types
  ```typescript
  const exactMatch = tasks.find((task) => (task as unknown).id === normalizedId);
  ```

- **src/domain/tasks/taskService.ts:154** - Property access masking - should use proper types
  ```typescript
  const taskNumericId = parseInt((task.id as unknown).replace(/^#/, ""), 10);
  ```

- **src/domain/tasks/taskService.ts:168** - Property access masking - should use proper types
  ```typescript
  return task ? (task as unknown).status : null;
  ```

- **src/domain/tasks/taskService.ts:190** - Property access masking - should use proper types
  ```typescript
  const result = await (this.currentBackend as unknown).getTasksData();
  ```

- **src/domain/tasks/taskService.ts:191** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:192** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to read tasks data: ${(result.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:196** - Property access masking - should use proper types
  ```typescript
  const tasks = (this.currentBackend as unknown).parseTasks((result as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:200** - Property access masking - should use proper types
  ```typescript
  const taskNormalizedId = normalizeTaskId((t as unknown).id);
  ```

- **src/domain/tasks/taskService.ts:214** - Property access masking - should use proper types
  ```typescript
  const updatedContent = (this.currentBackend as unknown).formatTasks(updatedTasks);
  ```

- **src/domain/tasks/taskService.ts:217** - Property access masking - should use proper types
  ```typescript
  const saveResult = await (this.currentBackend as unknown).saveTasksData(updatedContent);
  ```

- **src/domain/tasks/taskService.ts:218** - Property access masking - should use proper types
  ```typescript
  if (!(saveResult as unknown).success) {
  ```

- **src/domain/tasks/taskService.ts:219** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to save tasks data: ${(saveResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:228** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getWorkspacePath();
  ```

- **src/domain/tasks/taskService.ts:239** - Property access masking - should use proper types
  ```typescript
  const specResult = await (this.currentBackend as unknown).getTaskSpecData(specPath);
  ```

- **src/domain/tasks/taskService.ts:240** - Property access masking - should use proper types
  ```typescript
  if (!(specResult as unknown).success || !(specResult as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:241** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:245** - Property access masking - should use proper types
  ```typescript
  const spec = (this.currentBackend as unknown).parseTaskSpec((specResult as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:249** - Property access masking - should use proper types
  ```typescript
  if ((spec as unknown).id) {
  ```

- **src/domain/tasks/taskService.ts:251** - Property access masking - should use proper types
  ```typescript
  const existingTask = await this.getTask((spec as unknown).id);
  ```

- **src/domain/tasks/taskService.ts:252** - Property access masking - should use proper types
  ```typescript
  if (existingTask && !(options as unknown).force) {
  ```

- **src/domain/tasks/taskService.ts:253** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Task ${(spec as unknown).id} already exists. Use --force to overwrite.`);
  ```

- **src/domain/tasks/taskService.ts:255** - Property access masking - should use proper types
  ```typescript
  taskId = (spec as unknown).id;
  ```

- **src/domain/tasks/taskService.ts:260** - Property access masking - should use proper types
  ```typescript
  const id = parseInt((task as unknown).id.slice(1));
  ```

- **src/domain/tasks/taskService.ts:266** - Property access masking - should use proper types
  ```typescript
  (spec as unknown).id = taskId;
  ```

- **src/domain/tasks/taskService.ts:270** - Property access masking - should use proper types
  ```typescript
  const originalContent = (specResult as unknown).content;
  ```

- **src/domain/tasks/taskService.ts:271** - Property access masking - should use proper types
  ```typescript
  const specPath = (this.currentBackend as unknown).getTaskSpecPath(taskId, (spec as unknown).title);
  ```

- **src/domain/tasks/taskService.ts:280** - Property access masking - should use proper types
  ```typescript
  const saveSpecResult = await (this.currentBackend as unknown).saveTaskSpecData(
  ```

- **src/domain/tasks/taskService.ts:284** - Property access masking - should use proper types
  ```typescript
  if (!(saveSpecResult as unknown).success) {
  ```

- **src/domain/tasks/taskService.ts:286** - Property access masking - should use proper types
  ```typescript
  `Failed to save updated spec file: ${(saveSpecResult.error as unknown).message}`
  ```

- **src/domain/tasks/taskService.ts:294** - Property access masking - should use proper types
  ```typescript
  title: (spec as unknown).title,
  ```

- **src/domain/tasks/taskService.ts:295** - Property access masking - should use proper types
  ```typescript
  description: (spec as unknown).description,
  ```

- **src/domain/tasks/taskService.ts:297** - Property access masking - should use proper types
  ```typescript
  specPath: (this.currentBackend as unknown).getTaskSpecPath(taskId, (spec as unknown).title),
  ```

- **src/domain/tasks/taskService.ts:301** - Property access masking - should use proper types
  ```typescript
  const tasksResult = await (this.currentBackend as unknown).getTasksData();
  ```

- **src/domain/tasks/taskService.ts:303** - Property access masking - should use proper types
  ```typescript
  if ((tasksResult as unknown).success && (tasksResult as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:304** - Property access masking - should use proper types
  ```typescript
  tasks = (this.currentBackend as unknown).parseTasks((tasksResult as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:308** - Property access masking - should use proper types
  ```typescript
  const existingIndex = tasks.findIndex((t) => (t as unknown).id === (newTask as unknown).id);
  ```

- **src/domain/tasks/taskService.ts:316** - Property access masking - should use proper types
  ```typescript
  const updatedContent = (this.currentBackend as unknown).formatTasks(tasks);
  ```

- **src/domain/tasks/taskService.ts:317** - Property access masking - should use proper types
  ```typescript
  const saveResult = await (this.currentBackend as unknown).saveTasksData(updatedContent);
  ```

- **src/domain/tasks/taskService.ts:318** - Property access masking - should use proper types
  ```typescript
  if (!(saveResult as unknown).success) {
  ```

- **src/domain/tasks/taskService.ts:319** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to save tasks _data: ${(saveResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:340** - Property access masking - should use proper types
  ```typescript
  const result = await (backend as unknown).getTasksData();
  ```

- **src/domain/tasks/taskService.ts:341** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:346** - Property access masking - should use proper types
  ```typescript
  const tasks = (backend as unknown).parseTasks((result as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:349** - Property access masking - should use proper types
  ```typescript
  const taskExists = tasks.some((task) => (task as unknown).id === normalizedId);
  ```

- **src/domain/tasks/taskService.ts:378** - Property access masking - should use proper types
  ```typescript
  const specResult = await (this.currentBackend as unknown).getTaskSpecData(task.specPath);
  ```

- **src/domain/tasks/taskService.ts:379** - Property access masking - should use proper types
  ```typescript
  if (!(specResult as unknown).success || !(specResult as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:380** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:384** - Property access masking - should use proper types
  ```typescript
  const spec = (this.currentBackend as unknown).parseTaskSpec((specResult as unknown).content);
  ```

- **src/domain/tasks/taskService.ts:387** - Property access masking - should use proper types
  ```typescript
  (spec as unknown).metadata = {
  ```

- **src/domain/tasks/taskService.ts:388** - Property access masking - should use proper types
  ```typescript
  ...(spec as unknown).metadata,
  ```

- **src/domain/tasks/taskService.ts:393** - Property access masking - should use proper types
  ```typescript
  const updatedSpecContent = (this.currentBackend as unknown).formatTaskSpec(spec);
  ```

- **src/domain/tasks/taskService.ts:394** - Property access masking - should use proper types
  ```typescript
  const saveSpecResult = await (this.currentBackend as unknown).saveTaskSpecData(
  ```

- **src/domain/tasks/taskService.ts:398** - Property access masking - should use proper types
  ```typescript
  if (!(saveSpecResult as unknown).success) {
  ```

- **src/domain/tasks/taskService.ts:399** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to save updated spec file: ${(saveSpecResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:411** - Property access masking - should use proper types
  ```typescript
  return await (this.currentBackend as unknown).deleteTask(id, options as unknown);
  ```

- **src/domain/tasks/taskService.ts:434** - Property access masking - should use proper types
  ```typescript
  const specResult = await (this.currentBackend as unknown).getTaskSpecData(task.specPath);
  ```

- **src/domain/tasks/taskService.ts:435** - Property access masking - should use proper types
  ```typescript
  if (!(specResult as unknown).success || !(specResult as unknown).content) {
  ```

- **src/domain/tasks/taskService.ts:436** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
  ```

- **src/domain/tasks/taskService.ts:440** - Property access masking - should use proper types
  ```typescript
  content: (specResult as unknown).content,
  ```

- **src/domain/tasks/taskService.ts:464** - Property access masking - should use proper types
  ```typescript
  return (this.currentBackend as unknown).getTaskSpecPath(id, (task as unknown).title);
  ```

- **src/domain/tasks/taskService.ts:516** - Property access masking - should use proper types
  ```typescript
  const normalizedTitle = (title.toLowerCase() as unknown).replace(/[^a-z0-9]+/g, "-");
  ```

- **src/domain/tasks/taskService.ts:519** - Property access masking - should use proper types
  ```typescript
  `temp-task-${normalizedTitle}-${(Date as unknown).now()}.md`
  ```

- **src/domain/tasks/taskService.ts:527** - Property access masking - should use proper types
  ```typescript
  const task = await this.createTask(tempSpecPath, options as unknown);
  ```

- **src/domain/tasks/utils.ts:19** - Property access masking - should use proper types
  ```typescript
  if ((normalizedInput.toLowerCase() as unknown).startsWith("task#")) {
  ```

- **src/domain/tasks/utils.ts:20** - Property access masking - should use proper types
  ```typescript
  normalizedInput = (normalizedInput as unknown).substring(5);
  ```

- **src/domain/tasks/utils.ts:24** - Property access masking - should use proper types
  ```typescript
  while ((normalizedInput as unknown).startsWith("#")) {
  ```

- **src/domain/tasks/utils.ts:25** - Property access masking - should use proper types
  ```typescript
  normalizedInput = (normalizedInput as unknown).substring(1);
  ```

- **src/domain/tasks/taskCommands.ts:72** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskListParamsSchema as unknown).parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:75** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:78** - Property access masking - should use proper types
  ```typescript
  const taskService = await (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:84** - Property access masking - should use proper types
  ```typescript
  let tasks = await (taskService as unknown).listTasks();
  ```

- **src/domain/tasks/taskCommands.ts:88** - Property access masking - should use proper types
  ```typescript
  tasks = tasks.filter((task: any) => (task as unknown).status === validParams.filter);
  ```

- **src/domain/tasks/taskCommands.ts:93** - Property access masking - should use proper types
  ```typescript
  (task as unknown).status !== TASK_STATUS.DONE && (task as unknown).status !== TASK_STATUS.CLOSED
  ```

- **src/domain/tasks/taskCommands.ts:127** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:130** - Property access masking - should use proper types
  ```typescript
  (params as unknown).taskId,
  ```

- **src/domain/tasks/taskCommands.ts:133** - Property access masking - should use proper types
  ```typescript
  { label: "Input", value: (params as unknown).taskId }
  ```

- **src/domain/tasks/taskCommands.ts:141** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskGetParamsSchema as unknown).parse(paramsWithNormalizedId);
  ```

- **src/domain/tasks/taskCommands.ts:144** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:145** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:150** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:153** - Property access masking - should use proper types
  ```typescript
  const taskService = await (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:159** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).getTask((validParams as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:163** - Property access masking - should use proper types
  ```typescript
  `Task ${(validParams as unknown).taskId} not found`,
  ```

- **src/domain/tasks/taskCommands.ts:165** - Property access masking - should use proper types
  ```typescript
  (validParams as unknown).taskId
  ```

- **src/domain/tasks/taskCommands.ts:198** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:201** - Property access masking - should use proper types
  ```typescript
  (params as unknown).taskId,
  ```

- **src/domain/tasks/taskCommands.ts:204** - Property access masking - should use proper types
  ```typescript
  { label: "Input", value: (params as unknown).taskId }
  ```

- **src/domain/tasks/taskCommands.ts:212** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskStatusGetParamsSchema as unknown).parse(paramsWithNormalizedId);
  ```

- **src/domain/tasks/taskCommands.ts:215** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:216** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:221** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:224** - Property access masking - should use proper types
  ```typescript
  const taskService = await (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:230** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).getTask((validParams as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:234** - Property access masking - should use proper types
  ```typescript
  `Task ${(validParams as unknown).taskId} not found or has no status`,
  ```

- **src/domain/tasks/taskCommands.ts:236** - Property access masking - should use proper types
  ```typescript
  (validParams as unknown).taskId
  ```

- **src/domain/tasks/taskCommands.ts:240** - Property access masking - should use proper types
  ```typescript
  return (task as unknown).status;
  ```

- **src/domain/tasks/taskCommands.ts:272** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:275** - Property access masking - should use proper types
  ```typescript
  (params as unknown).taskId,
  ```

- **src/domain/tasks/taskCommands.ts:278** - Property access masking - should use proper types
  ```typescript
  { label: "Input", value: (params as unknown).taskId }
  ```

- **src/domain/tasks/taskCommands.ts:286** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskStatusSetParamsSchema as unknown).parse(paramsWithNormalizedId);
  ```

- **src/domain/tasks/taskCommands.ts:289** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:290** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:295** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:298** - Property access masking - should use proper types
  ```typescript
  const taskService = await (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:304** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).getTask((validParams as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:307** - Property access masking - should use proper types
  ```typescript
  `Task ${(validParams as unknown).taskId} not found`,
  ```

- **src/domain/tasks/taskCommands.ts:309** - Property access masking - should use proper types
  ```typescript
  (validParams as unknown).taskId
  ```

- **src/domain/tasks/taskCommands.ts:314** - Property access masking - should use proper types
  ```typescript
  await (taskService as unknown).setTaskStatus((validParams as unknown).taskId, (validParams as unknown).status);
  ```

- **src/domain/tasks/taskCommands.ts:347** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskCreateParamsSchema as unknown).parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:350** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:351** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:356** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:359** - Property access masking - should use proper types
  ```typescript
  const taskService = (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:365** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).createTask((validParams as unknown).title, {
  ```

- **src/domain/tasks/taskCommands.ts:398** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskSpecContentParamsSchema as unknown).parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:401** - Property access masking - should use proper types
  ```typescript
  const taskIdString = Array.isArray((validParams as unknown).taskId) ? (validParams as unknown).taskId[0] : (validParams as unknown).taskId;
  ```

- **src/domain/tasks/taskCommands.ts:405** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:406** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:411** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:414** - Property access masking - should use proper types
  ```typescript
  const taskService = (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:420** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).getTask(taskId);
  ```

- **src/domain/tasks/taskCommands.ts:426** - Property access masking - should use proper types
  ```typescript
  const specPath = await (taskService as unknown).getTaskSpecPath(taskId);
  ```

- **src/domain/tasks/taskCommands.ts:446** - Property access masking - should use proper types
  ```typescript
  const lines = (((content) as unknown).toString() as unknown).split("\n");
  ```

- **src/domain/tasks/taskCommands.ts:448** - Property access masking - should use proper types
  ```typescript
  (line.toLowerCase() as unknown).startsWith(`## ${(validParams.section! as unknown).toLowerCase()}`)
  ```

- **src/domain/tasks/taskCommands.ts:460** - Property access masking - should use proper types
  ```typescript
  if ((lines[i] as unknown).startsWith("## ")) {
  ```

- **src/domain/tasks/taskCommands.ts:466** - Property access masking - should use proper types
  ```typescript
  sectionContent = ((lines as unknown).slice(sectionStart, sectionEnd).join("\n") as unknown).trim();
  ```

- **src/domain/tasks/taskCommands.ts:508** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskCreateFromTitleAndDescriptionParamsSchema as unknown).parse(params as unknown);
  ```

- **src/domain/tasks/taskCommands.ts:511** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:512** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:517** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:520** - Property access masking - should use proper types
  ```typescript
  const taskService = (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:526** - Property access masking - should use proper types
  ```typescript
  let description = (validParams as unknown).description;
  ```

- **src/domain/tasks/taskCommands.ts:530** - Property access masking - should use proper types
  ```typescript
  const filePath = (require("path") as unknown).resolve(validParams.descriptionPath);
  ```

- **src/domain/tasks/taskCommands.ts:531** - Property access masking - should use proper types
  ```typescript
  description = ((await readFile(filePath, "utf-8")) as unknown).toString();
  ```

- **src/domain/tasks/taskCommands.ts:542** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as any).includes("ENOENT") || (errorMessage as unknown).includes("no such file")) {
  ```

- **src/domain/tasks/taskCommands.ts:544** - Property access masking - should use proper types
  ```typescript
  } else if ((errorMessage as unknown).includes("EACCES") || (errorMessage as unknown).includes("permission denied")) {
  ```

- **src/domain/tasks/taskCommands.ts:557** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).createTaskFromTitleAndDescription(
  ```

- **src/domain/tasks/taskCommands.ts:558** - Property access masking - should use proper types
  ```typescript
  (validParams as unknown).title,
  ```

- **src/domain/tasks/taskCommands.ts:598** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:601** - Property access masking - should use proper types
  ```typescript
  `Invalid task ID: '${(params as unknown).taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
  ```

- **src/domain/tasks/taskCommands.ts:607** - Property access masking - should use proper types
  ```typescript
  const validParams = (taskDeleteParamsSchema as unknown).parse(paramsWithNormalizedId);
  ```

- **src/domain/tasks/taskCommands.ts:610** - Property access masking - should use proper types
  ```typescript
  const repoPath = await (deps as unknown).resolveRepoPath({
  ```

- **src/domain/tasks/taskCommands.ts:611** - Property access masking - should use proper types
  ```typescript
  session: (validParams as unknown).session,
  ```

- **src/domain/tasks/taskCommands.ts:616** - Property access masking - should use proper types
  ```typescript
  const workspacePath = await (deps as unknown).resolveMainWorkspacePath();
  ```

- **src/domain/tasks/taskCommands.ts:619** - Property access masking - should use proper types
  ```typescript
  const taskService = await (deps as unknown).createTaskService({
  ```

- **src/domain/tasks/taskCommands.ts:625** - Property access masking - should use proper types
  ```typescript
  const task = await (taskService as unknown).getTask((validParams as unknown).taskId);
  ```

- **src/domain/tasks/taskCommands.ts:629** - Property access masking - should use proper types
  ```typescript
  `Task ${(validParams as unknown).taskId} not found`,
  ```

- **src/domain/tasks/taskCommands.ts:631** - Property access masking - should use proper types
  ```typescript
  (validParams as unknown).taskId
  ```

- **src/domain/tasks/taskCommands.ts:636** - Property access masking - should use proper types
  ```typescript
  const deleted = await (taskService as unknown).deleteTask((validParams as unknown).taskId, {
  ```

- **src/domain/tasks/taskCommands.ts:642** - Property access masking - should use proper types
  ```typescript
  taskId: (validParams as unknown).taskId,
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

- **src/domain/tasks/taskIO.ts:233** - Property access masking - should use proper types
  ```typescript
  const normalizedTitle = (title.toLowerCase() as unknown).replace(/[^a-z0-9]+/g, "-");
  ```

- **src/domain/tasks/utils.test.ts:43** - Test assertion masking type errors - should be fixed
  ```typescript
  expect(normalizeTaskId(input as unknown)).toBeNull();
  ```

- **src/domain/repository/index.ts:206** - Property access masking - should use proper types
  ```typescript
  if (!(config as unknown).type) {
  ```

- **src/domain/repository/index.ts:210** - Property access masking - should use proper types
  ```typescript
  if (!(config as unknown).repoUrl) {
  ```

- **src/domain/repository/index.ts:215** - Property access masking - should use proper types
  ```typescript
  switch ((config as unknown).type) {
  ```

- **src/domain/repository/index.ts:216** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).LOCAL: {
  ```

- **src/domain/repository/index.ts:218** - Property access masking - should use proper types
  ```typescript
  if (!(config.repoUrl as unknown).includes("://") && !(config.repoUrl as unknown).includes("@")) {
  ```

- **src/domain/repository/index.ts:224** - Property access masking - should use proper types
  ```typescript
  `test -d "${(config as unknown).repoUrl}" && echo "exists" || echo "not exists"`
  ```

- **src/domain/repository/index.ts:227** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Repository path does not exist: ${(config as unknown).repoUrl}`);
  ```

- **src/domain/repository/index.ts:238** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).REMOTE: {
  ```

- **src/domain/repository/index.ts:241** - Property access masking - should use proper types
  ```typescript
  !(config.repoUrl as unknown).startsWith("http://") &&
  ```

- **src/domain/repository/index.ts:242** - Property access masking - should use proper types
  ```typescript
  !(config.repoUrl as unknown).startsWith("https://") &&
  ```

- **src/domain/repository/index.ts:243** - Property access masking - should use proper types
  ```typescript
  !(config.repoUrl as unknown).startsWith("git@") &&
  ```

- **src/domain/repository/index.ts:244** - Property access masking - should use proper types
  ```typescript
  !(config.repoUrl as unknown).startsWith("ssh://")
  ```

- **src/domain/repository/index.ts:246** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Invalid remote repository URL format: ${(config as unknown).repoUrl}`);
  ```

- **src/domain/repository/index.ts:250** - Property access masking - should use proper types
  ```typescript
  if ((config as unknown).remote) {
  ```

- **src/domain/repository/index.ts:252** - Property access masking - should use proper types
  ```typescript
  (config.remote as unknown).authMethod &&
  ```

- **src/domain/repository/index.ts:253** - Property access masking - should use proper types
  ```typescript
  !(["ssh", "https", "token"] as unknown).includes((config.remote as unknown).authMethod)
  ```

- **src/domain/repository/index.ts:256** - Property access masking - should use proper types
  ```typescript
  `Invalid auth method: ${(config.remote as unknown).authMethod}. Must be one of: ssh, https, token`
  ```

- **src/domain/repository/index.ts:261** - Property access masking - should use proper types
  ```typescript
  (config.remote as unknown).depth &&
  ```

- **src/domain/repository/index.ts:262** - Property access masking - should use proper types
  ```typescript
  (typeof (config.remote as unknown).depth !== "number" || (config.remote as unknown).depth < 1)
  ```

- **src/domain/repository/index.ts:272** - Property access masking - should use proper types
  ```typescript
  case (RepositoryBackendType as unknown).GITHUB: {
  ```

- **src/domain/repository/index.ts:274** - Property access masking - should use proper types
  ```typescript
  if ((config as unknown).github) {
  ```

- **src/domain/repository/index.ts:277** - Property access masking - should use proper types
  ```typescript
  ((config.github as unknown).owner && !(config.github as unknown).repo) ||
  ```

- **src/domain/repository/index.ts:278** - Property access masking - should use proper types
  ```typescript
  (!(config.github as unknown).owner && (config.github as unknown).repo)
  ```

- **src/domain/repository/index.ts:284** - Property access masking - should use proper types
  ```typescript
  if ((config.github as unknown).enterpriseDomain && !(config.github as unknown).apiUrl) {
  ```

- **src/domain/repository/index.ts:294** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Unsupported repository backend type: ${(config as unknown).type}`);
  ```

- **src/domain/repository/remote.ts:47** - Property access masking - should use proper types
  ```typescript
  this.repoUrl = (config as unknown).repoUrl;
  ```

- **src/domain/repository/remote.ts:48** - Property access masking - should use proper types
  ```typescript
  this.defaultBranch = (config as unknown).branch;
  ```

- **src/domain/repository/remote.ts:114** - Property access masking - should use proper types
  ```typescript
  if ((normalizedError?.message as unknown).includes("Authentication failed")) {
  ```

- **src/domain/repository/remote.ts:128** - Property access masking - should use proper types
  ```typescript
  (normalizedError?.message as unknown).includes("not found") ||
  ```

- **src/domain/repository/remote.ts:129** - Property access masking - should use proper types
  ```typescript
  (normalizedError?.message as unknown).includes("does not exist")
  ```

- **src/domain/repository/remote.ts:132** - Property access masking - should use proper types
  ```typescript
  } else if ((normalizedError?.message as unknown).includes("timed out")) {
  ```

- **src/domain/repository/remote.ts:135** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to clone Git repository: ${(normalizedError as unknown).message}`);
  ```

- **src/domain/repository/remote.ts:160** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to create branch in Git repository: ${(normalizedError as unknown).message}`);
  ```

- **src/domain/repository/remote.ts:186** - Property access masking - should use proper types
  ```typescript
  const counts = (revListOutput.trim() as unknown).split(/\s+/);
  ```

- **src/domain/repository/remote.ts:201** - Property access masking - should use proper types
  ```typescript
  const remotes = (remoteOutput.trim() as unknown).split("\n").filter(Boolean);
  ```

- **src/domain/repository/remote.ts:215** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to get Git repository status: ${(normalizedError as unknown).message}`);
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

- **src/domain/repository/remote.ts:269** - Property access masking - should use proper types
  ```typescript
  message: `Failed to validate Git repository: ${(normalizedError as unknown).message}`,
  ```

- **src/domain/repository/remote.ts:293** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/remote.ts:294** - Property access masking - should use proper types
  ```typescript
  const currentSessions = sessions.filter((s) => (s as unknown).repoUrl === this.repoUrl);
  ```

- **src/domain/repository/remote.ts:371** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/remote.ts:372** - Property access masking - should use proper types
  ```typescript
  const currentSessions = sessions.filter((s) => (s as unknown).repoUrl === this.repoUrl);
  ```

- **src/domain/repository/local.ts:45** - Property access masking - should use proper types
  ```typescript
  this.repoUrl = (config as unknown).repoUrl;
  ```

- **src/domain/repository/local.ts:138** - Property access masking - should use proper types
  ```typescript
  const counts = (revListOutput.trim() as unknown).split(/\s+/);
  ```

- **src/domain/repository/local.ts:152** - Property access masking - should use proper types
  ```typescript
  status: ((line as unknown).substring(0, 2) as unknown).trim(),
  ```

- **src/domain/repository/local.ts:153** - Property access masking - should use proper types
  ```typescript
  file: (line as unknown).substring(3),
  ```

- **src/domain/repository/local.ts:158** - Property access masking - should use proper types
  ```typescript
  const remotes = (remoteOutput.trim() as unknown).split("\n").filter(Boolean);
  ```

- **src/domain/repository/local.ts:169** - Property access masking - should use proper types
  ```typescript
  changes: modifiedFiles.map((file) => `M ${(file as unknown).file}`),
  ```

- **src/domain/repository/local.ts:189** - Property access masking - should use proper types
  ```typescript
  if (!(this.repoUrl as unknown).includes("://") && !(this.repoUrl as unknown).includes("@")) {
  ```

- **src/domain/repository/local.ts:202** - Property access masking - should use proper types
  ```typescript
  return { success: false, message: `Invalid git repository: ${(normalizedError as unknown).message}` };
  ```

- **src/domain/repository/github.ts:55** - Property access masking - should use proper types
  ```typescript
  this.owner = (config.github as unknown).owner;
  ```

- **src/domain/repository/github.ts:56** - Property access masking - should use proper types
  ```typescript
  this.repo = (config.github as unknown).repo;
  ```

- **src/domain/repository/github.ts:61** - Property access masking - should use proper types
  ```typescript
  (config as unknown).repoUrl ||
  ```

- **src/domain/repository/github.ts:115** - Property access masking - should use proper types
  ```typescript
  const result = await (this.gitService as unknown).clone({
  ```

- **src/domain/repository/github.ts:128** - Property access masking - should use proper types
  ```typescript
  if ((normalizedError.message as unknown).includes("Authentication failed")) {
  ```

- **src/domain/repository/github.ts:141** - Property access masking - should use proper types
  ```typescript
  } else if ((normalizedError.message as unknown).includes("not found")) {
  ```

- **src/domain/repository/github.ts:145** - Property access masking - should use proper types
  ```typescript
  } else if ((normalizedError.message as unknown).includes("timed out")) {
  ```

- **src/domain/repository/github.ts:150** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to clone GitHub repository: ${(normalizedError as unknown).message}`);
  ```

- **src/domain/repository/github.ts:175** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to create branch in GitHub repository: ${(normalizedError as unknown).message}`);
  ```

- **src/domain/repository/github.ts:188** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:196** - Property access masking - should use proper types
  ```typescript
  const workdir = this.getSessionWorkdir((repoSession as unknown).session);
  ```

- **src/domain/repository/github.ts:199** - Property access masking - should use proper types
  ```typescript
  const gitStatus = await (this.gitService as unknown).getStatus(workdir);
  ```

- **src/domain/repository/github.ts:214** - Property access masking - should use proper types
  ```typescript
  const counts = (revListOutput.trim() as unknown).split(/\s+/);
  ```

- **src/domain/repository/github.ts:228** - Property access masking - should use proper types
  ```typescript
  .filter(Boolean).map((line: string) => line.split("\t")[0] || "").filter((name, index, self) => name && (self as unknown).indexOf(name) === index);
  ```

- **src/domain/repository/github.ts:243** - Property access masking - should use proper types
  ```typescript
  const changes = modifiedFiles.map((m) => `${(m as unknown).status} ${m.file}`);
  ```

- **src/domain/repository/github.ts:266** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to get GitHub repository status: ${(normalizedError as unknown).message}`);
  ```

- **src/domain/repository/github.ts:295** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:296** - Property access masking - should use proper types
  ```typescript
  const repoSession = sessions.find((s) => (s as unknown).repoName === this.repoName);
  ```

- **src/domain/repository/github.ts:299** - Property access masking - should use proper types
  ```typescript
  return this.getSessionWorkdir((repoSession as unknown).session);
  ```

- **src/domain/repository/github.ts:367** - Property access masking - should use proper types
  ```typescript
  issues: [`Failed to validate GitHub repository: ${(normalizedError as unknown).message}`],
  ```

- **src/domain/repository/github.ts:368** - Property access masking - should use proper types
  ```typescript
  message: `Failed to validate GitHub repository: ${(normalizedError as unknown).message}`,
  ```

- **src/domain/repository/github.ts:381** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:391** - Property access masking - should use proper types
  ```typescript
  const sessionName = (repoSession as unknown).session;
  ```

- **src/domain/repository/github.ts:411** - Property access masking - should use proper types
  ```typescript
  message: `Failed to push to repository: ${(normalizedError as unknown).message}`,
  ```

- **src/domain/repository/github.ts:424** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:434** - Property access masking - should use proper types
  ```typescript
  const sessionName = (repoSession as unknown).session;
  ```

- **src/domain/repository/github.ts:438** - Property access masking - should use proper types
  ```typescript
  const pullResult = await (this.gitService as unknown).pullLatest(workdir);
  ```

- **src/domain/repository/github.ts:442** - Property access masking - should use proper types
  ```typescript
  message: (pullResult as unknown).updated
  ```

- **src/domain/repository/github.ts:450** - Property access masking - should use proper types
  ```typescript
  message: `Failed to pull from repository: ${(normalizedError as unknown).message}`,
  ```

- **src/domain/repository/github.ts:464** - Property access masking - should use proper types
  ```typescript
  const sessions = await (this.sessionDb as unknown).listSessions();
  ```

- **src/domain/repository/github.ts:471** - Property access masking - should use proper types
  ```typescript
  const sessionName = (repoSession as unknown).session;
  ```

- **src/domain/repository/github.ts:479** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to checkout branch: ${(normalizedError as unknown).message}`);
  ```

- **src/adapters/cli/cli-command-factory.ts:70** - Property access masking - should use proper types
  ```typescript
  (cliBridge as unknown).registerCommandCustomization(commandId!, options as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:81** - Property access masking - should use proper types
  ```typescript
  (cliBridge as unknown).registerCategoryCustomization(category, options as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:92** - Property access masking - should use proper types
  ```typescript
  return (cliBridge as unknown).generateCommand(commandId);
  ```

- **src/adapters/cli/cli-command-factory.ts:103** - Property access masking - should use proper types
  ```typescript
  return (cliBridge as unknown).generateCategoryCommand(category, { viaFactory: true });
  ```

- **src/adapters/cli/cli-command-factory.ts:113** - Property access masking - should use proper types
  ```typescript
  (cliBridge as unknown).generateAllCategoryCommands(program, { viaFactory: true });
  ```

- **src/adapters/cli/cli-command-factory.ts:142** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCommand(commandId!, options as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:153** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory(category, options as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:191** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory((CommandCategory as unknown).TASKS, {
  ```

- **src/adapters/cli/cli-command-factory.ts:268** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory((CommandCategory as unknown).GIT, {
  ```

- **src/adapters/cli/cli-command-factory.ts:281** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory((CommandCategory as unknown).SESSION, {
  ```

- **src/adapters/cli/cli-command-factory.ts:455** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory((CommandCategory as unknown).CONFIG, {
  ```

- **src/adapters/cli/cli-command-factory.ts:460** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).json) {
  ```

- **src/adapters/cli/cli-command-factory.ts:462** - Property access masking - should use proper types
  ```typescript
  const flattened = flattenObjectToKeyValue((result as unknown).resolved);
  ```

- **src/adapters/cli/cli-command-factory.ts:467** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).success && (result as unknown).resolved) {
  ```

- **src/adapters/cli/cli-command-factory.ts:471** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).showSources && (result as unknown).sources) {
  ```

- **src/adapters/cli/cli-command-factory.ts:472** - Property access masking - should use proper types
  ```typescript
  output += formatConfigurationSources((result as unknown).resolved, (result as unknown).sources);
  ```

- **src/adapters/cli/cli-command-factory.ts:475** - Property access masking - should use proper types
  ```typescript
  output += formatFlattenedConfiguration((result as unknown).resolved);
  ```

- **src/adapters/cli/cli-command-factory.ts:478** - Property access masking - should use proper types
  ```typescript
  log.cli(output as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:479** - Property access masking - should use proper types
  ```typescript
  } else if ((result as unknown).error) {
  ```

- **src/adapters/cli/cli-command-factory.ts:480** - Property access masking - should use proper types
  ```typescript
  log.cli(`Failed to load configuration: ${(result as unknown).error}`);
  ```

- **src/adapters/cli/cli-command-factory.ts:489** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).json) {
  ```

- **src/adapters/cli/cli-command-factory.ts:494** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).success && (result as unknown).configuration) {
  ```

- **src/adapters/cli/cli-command-factory.ts:498** - Property access masking - should use proper types
  ```typescript
  if ((result as unknown).showSources && (result as unknown).sources) {
  ```

- **src/adapters/cli/cli-command-factory.ts:499** - Property access masking - should use proper types
  ```typescript
  output += formatConfigurationSources((result as unknown).configuration, (result as unknown).sources);
  ```

- **src/adapters/cli/cli-command-factory.ts:502** - Property access masking - should use proper types
  ```typescript
  output += formatResolvedConfiguration((result as unknown).configuration);
  ```

- **src/adapters/cli/cli-command-factory.ts:505** - Property access masking - should use proper types
  ```typescript
  log.cli(output as unknown);
  ```

- **src/adapters/cli/cli-command-factory.ts:506** - Property access masking - should use proper types
  ```typescript
  } else if ((result as unknown).error) {
  ```

- **src/adapters/cli/cli-command-factory.ts:507** - Property access masking - should use proper types
  ```typescript
  log.cli(`Failed to load configuration: ${(result as unknown).error}`);
  ```

- **src/adapters/cli/cli-command-factory.ts:517** - Property access masking - should use proper types
  ```typescript
  cliFactory.customizeCategory((CommandCategory as unknown).SESSIONDB, {
  ```

- **src/adapters/cli/cli-command-factory.ts:558** - Property access masking - should use proper types
  ```typescript
  (sources as unknown).forEach((source, index) => {
  ```

- **src/adapters/cli/cli-command-factory.ts:559** - Property access masking - should use proper types
  ```typescript
  output += `  ${index + 1}. ${(source as unknown).name}\n`;
  ```

- **src/adapters/cli/cli-command-factory.ts:574** - Property access masking - should use proper types
  ```typescript
  output += `📁 Task Storage: ${getBackendDisplayName((resolved as unknown).backend)}`;
  ```

- **src/adapters/cli/cli-command-factory.ts:575** - Property access masking - should use proper types
  ```typescript
  if ((resolved as unknown).backend === "github-issues" && (resolved as unknown).backendConfig?.["github-issues"]) {
  ```

- **src/adapters/cli/cli-command-factory.ts:576** - Property access masking - should use proper types
  ```typescript
  const github = (resolved as unknown).backendConfig["github-issues"];
  ```

- **src/adapters/cli/cli-command-factory.ts:584** - Property access masking - should use proper types
  ```typescript
  for (const [service, creds] of Object.entries((resolved as unknown).credentials)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:588** - Property access masking - should use proper types
  ```typescript
  const source = (credsObj as unknown).source === "environment" ? "env" : (credsObj as unknown).source;
  ```

- **src/adapters/cli/cli-command-factory.ts:592** - Property access masking - should use proper types
  ```typescript
  output += (authServices as unknown).join(", ");
  ```

- **src/adapters/cli/cli-command-factory.ts:596** - Property access masking - should use proper types
  ```typescript
  if ((resolved as unknown).sessiondb) {
  ```

- **src/adapters/cli/cli-command-factory.ts:597** - Property access masking - should use proper types
  ```typescript
  const sessionBackend = (resolved.sessiondb as unknown).backend || "json";
  ```

- **src/adapters/cli/cli-command-factory.ts:600** - Property access masking - should use proper types
  ```typescript
  if (sessionBackend === "sqlite" && (resolved.sessiondb as unknown).dbPath) {
  ```

- **src/adapters/cli/cli-command-factory.ts:601** - Property access masking - should use proper types
  ```typescript
  output += ` (${(resolved.sessiondb as unknown).dbPath})`;
  ```

- **src/adapters/cli/cli-command-factory.ts:602** - Property access masking - should use proper types
  ```typescript
  } else if (sessionBackend === "postgres" && (resolved.sessiondb as unknown).connectionString) {
  ```

- **src/adapters/cli/cli-command-factory.ts:604** - Property access masking - should use proper types
  ```typescript
  } else if (sessionBackend === "json" && (resolved.sessiondb as unknown).baseDir) {
  ```

- **src/adapters/cli/cli-command-factory.ts:605** - Property access masking - should use proper types
  ```typescript
  output += ` (${(resolved.sessiondb as unknown).baseDir})`;
  ```

- **src/adapters/cli/cli-command-factory.ts:652** - Property access masking - should use proper types
  ```typescript
  if (!config || (Object as unknown).keysconfig.length === 0) {
  ```

- **src/adapters/cli/cli-command-factory.ts:657** - Property access masking - should use proper types
  ```typescript
  for (const [key, value] of Object.entries(config as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:658** - Property access masking - should use proper types
  ```typescript
  if (Array.isArray(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:660** - Property access masking - should use proper types
  ```typescript
  (value as unknown).forEach((item, index) => {
  ```

- **src/adapters/cli/cli-command-factory.ts:669** - Property access masking - should use proper types
  ```typescript
  for (const [subKey, subValue] of Object.entries(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:696** - Property access masking - should use proper types
  ```typescript
  if ((sanitized as unknown).token) {
  ```

- **src/adapters/cli/cli-command-factory.ts:697** - Property access masking - should use proper types
  ```typescript
  (sanitized as unknown).token = `${"*".repeat(20)} (hidden)`;
  ```

- **src/adapters/cli/cli-command-factory.ts:707** - Property access masking - should use proper types
  ```typescript
  for (const [key, value] of Object.entries(obj as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:712** - Property access masking - should use proper types
  ```typescript
  } else if (typeof value === "object" && !Array.isArray(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:714** - Property access masking - should use proper types
  ```typescript
  result.push(...flatten(value as unknown, fullKey));
  ```

- **src/adapters/cli/cli-command-factory.ts:715** - Property access masking - should use proper types
  ```typescript
  } else if (Array.isArray(value as unknown)) {
  ```

- **src/adapters/cli/cli-command-factory.ts:719** - Property access masking - should use proper types
  ```typescript
  (value as unknown).forEach((item, index) => {
  ```

- **src/adapters/cli/cli-command-factory.ts:721** - Property access masking - should use proper types
  ```typescript
  result.push(...flatten(item as unknown, `${fullKey}[${index}]`));
  ```

- **src/adapters/cli/cli-command-factory.ts:729** - Property access masking - should use proper types
  ```typescript
  ((fullKey as unknown).includes("token") || (fullKey as unknown).includes("password"))
  ```

- **src/adapters/cli/cli-command-factory.ts:742** - Property access masking - should use proper types
  ```typescript
  return (flatEntries as unknown).join("\n");
  ```

- **src/adapters/cli/cli-command-factory.ts:773** - Property access masking - should use proper types
  ```typescript
  cliFactory.initialize(config as unknown);
  ```

- **src/adapters/cli/integration-example.ts:32** - Property access masking - should use proper types
  ```typescript
  .description("Minsky CLI - Task-based workspace management") as unknown).version("1.0.0");
  ```

- **src/adapters/cli/integration-example.ts:42** - Property access masking - should use proper types
  ```typescript
  [(CommandCategory as unknown).GIT, (CommandCategory as unknown).TASKS, (CommandCategory as unknown).SESSION, (CommandCategory as unknown).RULES],
  ```

- **src/adapters/shared/schema-bridge.ts:46** - Property access masking - should use proper types
  ```typescript
  return (name.replace(/([a-z])([A-Z])/g, "$1-$2") as unknown).toLowerCase();
  ```

- **src/adapters/shared/schema-bridge.ts:78** - Property access masking - should use proper types
  ```typescript
  (schema instanceof z.ZodOptional && (schema._def as unknown).innerType instanceof z.ZodBoolean);
  ```

- **src/adapters/shared/schema-bridge.ts:96** - Property access masking - should use proper types
  ```typescript
  return addValuePlaceholder(flag, (schema._def as unknown).innerType);
  ```

- **src/adapters/shared/schema-bridge.ts:119** - Property access masking - should use proper types
  ```typescript
  typeof (schema as unknown).description === "string" &&
  ```

- **src/adapters/shared/schema-bridge.ts:122** - Property access masking - should use proper types
  ```typescript
  description = (schema as unknown).description;
  ```

- **src/adapters/shared/schema-bridge.ts:123** - Property access masking - should use proper types
  ```typescript
  } else if (schema instanceof z.ZodOptional && "description" in (schema._def as unknown).innerType) {
  ```

- **src/adapters/shared/schema-bridge.ts:124** - Property access masking - should use proper types
  ```typescript
  const innerDesc = (schema._def.innerType as unknown).description;
  ```

- **src/adapters/shared/schema-bridge.ts:163** - Property access masking - should use proper types
  ```typescript
  const description = (param as unknown).description || getSchemaDescription(param.schema);
  ```

- **src/adapters/shared/schema-bridge.ts:206** - Property access masking - should use proper types
  ```typescript
  (Object.entries(parameters) as unknown).forEach(([name, param]) => {
  ```

- **src/adapters/shared/schema-bridge.ts:239** - Property access masking - should use proper types
  ```typescript
  (Object.entries(parameters) as unknown).forEach(([name, param]) => {
  ```

- **src/adapters/shared/schema-bridge.ts:240** - Property access masking - should use proper types
  ```typescript
  const optionName = (paramNameToFlag(name) as unknown).replace(/-/g, "");
  ```

- **src/adapters/shared/schema-bridge.ts:247** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[name] = (param.schema as unknown).parse(value as unknown);
  ```

- **src/adapters/shared/schema-bridge.ts:257** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[name] = param.defaultValue;
  ```

- **src/adapters/shared/response-formatters.ts:58** - Property access masking - should use proper types
  ```typescript
  const format = (context.format as unknown).toLowerCase() as OutputFormat;
  ```

- **src/adapters/shared/response-formatters.ts:62** - Property access masking - should use proper types
  ```typescript
  return this.formatJson(data as unknown, context as unknown);
  ```

- **src/adapters/shared/response-formatters.ts:66** - Property access masking - should use proper types
  ```typescript
  return this.formatText(data as unknown, context as unknown);
  ```

- **src/adapters/shared/response-formatters.ts:193** - Property access masking - should use proper types
  ```typescript
  (items as unknown).forEach((item, index) => {
  ```

- **src/adapters/shared/response-formatters.ts:194** - Property access masking - should use proper types
  ```typescript
  output += `${index + 1}. ${this.itemFormatter!(item as unknown)}\n`;
  ```

- **src/adapters/shared/response-formatters.ts:197** - Property access masking - should use proper types
  ```typescript
  (items as unknown).forEach((item, index) => {
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
  return (header as unknown).padEnd((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:278** - Property access masking - should use proper types
  ```typescript
  return "-".repeat((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:289** - Property access masking - should use proper types
  ```typescript
  return (value as unknown).padEnd((columnWidths as unknown)[col]);
  ```

- **src/adapters/shared/response-formatters.ts:291** - Property access masking - should use proper types
  ```typescript
  .join(" | ") as unknown;
  ```

- **src/adapters/shared/legacy-command-registry.ts:167** - Property access masking - should use proper types
  ```typescript
  if (this.commands.has((commandDef as unknown).id) && !(options as unknown)!.allowOverwrite) {
  ```

- **src/adapters/shared/legacy-command-registry.ts:168** - Property access masking - should use proper types
  ```typescript
  throw new MinskyError(`Command with ID '${(commandDef as unknown).id}' is already registered`);
  ```

- **src/adapters/shared/legacy-command-registry.ts:171** - Property access masking - should use proper types
  ```typescript
  this.commands.set((commandDef as unknown).id!, commandDef as unknown as SharedCommand);
  ```

- **src/adapters/shared/error-handling.ts:58** - Property access masking - should use proper types
  ```typescript
  message: (normalizedError as unknown).message,
  ```

- **src/adapters/shared/error-handling.ts:100** - Property access masking - should use proper types
  ```typescript
  (result as unknown).errorType = errorType;
  ```

- **src/adapters/shared/error-handling.ts:104** - Property access masking - should use proper types
  ```typescript
  if ((normalizedError as unknown).stack) {
  ```

- **src/adapters/shared/error-handling.ts:105** - Property access masking - should use proper types
  ```typescript
  (result as unknown).stack = (normalizedError as unknown).stack;
  ```

- **src/adapters/shared/error-handling.ts:109** - Property access masking - should use proper types
  ```typescript
  if (normalizedError instanceof MinskyError && (normalizedError as unknown).cause) {
  ```

- **src/adapters/shared/error-handling.ts:110** - Property access masking - should use proper types
  ```typescript
  const cause = (normalizedError as unknown).cause;
  ```

- **src/adapters/shared/error-handling.ts:111** - Property access masking - should use proper types
  ```typescript
  (result as unknown).cause =
  ```

- **src/adapters/shared/error-handling.ts:112** - Property access masking - should use proper types
  ```typescript
  cause instanceof Error ? { message: (cause as unknown).message, stack: (cause as unknown).stack } : String(cause);
  ```

- **src/adapters/shared/error-handling.ts:153** - Property access masking - should use proper types
  ```typescript
  (typeof process.env.NODE_DEBUG === "string" && (process.env.NODE_DEBUG as unknown).includes("minsky"))
  ```

- **src/adapters/shared/error-handling.ts:165** - Property access masking - should use proper types
  ```typescript
  const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;
  ```

- **src/adapters/shared/error-handling.ts:169** - Property access masking - should use proper types
  ```typescript
  const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);
  ```

- **src/adapters/shared/error-handling.ts:192** - Property access masking - should use proper types
  ```typescript
  const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;
  ```

- **src/adapters/shared/error-handling.ts:199** - Property access masking - should use proper types
  ```typescript
  log.cliError(`${prefix}: ${(normalizedError as unknown).message}`);
  ```

- **src/adapters/shared/error-handling.ts:222** - Property access masking - should use proper types
  ```typescript
  if ((normalizedError as unknown).stack) {
  ```

- **src/adapters/shared/error-handling.ts:223** - Property access masking - should use proper types
  ```typescript
  log.cliError((normalizedError as unknown).stack);
  ```

- **src/adapters/shared/error-handling.ts:227** - Property access masking - should use proper types
  ```typescript
  if (normalizedError instanceof MinskyError && (normalizedError as unknown).cause) {
  ```

- **src/adapters/shared/error-handling.ts:229** - Property access masking - should use proper types
  ```typescript
  const cause = (normalizedError as unknown).cause;
  ```

- **src/adapters/shared/error-handling.ts:231** - Property access masking - should use proper types
  ```typescript
  log.cliError((cause as unknown).stack || (cause as unknown).message);
  ```

- **src/adapters/shared/error-handling.ts:241** - Property access masking - should use proper types
  ```typescript
  const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);
  ```

- **src/adapters/shared/error-handling.ts:261** - Property access masking - should use proper types
  ```typescript
  const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;
  ```

- **src/adapters/shared/error-handling.ts:264** - Property access masking - should use proper types
  ```typescript
  const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);
  ```

- **src/adapters/shared/error-handling.ts:288** - Property access masking - should use proper types
  ```typescript
  switch ((interfaceName as unknown).toLowerCase()) {
  ```

- **src/adapters/mcp/integration-example.ts:45** - Property access masking - should use proper types
  ```typescript
  log.debug(`Registering MCP commands for categories: ${(categories as unknown).join(", ")}`);
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

- **src/adapters/mcp/integration-example.ts:223** - Property access masking - should use proper types
  ```typescript
  (mcpBridge as unknown).registerSharedCommands([
  ```

- **src/adapters/mcp/integration-example.ts:224** - Property access masking - should use proper types
  ```typescript
  (CommandCategory as unknown).GIT,
  ```

- **src/adapters/mcp/integration-example.ts:225** - Property access masking - should use proper types
  ```typescript
  (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/mcp/integration-example.ts:226** - Property access masking - should use proper types
  ```typescript
  (CommandCategory as unknown).SESSION,
  ```

- **src/adapters/mcp/integration-example.ts:227** - Property access masking - should use proper types
  ```typescript
  (CommandCategory as unknown).RULES,
  ```

- **src/adapters/mcp/session-edit-tools.ts:216** - Property access masking - should use proper types
  ```typescript
  if (!(editContent as unknown).includes("// ... existing code ...")) {
  ```

- **src/adapters/mcp/session-edit-tools.ts:233** - Property access masking - should use proper types
  ```typescript
  const beforeContent = (editParts[i] as unknown).trim() || "";
  ```

- **src/adapters/mcp/session-edit-tools.ts:234** - Property access masking - should use proper types
  ```typescript
  const afterContent = (editParts[i + 1] as unknown).trim() || "";
  ```

- **src/adapters/mcp/session-edit-tools.ts:239** - Property access masking - should use proper types
  ```typescript
  const startIndex = (result as unknown).indexOf(beforeContent);
  ```

- **src/adapters/mcp/session-edit-tools.ts:241** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Could not find content to match: "${(beforeContent as unknown).substring(0, 50)}..."`);
  ```

- **src/adapters/mcp/session-edit-tools.ts:248** - Property access masking - should use proper types
  ```typescript
  const nextBefore = (editParts[i + 2] as unknown).trim() || "";
  ```

- **src/adapters/mcp/session-edit-tools.ts:249** - Property access masking - should use proper types
  ```typescript
  const nextStart = (result as unknown).indexOf(nextBefore, startIndex + beforeContent.length);
  ```

- **src/adapters/mcp/session-edit-tools.ts:255** - Property access masking - should use proper types
  ```typescript
  const afterIndex = (result as unknown).lastIndexOf(afterContent);
  ```

- **src/adapters/mcp/session-edit-tools.ts:262** - Property access masking - should use proper types
  ```typescript
  result = `${(result as unknown).substring(0, startIndex) + beforeContent}\n${(result as unknown).substring(endIndex)}`;
  ```

- **src/adapters/mcp/session-edit-tools.ts:274** - Property access masking - should use proper types
  ```typescript
  const startIdx = (result as unknown).indexOf(searchStart);
  ```

- **src/adapters/mcp/session-edit-tools.ts:276** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Could not find content to match: "${(searchStart as unknown).substring(0, 50)}..."`);
  ```

- **src/adapters/mcp/session-edit-tools.ts:281** - Property access masking - should use proper types
  ```typescript
  const tempEndIdx = (result as unknown).indexOf(searchEnd, startIdx + searchStart.length);
  ```

- **src/adapters/mcp/session-edit-tools.ts:287** - Property access masking - should use proper types
  ```typescript
  result = `${(result as unknown).substring(0, startIdx) + searchStart}\n${
  ```

- **src/adapters/mcp/session-edit-tools.ts:289** - Property access masking - should use proper types
  ```typescript
  }${endIdx < result.length ? (result as unknown).substring(endIdx) : ""}`;
  ```

- **src/adapters/mcp/session-edit-tools.ts:304** - Property access masking - should use proper types
  ```typescript
  while ((position = (((content) as unknown).toString() as unknown).indexOf(search, position)) !== -1) {
  ```

- **src/adapters/mcp/shared-command-integration.ts:67** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addCommand({
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

- **src/utils/test-utils/mocking.ts:139** - Property access masking - should use proper types
  ```typescript
  (registryModule.sharedCommandRegistry as unknown).commands = new Map();
  ```

- **src/mcp/tools/tasks.ts:14** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addTaskCommand(
  ```

- **src/mcp/tools/tasks.ts:19** - Property access masking - should use proper types
  ```typescript
  limit: (z.number().optional() as unknown).describe("Limit the number of tasks returned"),
  ```

- **src/mcp/tools/tasks.ts:43** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/tasks.ts:60** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addTaskCommand(
  ```

- **src/mcp/tools/tasks.ts:69** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks get ${(args as unknown)!.taskId} --json`;
  ```

- **src/mcp/tools/tasks.ts:70** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/tasks.ts:75** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error getting task ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/tasks.ts:87** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addTaskCommand(
  ```

- **src/mcp/tools/tasks.ts:96** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks status get ${(args as unknown)!.taskId}`;
  ```

- **src/mcp/tools/tasks.ts:97** - Property access masking - should use proper types
  ```typescript
  const output = ((execSync(command) as unknown).toString() as unknown).trim();
  ```

- **src/mcp/tools/tasks.ts:101** - Property access masking - should use proper types
  ```typescript
  taskId: (args as unknown)!.taskId,
  ```

- **src/mcp/tools/tasks.ts:105** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error getting task status for ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/tasks.ts:117** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addTaskCommand(
  ```

- **src/mcp/tools/tasks.ts:129** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks status set ${(args as unknown)!.taskId} ${(args as unknown).status}`;
  ```

- **src/mcp/tools/tasks.ts:135** - Property access masking - should use proper types
  ```typescript
  taskId: (args as unknown)!.taskId,
  ```

- **src/mcp/tools/tasks.ts:136** - Property access masking - should use proper types
  ```typescript
  status: (args as unknown).status,
  ```

- **src/mcp/tools/tasks.ts:139** - Property access masking - should use proper types
  ```typescript
  log.error(`MCP: Error setting task status for ${(args as unknown)!.taskId} via execSync`, {
  ```

- **src/mcp/tools/tasks.ts:151** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addTaskCommand(
  ```

- **src/mcp/tools/tasks.ts:160** - Property access masking - should use proper types
  ```typescript
  const command = `minsky tasks create ${(args as unknown).specPath} --json`;
  ```

- **src/mcp/tools/tasks.ts:161** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/session.ts:13** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addSessionCommand("list", "List all sessions", z.object({}), async () => {
  ```

- **src/mcp/tools/session.ts:17** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/session.ts:30** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addSessionCommand(
  ```

- **src/mcp/tools/session.ts:39** - Property access masking - should use proper types
  ```typescript
  const command = `minsky session get ${(args as unknown)!.session} --json`;
  ```

- **src/mcp/tools/session.ts:40** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/session.ts:45** - Property access masking - should use proper types
  ```typescript
  log.error(`Error getting session ${(args as unknown)!.session}`, { error, _session: (args as unknown)!.session });
  ```

- **src/mcp/tools/session.ts:53** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addSessionCommand(
  ```

- **src/mcp/tools/session.ts:59** - Property access masking - should use proper types
  ```typescript
  quiet: (z.boolean().optional().describe("Whether to suppress output") as unknown).default(true),
  ```

- **src/mcp/tools/session.ts:73** - Property access masking - should use proper types
  ```typescript
  if ((args as unknown)?.name) {
  ```

- **src/mcp/tools/session.ts:74** - Property access masking - should use proper types
  ```typescript
  command += ` --name ${(args as unknown).name}`;
  ```

- **src/mcp/tools/session.ts:83** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/session.ts:89** - Property access masking - should use proper types
  ```typescript
  session: (args as unknown)?.name || `task#${args!.task}` || "unnamed-session",
  ```

- **src/mcp/tools/session.ts:92** - Property access masking - should use proper types
  ```typescript
  log.error("Error starting session", { error, name: (args as unknown).name, task: args!.task });
  ```

- **src/mcp/tools/session.ts:100** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addSessionCommand(
  ```

- **src/mcp/tools/session.ts:121** - Property access masking - should use proper types
  ```typescript
  if ((args as unknown)?.message) {
  ```

- **src/mcp/tools/session.ts:122** - Property access masking - should use proper types
  ```typescript
  command += ` -m "${(args as unknown).message}"`;
  ```

- **src/mcp/tools/session.ts:124** - Property access masking - should use proper types
  ```typescript
  if ((args as unknown)!.session) {
  ```

- **src/mcp/tools/session.ts:125** - Property access masking - should use proper types
  ```typescript
  command += ` --session ${(args as unknown)!.session}`;
  ```

- **src/mcp/tools/session.ts:129** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
  ```

- **src/mcp/tools/session.ts:137** - Property access masking - should use proper types
  ```typescript
  log.error("Error committing changes", { error, session: (args as unknown)!.session });
  ```

- **src/mcp/tools/session.ts:145** - Property access masking - should use proper types
  ```typescript
  (commandMapper as unknown).addSessionCommand(
  ```

- **src/mcp/tools/session.ts:169** - Property access masking - should use proper types
  ```typescript
  const output = (execSync(command) as unknown).toString();
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

- **src/domain/storage/monitoring/health-monitor.ts:59** - Property access masking - should use proper types
  ```typescript
  const startTime = (Date as unknown).now();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:64** - Property access masking - should use proper types
  ```typescript
  sessionDbConfig = (config as unknown).get("sessiondb") as SessionDbConfig;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:83** - Property access masking - should use proper types
  ```typescript
  duration: (Date as unknown).now() - startTime,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:85** - Property access masking - should use proper types
  ```typescript
  backend: (backendHealth as unknown).backend,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:86** - Property access masking - should use proper types
  ```typescript
  healthy: (backendHealth as unknown).healthy,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:106** - Property access masking - should use proper types
  ```typescript
  backend: (sessionDbConfig as unknown).backend || "unknown",
  ```

- **src/domain/storage/monitoring/health-monitor.ts:107** - Property access masking - should use proper types
  ```typescript
  responseTime: (Date as unknown).now() - startTime,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:108** - Property access masking - should use proper types
  ```typescript
  timestamp: (new Date() as unknown).toISOString(),
  ```

- **src/domain/storage/monitoring/health-monitor.ts:126** - Property access masking - should use proper types
  ```typescript
  const startTime = (Date as unknown).now();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:129** - Property access masking - should use proper types
  ```typescript
  backend: (config as unknown).backend,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:131** - Property access masking - should use proper types
  ```typescript
  timestamp: (new Date() as unknown).toISOString(),
  ```

- **src/domain/storage/monitoring/health-monitor.ts:139** - Property access masking - should use proper types
  ```typescript
  const storage = (StorageBackendFactory as unknown).createFromConfig(config as unknown);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:147** - Property access masking - should use proper types
  ```typescript
  await (Promise as unknown).race([testPromise, timeoutPromise] as any[]);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:150** - Property access masking - should use proper types
  ```typescript
  status.responseTime = (Date as unknown).now() - startTime;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:153** - Property access masking - should use proper types
  ```typescript
  await this.performBackendSpecificChecks(config as unknown, status);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:156** - Property access masking - should use proper types
  ```typescript
  status.responseTime = (Date as unknown).now() - startTime;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:160** - Property access masking - should use proper types
  ```typescript
  backend: (config as unknown).backend,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:174** - Property access masking - should use proper types
  ```typescript
  await (storage as unknown).initialize();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:177** - Property access masking - should use proper types
  ```typescript
  const readResult = await (storage as unknown).readState();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:178** - Property access masking - should use proper types
  ```typescript
  if (!(readResult as unknown).success) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:179** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Read operation failed: ${(readResult as unknown).error}`);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:183** - Property access masking - should use proper types
  ```typescript
  if (typeof (storage as unknown).close === "function") {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:184** - Property access masking - should use proper types
  ```typescript
  await (storage as unknown).close();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:195** - Property access masking - should use proper types
  ```typescript
  switch ((config as unknown).backend) {
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

- **src/domain/storage/monitoring/health-monitor.ts:219** - Property access masking - should use proper types
  ```typescript
  const dbPath = path.join((config as unknown).baseDir || "", "session-db.json");
  ```

- **src/domain/storage/monitoring/health-monitor.ts:223** - Property access masking - should use proper types
  ```typescript
  (status.details! as any).fileSize = (stats as unknown).size;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:224** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).lastModified = (stats.mtime as unknown).toISOString();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:227** - Property access masking - should use proper types
  ```typescript
  if ((stats as unknown).size > 10_000_000) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:234** - Property access masking - should use proper types
  ```typescript
  const baseDir = (config as unknown).baseDir || path.dirname(dbPath);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:237** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).directoryWritable = true;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:240** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).directoryWritable = false;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:258** - Property access masking - should use proper types
  ```typescript
  const db = new Database((config as unknown).dbPath);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:263** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).integrityCheck = (integrityResult[0] as unknown).integrity_check === "ok";
  ```

- **src/domain/storage/monitoring/health-monitor.ts:268** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).databaseSize = pageCount * pageSize;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:272** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).journalMode = journalMode;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:280** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).busyTimeout = busyTimeout;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:300** - Property access masking - should use proper types
  ```typescript
  const pool = new Pool({ connectionString: (config as unknown).connectionString });
  ```

- **src/domain/storage/monitoring/health-monitor.ts:307** - Property access masking - should use proper types
  ```typescript
  const versionResult = await (client as unknown).query("SELECT version()");
  ```

- **src/domain/storage/monitoring/health-monitor.ts:308** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).serverVersion = (versionResult.rows[0] as unknown).version;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:311** - Property access masking - should use proper types
  ```typescript
  const connectionsResult = await (client as unknown).query(
  ```

- **src/domain/storage/monitoring/health-monitor.ts:314** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).activeConnections = parseInt(
  ```

- **src/domain/storage/monitoring/health-monitor.ts:315** - Property access masking - should use proper types
  ```typescript
  (connectionsResult.rows[0] as unknown).active_connections
  ```

- **src/domain/storage/monitoring/health-monitor.ts:319** - Property access masking - should use proper types
  ```typescript
  const sizeResult = await (client as unknown).query(
  ```

- **src/domain/storage/monitoring/health-monitor.ts:322** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).databaseSize = (sizeResult.rows[0] as unknown).size;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:325** - Property access masking - should use proper types
  ```typescript
  const locksResult = await (client as unknown).query(
  ```

- **src/domain/storage/monitoring/health-monitor.ts:328** - Property access masking - should use proper types
  ```typescript
  const lockCount = parseInt((locksResult.rows[0] as unknown).locks);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:329** - Property access masking - should use proper types
  ```typescript
  (status.details! as unknown).blockedQueries = lockCount;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:335** - Property access masking - should use proper types
  ```typescript
  (client as unknown).release();
  ```

- **src/domain/storage/monitoring/health-monitor.ts:353** - Property access masking - should use proper types
  ```typescript
  const recentMetrics = (this.metrics as unknown).slice(-100); // Last 100 operations
  ```

- **src/domain/storage/monitoring/health-monitor.ts:363** - Property access masking - should use proper types
  ```typescript
  const totalDuration = (recentMetrics as unknown).reduce((sum, metric) => sum + (metric as unknown).duration, 0);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:390** - Property access masking - should use proper types
  ```typescript
  if ((config as unknown).backend === "json") {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:391** - Property access masking - should use proper types
  ```typescript
  checkPath = (config as unknown).baseDir || "";
  ```

- **src/domain/storage/monitoring/health-monitor.ts:392** - Property access masking - should use proper types
  ```typescript
  } else if ((config as unknown).backend === "sqlite") {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:393** - Property access masking - should use proper types
  ```typescript
  checkPath = path.dirname((config as unknown).dbPath || "");
  ```

- **src/domain/storage/monitoring/health-monitor.ts:401** - Property access masking - should use proper types
  ```typescript
  (metrics as unknown).diskUsage = (stats as unknown).size || 0;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:423** - Property access masking - should use proper types
  ```typescript
  if (!(backendHealth as unknown).healthy) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:427** - Property access masking - should use proper types
  ```typescript
  if ((backendHealth as unknown).warnings && backendHealth.warnings.length > 0) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:432** - Property access masking - should use proper types
  ```typescript
  if ((performance as unknown).averageResponseTime > 1000) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:436** - Property access masking - should use proper types
  ```typescript
  if ((performance as unknown).successRate < 0.95) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:440** - Property access masking - should use proper types
  ```typescript
  if ((performance as unknown).recentErrors > 5) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:445** - Property access masking - should use proper types
  ```typescript
  if ((backendHealth as unknown).backend === "json" && (backendHealth.details as unknown).fileSize > 5_000_000) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:449** - Property access masking - should use proper types
  ```typescript
  if ((backendHealth as unknown).backend === "sqlite" && (backendHealth.details as unknown).journalMode !== "wal") {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:453** - Property access masking - should use proper types
  ```typescript
  if ((backendHealth as unknown).backend === "postgres" && (backendHealth.details as unknown).activeConnections > 80) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:467** - Property access masking - should use proper types
  ```typescript
  if (!(backendHealth as unknown).healthy) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:471** - Property access masking - should use proper types
  ```typescript
  if ((performance as unknown).successRate < 0.9 || (performance as unknown).recentErrors > 10) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:476** - Property access masking - should use proper types
  ```typescript
  (performance as unknown).successRate < 0.98 ||
  ```

- **src/domain/storage/monitoring/health-monitor.ts:477** - Property access masking - should use proper types
  ```typescript
  (performance as unknown).averageResponseTime > 2000 ||
  ```

- **src/domain/storage/monitoring/health-monitor.ts:478** - Property access masking - should use proper types
  ```typescript
  (performance as unknown).recentErrors > 3
  ```

- **src/domain/storage/monitoring/health-monitor.ts:494** - Property access masking - should use proper types
  ```typescript
  this.metrics = (this.metrics as unknown).slice(-this.MAX_METRICS);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:498** - Property access masking - should use proper types
  ```typescript
  if (!(metric as unknown).success) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:500** - Property access masking - should use proper types
  ```typescript
  operation: (metric as unknown).operationType,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:501** - Property access masking - should use proper types
  ```typescript
  backend: (metric as unknown).backend,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:502** - Property access masking - should use proper types
  ```typescript
  duration: (metric as unknown).duration,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:504** - Property access masking - should use proper types
  ```typescript
  } else if ((metric as unknown).duration > 2000) {
  ```

- **src/domain/storage/monitoring/health-monitor.ts:506** - Property access masking - should use proper types
  ```typescript
  operation: (metric as unknown).operationType,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:507** - Property access masking - should use proper types
  ```typescript
  backend: (metric as unknown).backend,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:508** - Property access masking - should use proper types
  ```typescript
  duration: (metric as unknown).duration,
  ```

- **src/domain/storage/monitoring/health-monitor.ts:517** - Property access masking - should use proper types
  ```typescript
  return (this.metrics as unknown).slice(-count);
  ```

- **src/domain/storage/monitoring/health-monitor.ts:539** - Property access masking - should use proper types
  ```typescript
  const avgResponse = totalOps > 0 ? (this.metrics as unknown).reduce((sum, m) => sum + m.duration, 0) / totalOps : 0;
  ```

- **src/domain/storage/monitoring/health-monitor.ts:542** - Property access masking - should use proper types
  ```typescript
  ? (Date as unknown).now() - new Date(this.metrics[0].timestamp).getTime()
  ```

- **src/domain/storage/monitoring/health-monitor.ts:547** - Property access masking - should use proper types
  ```typescript
  { healthy: true, backend: "test", responseTime: 0, timestamp: (new Date() as unknown).toISOString() },
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

- **src/domain/storage/backends/json-file-storage.ts:83** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:95** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:99** - Property access masking - should use proper types
  ```typescript
  let sessions = (result.data as unknown).sessions;
  ```

- **src/domain/storage/backends/json-file-storage.ts:103** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).taskId) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:104** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = (options.taskId as unknown).replace(/^#/, "");
  ```

- **src/domain/storage/backends/json-file-storage.ts:109** - Property access masking - should use proper types
  ```typescript
  return (s.taskId as unknown).replace(/^#/, "") === normalizedTaskId;
  ```

- **src/domain/storage/backends/json-file-storage.ts:112** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).repoName) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:114** - Property access masking - should use proper types
  ```typescript
  (s) => (s as unknown).repoName === (options as unknown).repoName
  ```

- **src/domain/storage/backends/json-file-storage.ts:117** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).branch) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:118** - Property access masking - should use proper types
  ```typescript
  sessions = sessions.filter((s) => (s as unknown).branch === (options as unknown).branch);
  ```

- **src/domain/storage/backends/json-file-storage.ts:127** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:132** - Property access masking - should use proper types
  ```typescript
  ...(result as unknown).data,
  ```

- **src/domain/storage/backends/json-file-storage.ts:133** - Property access masking - should use proper types
  ```typescript
  sessions: [...(result.data as unknown).sessions, entity],
  ```

- **src/domain/storage/backends/json-file-storage.ts:137** - Property access masking - should use proper types
  ```typescript
  if (!(writeResult as unknown).success) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:138** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to create entity: ${(writeResult.error as unknown).message}`);
  ```

- **src/domain/storage/backends/json-file-storage.ts:146** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:157** - Property access masking - should use proper types
  ```typescript
  (Object.entries(updates) as unknown).forEach(([key, value]) => {
  ```

- **src/domain/storage/backends/json-file-storage.ts:164** - Property access masking - should use proper types
  ```typescript
  ...(result.data as unknown).sessions[sessionIndex],
  ```

- **src/domain/storage/backends/json-file-storage.ts:168** - Property access masking - should use proper types
  ```typescript
  const newSessions = [...(result.data as unknown).sessions];
  ```

- **src/domain/storage/backends/json-file-storage.ts:172** - Property access masking - should use proper types
  ```typescript
  ...(result as unknown).data,
  ```

- **src/domain/storage/backends/json-file-storage.ts:177** - Property access masking - should use proper types
  ```typescript
  if (!(writeResult as unknown).success) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:178** - Property access masking - should use proper types
  ```typescript
  throw new Error(`Failed to update entity: ${(writeResult.error as unknown).message}`);
  ```

- **src/domain/storage/backends/json-file-storage.ts:186** - Property access masking - should use proper types
  ```typescript
  if (!(result as unknown).success || !(result as unknown).data) {
  ```

- **src/domain/storage/backends/json-file-storage.ts:195** - Property access masking - should use proper types
  ```typescript
  const newSessions = [...(result.data as unknown).sessions];
  ```

- **src/domain/storage/backends/json-file-storage.ts:199** - Property access masking - should use proper types
  ```typescript
  ...(result as unknown).data,
  ```

- **src/domain/storage/backends/json-file-storage.ts:204** - Property access masking - should use proper types
  ```typescript
  return (writeResult as unknown).success;
  ```

- **src/domain/storage/backends/json-file-storage.ts:228** - Property access masking - should use proper types
  ```typescript
  return (writeResult as unknown).success;
  ```

- **src/domain/storage/backends/error-handling.ts:76** - Property access masking - should use proper types
  ```typescript
  (StorageErrorType as unknown).CONNECTION,
  ```

- **src/domain/storage/backends/error-handling.ts:77** - Property access masking - should use proper types
  ```typescript
  (StorageErrorType as unknown).TIMEOUT,
  ```

- **src/domain/storage/backends/error-handling.ts:78** - Property access masking - should use proper types
  ```typescript
  (StorageErrorType as unknown).RESOURCE,
  ```

- **src/domain/storage/backends/error-handling.ts:80** - Property access masking - should use proper types
  ```typescript
  return (retryableTypes as unknown).includes(this.type);
  ```

- **src/domain/storage/backends/error-handling.ts:92** - Property access masking - should use proper types
  ```typescript
  originalError: (this.originalError as unknown).message,
  ```

- **src/domain/storage/backends/error-handling.ts:105** - Property access masking - should use proper types
  ```typescript
  const classification = this.analyzeError(error as unknown, context as unknown);
  ```

- **src/domain/storage/backends/error-handling.ts:108** - Property access masking - should use proper types
  ```typescript
  (classification as unknown).message,
  ```

- **src/domain/storage/backends/error-handling.ts:109** - Property access masking - should use proper types
  ```typescript
  (classification as unknown).type,
  ```

- **src/domain/storage/backends/error-handling.ts:126** - Property access masking - should use proper types
  ```typescript
  const errorMessage = (error.message as unknown).toLowerCase();
  ```

- **src/domain/storage/backends/error-handling.ts:127** - Property access masking - should use proper types
  ```typescript
  const backend = (context as unknown).backend;
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

- **src/domain/storage/backends/error-handling.ts:166** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("enoent") || (errorMessage as unknown).includes("no such file")) {
  ```

- **src/domain/storage/backends/error-handling.ts:184** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("eacces") || (errorMessage as unknown).includes("permission denied")) {
  ```

- **src/domain/storage/backends/error-handling.ts:201** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("syntaxerror") || (errorMessage as unknown).includes("unexpected token")) {
  ```

- **src/domain/storage/backends/error-handling.ts:226** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("enospc") || (errorMessage as unknown).includes("no space left")) {
  ```

- **src/domain/storage/backends/error-handling.ts:252** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("sqlite_busy") || (errorMessage as unknown).includes("database is locked")) {
  ```

- **src/domain/storage/backends/error-handling.ts:275** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("sqlite_corrupt") || (errorMessage as unknown).includes("malformed")) {
  ```

- **src/domain/storage/backends/error-handling.ts:299** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("sqlite_readonly") || (errorMessage as unknown).includes("readonly")) {
  ```

- **src/domain/storage/backends/error-handling.ts:316** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("sqlite_cantopen") || (errorMessage as unknown).includes("unable to open")) {
  ```

- **src/domain/storage/backends/error-handling.ts:344** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("econnrefused") || (errorMessage as unknown).includes("connection refused")) {
  ```

- **src/domain/storage/backends/error-handling.ts:367** - Property access masking - should use proper types
  ```typescript
  if ((pgError as unknown).code === "28P01" || (errorMessage as unknown).includes("authentication failed")) {
  ```

- **src/domain/storage/backends/error-handling.ts:384** - Property access masking - should use proper types
  ```typescript
  if ((pgError as unknown).code === "3D000" || (errorMessage as unknown).includes("database") && (errorMessage as unknown).includes("does not exist")) {
  ```

- **src/domain/storage/backends/error-handling.ts:401** - Property access masking - should use proper types
  ```typescript
  if ((pgError as unknown).code === "42P01" || (errorMessage as unknown).includes("relation") && (errorMessage as unknown).includes("does not exist")) {
  ```

- **src/domain/storage/backends/error-handling.ts:418** - Property access masking - should use proper types
  ```typescript
  if ((pgError as unknown).code === "53300" || (errorMessage as unknown).includes("too many connections")) {
  ```

- **src/domain/storage/backends/error-handling.ts:440** - Property access masking - should use proper types
  ```typescript
  if ((errorMessage as unknown).includes("timeout") || (errorMessage as unknown).includes("etimedout")) {
  ```

- **src/domain/storage/backends/error-handling.ts:472** - Property access masking - should use proper types
  ```typescript
  if (!(storageError as unknown).retryable) {
  ```

- **src/domain/storage/backends/error-handling.ts:476** - Property access masking - should use proper types
  ```typescript
  const maxRetries = this.getMaxRetries((storageError as unknown).type);
  ```

- **src/domain/storage/backends/error-handling.ts:477** - Property access masking - should use proper types
  ```typescript
  const retryDelay = this.getRetryDelay((storageError as unknown).type);
  ```

- **src/domain/storage/backends/error-handling.ts:484** - Property access masking - should use proper types
  ```typescript
  errorType: (storageError as unknown).type,
  ```

- **src/domain/storage/backends/error-handling.ts:496** - Property access masking - should use proper types
  ```typescript
  errorType: (storageError as unknown).type,
  ```

- **src/domain/storage/backends/error-handling.ts:503** - Property access masking - should use proper types
  ```typescript
  const finalError = (StorageErrorClassifier as unknown).classifyError(
  ```

- **src/domain/storage/backends/error-handling.ts:505** - Property access masking - should use proper types
  ```typescript
  (storageError as unknown).context
  ```

- **src/domain/storage/backends/error-handling.ts:510** - Property access masking - should use proper types
  ```typescript
  finalError: (finalError as unknown).message,
  ```

- **src/domain/storage/backends/error-handling.ts:528** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).CONNECTION:
  ```

- **src/domain/storage/backends/error-handling.ts:530** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).TIMEOUT:
  ```

- **src/domain/storage/backends/error-handling.ts:532** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).RESOURCE:
  ```

- **src/domain/storage/backends/error-handling.ts:541** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).CONNECTION:
  ```

- **src/domain/storage/backends/error-handling.ts:543** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).TIMEOUT:
  ```

- **src/domain/storage/backends/error-handling.ts:545** - Property access masking - should use proper types
  ```typescript
  case (StorageErrorType as unknown).RESOURCE:
  ```

- **src/domain/storage/backends/error-handling.ts:568** - Property access masking - should use proper types
  ```typescript
  (this.errorCounts as unknown).set(key, currentCount + 1);
  ```

- **src/domain/storage/backends/error-handling.ts:569** - Property access masking - should use proper types
  ```typescript
  this.lastErrors.set(key, error as unknown);
  ```

- **src/domain/storage/backends/error-handling.ts:573** - Property access masking - should use proper types
  ```typescript
  backend: (error.context as unknown).backend as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:574** - Property access masking - should use proper types
  ```typescript
  type: (error).type as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:575** - Property access masking - should use proper types
  ```typescript
  severity: (error).severity as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:576** - Property access masking - should use proper types
  ```typescript
  operation: (error.context as unknown).operation as unknown,
  ```

- **src/domain/storage/backends/error-handling.ts:605** - Property access masking - should use proper types
  ```typescript
  (this.errorCounts as unknown).clear();
  ```

- **src/domain/storage/backends/error-handling.ts:621** - Property access masking - should use proper types
  ```typescript
  if (lastError?.severity === (StorageErrorSeverity as unknown).CRITICAL) {
  ```

- **src/domain/storage/backends/error-handling.ts:624** - Property access masking - should use proper types
  ```typescript
  message: (lastError as unknown).message,
  ```

- **src/domain/storage/backends/postgres-storage.ts:60** - Property access masking - should use proper types
  ```typescript
  this.connectionUrl = (config as unknown).connectionUrl;
  ```

- **src/domain/storage/backends/postgres-storage.ts:64** - Property access masking - should use proper types
  ```typescript
  max: (config as unknown).maxConnections || 10,
  ```

- **src/domain/storage/backends/postgres-storage.ts:65** - Property access masking - should use proper types
  ```typescript
  connect_timeout: (config as unknown).connectTimeout || 30,
  ```

- **src/domain/storage/backends/postgres-storage.ts:66** - Property access masking - should use proper types
  ```typescript
  idle_timeout: (config as unknown).idleTimeout || 600,
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

- **src/domain/storage/backends/postgres-storage.ts:151** - Property access masking - should use proper types
  ```typescript
  VALUES (${(insertData as unknown).session}, ${(insertData as unknown).repoName}, ${(insertData as unknown).repoUrl},
  ```

- **src/domain/storage/backends/postgres-storage.ts:152** - Property access masking - should use proper types
  ```typescript
  ${(insertData as unknown).createdAt}, ${(insertData as unknown).taskId}, ${(insertData as unknown).branch}, ${(insertData as unknown).repoPath})
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
  .set(updateData as unknown) as unknown).where(eq((postgresSessions as unknown).session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:231** - Property access masking - should use proper types
  ```typescript
  log.error("Failed to update session in PostgreSQL:", error as unknown);
  ```

- **src/domain/storage/backends/postgres-storage.ts:242** - Property access masking - should use proper types
  ```typescript
  .delete(postgresSessions) as unknown).where(eq((postgresSessions as unknown).session, id));
  ```

- **src/domain/storage/backends/postgres-storage.ts:244** - Property access masking - should use proper types
  ```typescript
  return (result as unknown).rowCount !== null && (result as unknown).rowCount > 0 as unknown;
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

- **src/domain/storage/backends/sqlite-storage.ts:31** - Property access masking - should use proper types
  ```typescript
  session: (text("session") as unknown).primaryKey(),
  ```

- **src/domain/storage/backends/sqlite-storage.ts:32** - Property access masking - should use proper types
  ```typescript
  repoName: (text("repoName") as unknown).notNull(),
  ```

- **src/domain/storage/backends/sqlite-storage.ts:34** - Property access masking - should use proper types
  ```typescript
  createdAt: (text("createdAt") as unknown).notNull(),
  ```

- **src/domain/storage/backends/sqlite-storage.ts:57** - Property access masking - should use proper types
  ```typescript
  this.dbPath = (config as unknown).dbPath;
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

- **src/domain/storage/backends/sqlite-storage.ts:206** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).taskId) {
  ```

- **src/domain/storage/backends/sqlite-storage.ts:208** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = (options.taskId as unknown).replace(/^#/, "");
  ```

- **src/domain/storage/backends/sqlite-storage.ts:213** - Property access masking - should use proper types
  ```typescript
  sql`TRIM(${(sessionsTable as unknown).taskId}, '#') = ${normalizedTaskId} AND ${(sessionsTable as unknown).taskId} IS NOT NULL`
  ```

- **src/domain/storage/backends/sqlite-storage.ts:217** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).repoName) {
  ```

- **src/domain/storage/backends/sqlite-storage.ts:218** - Property access masking - should use proper types
  ```typescript
  conditions.push(eq((sessionsTable as unknown).repoName, (options as unknown).repoName));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:221** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).branch) {
  ```

- **src/domain/storage/backends/sqlite-storage.ts:222** - Property access masking - should use proper types
  ```typescript
  conditions.push(eq((sessionsTable as unknown).branch, (options as unknown).branch));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:227** - Property access masking - should use proper types
  ```typescript
  query = (query as unknown).where(and(...conditions)) as unknown;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:247** - Property access masking - should use proper types
  ```typescript
  session: (entity as unknown).session,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:248** - Property access masking - should use proper types
  ```typescript
  repoName: (entity as unknown).repoName,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:249** - Property access masking - should use proper types
  ```typescript
  repoUrl: (entity as unknown).repoUrl || null,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:250** - Property access masking - should use proper types
  ```typescript
  createdAt: (entity as unknown).createdAt,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:251** - Property access masking - should use proper types
  ```typescript
  taskId: (entity as unknown).taskId || null,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:252** - Property access masking - should use proper types
  ```typescript
  branch: (entity as unknown).branch || null,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:253** - Property access masking - should use proper types
  ```typescript
  repoPath: (entity as unknown).repoPath || null,
  ```

- **src/domain/storage/backends/sqlite-storage.ts:260** - Property access masking - should use proper types
  ```typescript
  log.debug(`Failed to create session '${(entity as unknown).session}': ${errorMessage}`);
  ```

- **src/domain/storage/backends/sqlite-storage.ts:279** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).repoName !== undefined) (updateData as unknown).repoName = (updates as unknown).repoName;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:280** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).repoUrl !== undefined) (updateData as unknown).repoUrl = (updates as unknown).repoUrl;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:281** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).createdAt !== undefined) (updateData as unknown).createdAt = (updates as unknown).createdAt;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:282** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).taskId !== undefined) (updateData as unknown).taskId = (updates as unknown).taskId;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:283** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).branch !== undefined) (updateData as unknown).branch = (updates as unknown).branch;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:284** - Property access masking - should use proper types
  ```typescript
  if ((updates as unknown).repoPath !== undefined) (updateData as unknown).repoPath = (updates as unknown).repoPath;
  ```

- **src/domain/storage/backends/sqlite-storage.ts:292** - Property access masking - should use proper types
  ```typescript
  .set(updateData as unknown) as unknown).where(eq((sessionsTable as unknown).session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:308** - Property access masking - should use proper types
  ```typescript
  await (this.drizzleDb.delete(sessionsTable) as unknown).where(eq((sessionsTable as unknown).session, id));
  ```

- **src/domain/storage/backends/sqlite-storage.ts:328** - Property access masking - should use proper types
  ```typescript
  .where(eq(sessionsTable.session, id)) as unknown).limit(1);
  ```

- **src/adapters/cli/utils/index.ts:50** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown)!.json) {
  ```

- **src/adapters/cli/utils/index.ts:53** - Property access masking - should use proper types
  ```typescript
  } else if ((options as unknown)!.formatter) {
  ```

- **src/adapters/cli/utils/index.ts:55** - Property access masking - should use proper types
  ```typescript
  (options as unknown)!.formatter(result as unknown);
  ```

- **src/adapters/cli/utils/index.ts:59** - Property access masking - should use proper types
  ```typescript
  log.cli(result as unknown);
  ```

- **src/adapters/cli/utils/index.ts:61** - Property access masking - should use proper types
  ```typescript
  if (Array.isArray(result as unknown)) {
  ```

- **src/adapters/cli/utils/index.ts:62** - Property access masking - should use proper types
  ```typescript
  (result as unknown)!.forEach((item) => {
  ```

- **src/adapters/cli/utils/index.ts:64** - Property access masking - should use proper types
  ```typescript
  log.cli(item as unknown);
  ```

- **src/adapters/cli/utils/index.ts:73** - Property access masking - should use proper types
  ```typescript
  log.cli(String(result as unknown));
  ```

- **src/adapters/cli/utils/shared-options.ts:93** - Property access masking - should use proper types
  ```typescript
  .option("--repo <repositoryUri>", REPO_DESCRIPTION) as unknown).option("--upstream-repo <upstreamRepoUri>", UPSTREAM_REPO_DESCRIPTION);
  ```

- **src/adapters/cli/utils/shared-options.ts:148** - Property access masking - should use proper types
  ```typescript
  session: (options as unknown).session,
  ```

- **src/adapters/cli/utils/shared-options.ts:149** - Property access masking - should use proper types
  ```typescript
  repo: (options as unknown).repo,
  ```

- **src/adapters/cli/utils/shared-options.ts:165** - Property access masking - should use proper types
  ```typescript
  json: (options as unknown).json,
  ```

- **src/adapters/cli/utils/shared-options.ts:166** - Property access masking - should use proper types
  ```typescript
  debug: (options as unknown).debug,
  ```

- **src/adapters/cli/utils/shared-options.ts:181** - Property access masking - should use proper types
  ```typescript
  const taskId = (options as unknown).task ? normalizeTaskId((options as unknown).task) : undefined;
  ```

- **src/adapters/cli/utils/shared-options.ts:204** - Property access masking - should use proper types
  ```typescript
  ...normalizeRepoOptions(options as unknown),
  ```

- **src/adapters/cli/utils/shared-options.ts:205** - Property access masking - should use proper types
  ```typescript
  ...normalizeOutputOptions(options as unknown),
  ```

- **src/adapters/cli/utils/shared-options.ts:206** - Property access masking - should use proper types
  ```typescript
  backend: (options as unknown).backend,
  ```

- **src/adapters/cli/utils/shared-options.ts:226** - Property access masking - should use proper types
  ```typescript
  ...normalizeRepoOptions(options as unknown),
  ```

- **src/adapters/cli/utils/shared-options.ts:227** - Property access masking - should use proper types
  ```typescript
  ...normalizeOutputOptions(options as unknown),
  ```

- **src/adapters/cli/utils/shared-options.ts:228** - Property access masking - should use proper types
  ```typescript
  ...normalizeTaskOptions(options as unknown),
  ```

- **src/adapters/cli/utils/error-handler.ts:26** - Property access masking - should use proper types
  ```typescript
  (typeof process.env.NODE_DEBUG === "string" && (process.env.NODE_DEBUG as unknown).includes("minsky"));
  ```

- **src/adapters/cli/utils/error-handler.ts:46** - Property access masking - should use proper types
  ```typescript
  log.cliError(`Validation error: ${(normalizedError as unknown).message}`);
  ```

- **src/adapters/cli/utils/error-handler.ts:79** - Property access masking - should use proper types
  ```typescript
  log.cliError(`Error: ${(normalizedError as unknown).message}`);
  ```

- **src/adapters/cli/utils/error-handler.ts:81** - Property access masking - should use proper types
  ```typescript
  log.cliError(`Unexpected error: ${(normalizedError as unknown).message}`);
  ```

- **src/adapters/cli/utils/error-handler.ts:87** - Property access masking - should use proper types
  ```typescript
  if ((normalizedError as unknown).stack) {
  ```

- **src/adapters/cli/utils/error-handler.ts:88** - Property access masking - should use proper types
  ```typescript
  log.cliError((normalizedError as unknown).stack);
  ```

- **src/adapters/cli/utils/error-handler.ts:92** - Property access masking - should use proper types
  ```typescript
  if (normalizedError instanceof MinskyError && (normalizedError as unknown).cause) {
  ```

- **src/adapters/cli/utils/error-handler.ts:94** - Property access masking - should use proper types
  ```typescript
  const cause = (normalizedError as unknown).cause;
  ```

- **src/adapters/cli/utils/error-handler.ts:96** - Property access masking - should use proper types
  ```typescript
  log.cliError((cause as unknown).stack || (cause as unknown).message);
  ```

- **src/adapters/cli/utils/error-handler.ts:108** - Property access masking - should use proper types
  ```typescript
  log.error("CLI operation failed", error as unknown);
  ```

- **src/adapters/cli/utils/error-handler.ts:112** - Property access masking - should use proper types
  ```typescript
  message: (normalizedError as unknown).message,
  ```

- **src/adapters/cli/utils/error-handler.ts:113** - Property access masking - should use proper types
  ```typescript
  stack: (normalizedError as unknown).stack,
  ```

- **src/adapters/cli/utils/error-handler.ts:131** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).json) {
  ```

- **src/adapters/cli/utils/error-handler.ts:136** - Property access masking - should use proper types
  ```typescript
  log.agent({ message: "Command result", result } as unknown);
  ```

- **src/adapters/cli/utils/error-handler.ts:141** - Property access masking - should use proper types
  ```typescript
  } else if ((options as unknown).formatter) {
  ```

- **src/adapters/cli/utils/error-handler.ts:142** - Property access masking - should use proper types
  ```typescript
  (options as unknown).formatter(result as unknown);
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

- **src/adapters/cli/tasks/specCommand.ts:24** - Property access masking - should use proper types
  ```typescript
  .argument("<task-id>", "ID of the task to retrieve specification _content for") as unknown).option(
  ```

- **src/adapters/cli/tasks/specCommand.ts:62** - Property access masking - should use proper types
  ```typescript
  section: (options as unknown).section,
  ```

- **src/adapters/cli/tasks/specCommand.ts:70** - Property access masking - should use proper types
  ```typescript
  json: (options as unknown).json,
  ```

- **src/adapters/cli/tasks/specCommand.ts:72** - Property access masking - should use proper types
  ```typescript
  log.cli(`Task ${(data.task as unknown).id}: ${(data.task as unknown).title}`);
  ```

- **src/adapters/cli/tasks/specCommand.ts:73** - Property access masking - should use proper types
  ```typescript
  log.cli(`Specification file: ${(data as unknown).specPath}`);
  ```

- **src/adapters/cli/tasks/specCommand.ts:76** - Property access masking - should use proper types
  ```typescript
  if ((data as unknown).section) {
  ```

- **src/adapters/cli/tasks/specCommand.ts:78** - Property access masking - should use proper types
  ```typescript
  const sectionRegex = new RegExp(`## ${(data as unknown).section}`, "i");
  ```

- **src/adapters/cli/tasks/specCommand.ts:79** - Property access masking - should use proper types
  ```typescript
  const match = (data.content as unknown).match(sectionRegex);
  ```

- **src/adapters/cli/tasks/specCommand.ts:84** - Property access masking - should use proper types
  ```typescript
  const nextSectionMatch = ((data.content as unknown).slice(startIndex + match[0].length) as unknown).match(/^## /m);
  ```

- **src/adapters/cli/tasks/specCommand.ts:86** - Property access masking - should use proper types
  ```typescript
  ? startIndex + match[0].length + (nextSectionMatch as unknown).index
  ```

- **src/adapters/cli/tasks/specCommand.ts:89** - Property access masking - should use proper types
  ```typescript
  const sectionContent = (((data.content.slice(startIndex, endIndex)) as unknown).toString() as unknown).trim();
  ```

- **src/adapters/cli/tasks/specCommand.ts:92** - Property access masking - should use proper types
  ```typescript
  log.cli(`\nSection "${(data as unknown).section}" not found in specification.`);
  ```

- **src/adapters/cli/tasks/specCommand.ts:94** - Property access masking - should use proper types
  ```typescript
  log.cli((data as unknown).content);
  ```

- **src/adapters/cli/tasks/specCommand.ts:99** - Property access masking - should use proper types
  ```typescript
  log.cli((data as unknown).content);
  ```

- **src/adapters/shared/commands/tasks.ts:66** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:114** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:155** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:166** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:171** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown)!.taskId);
  ```

- **src/adapters/shared/commands/tasks.ts:174** - Property access masking - should use proper types
  ```typescript
  `Invalid task ID: '${(params as unknown)!.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
  ```

- **src/adapters/shared/commands/tasks.ts:194** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:200** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.taskId) throw new ValidationError("Missing required parameter: taskId");
  ```

- **src/adapters/shared/commands/tasks.ts:204** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown)!.taskId);
  ```

- **src/adapters/shared/commands/tasks.ts:207** - Property access masking - should use proper types
  ```typescript
  `Invalid task ID: '${(params as unknown)!.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
  ```

- **src/adapters/shared/commands/tasks.ts:216** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:217** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:218** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:219** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:223** - Property access masking - should use proper types
  ```typescript
  let status = (params as unknown)!.status;
  ```

- **src/adapters/shared/commands/tasks.ts:228** - Property access masking - should use proper types
  ```typescript
  if (!(process.stdout as unknown).isTTY) {
  ```

- **src/adapters/shared/commands/tasks.ts:244** - Property access masking - should use proper types
  ```typescript
  (option) => (option as unknown)?.value === previousStatus
  ```

- **src/adapters/shared/commands/tasks.ts:270** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:271** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:272** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:273** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:290** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:296** - Property access masking - should use proper types
  ```typescript
  const normalizedTaskId = normalizeTaskId((params as unknown)!.taskId);
  ```

- **src/adapters/shared/commands/tasks.ts:299** - Property access masking - should use proper types
  ```typescript
  `Invalid task ID: '${(params as unknown)!.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
  ```

- **src/adapters/shared/commands/tasks.ts:341** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:366** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:402** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:428** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:454** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:465** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:488** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:493** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.taskId) throw new ValidationError("Missing required parameter: taskId");
  ```

- **src/adapters/shared/commands/tasks.ts:495** - Property access masking - should use proper types
  ```typescript
  taskId: (params as unknown)!.taskId,
  ```

- **src/adapters/shared/commands/tasks.ts:496** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:497** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:498** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:499** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:509** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:515** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.title) {
  ```

- **src/adapters/shared/commands/tasks.ts:520** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.description && !(params as unknown)!.descriptionPath) {
  ```

- **src/adapters/shared/commands/tasks.ts:525** - Property access masking - should use proper types
  ```typescript
  if ((params as unknown)!.description && (params as unknown)!.descriptionPath) {
  ```

- **src/adapters/shared/commands/tasks.ts:532** - Property access masking - should use proper types
  ```typescript
  title: (params as unknown)!.title,
  ```

- **src/adapters/shared/commands/tasks.ts:533** - Property access masking - should use proper types
  ```typescript
  description: (params as unknown)!.description,
  ```

- **src/adapters/shared/commands/tasks.ts:534** - Property access masking - should use proper types
  ```typescript
  descriptionPath: (params as unknown)!.descriptionPath,
  ```

- **src/adapters/shared/commands/tasks.ts:535** - Property access masking - should use proper types
  ```typescript
  force: (params as unknown)!.force ?? false,
  ```

- **src/adapters/shared/commands/tasks.ts:536** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:537** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:538** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:539** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:554** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:580** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/tasks.ts:591** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).TASKS,
  ```

- **src/adapters/shared/commands/tasks.ts:596** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.taskId) throw new ValidationError("Missing required parameter: taskId");
  ```

- **src/adapters/shared/commands/tasks.ts:599** - Property access masking - should use proper types
  ```typescript
  if (!(params as unknown)!.force && !(params as unknown)!.json) {
  ```

- **src/adapters/shared/commands/tasks.ts:602** - Property access masking - should use proper types
  ```typescript
  taskId: (params as unknown)!.taskId,
  ```

- **src/adapters/shared/commands/tasks.ts:603** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:604** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:605** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:606** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:613** - Property access masking - should use proper types
  ```typescript
  message: `Are you sure you want to delete task ${(task as unknown)!.id}: "${(task as unknown)!.title}"?`,
  ```

- **src/adapters/shared/commands/tasks.ts:620** - Property access masking - should use proper types
  ```typescript
  taskId: (params as unknown)!.taskId,
  ```

- **src/adapters/shared/commands/tasks.ts:626** - Property access masking - should use proper types
  ```typescript
  taskId: (params as unknown)!.taskId,
  ```

- **src/adapters/shared/commands/tasks.ts:627** - Property access masking - should use proper types
  ```typescript
  force: (params as unknown)!.force ?? false,
  ```

- **src/adapters/shared/commands/tasks.ts:628** - Property access masking - should use proper types
  ```typescript
  backend: (params as unknown)!.backend,
  ```

- **src/adapters/shared/commands/tasks.ts:629** - Property access masking - should use proper types
  ```typescript
  repo: (params as unknown)!.repo,
  ```

- **src/adapters/shared/commands/tasks.ts:630** - Property access masking - should use proper types
  ```typescript
  workspace: (params as unknown)!.workspace,
  ```

- **src/adapters/shared/commands/tasks.ts:631** - Property access masking - should use proper types
  ```typescript
  session: (params as unknown)!.session,
  ```

- **src/adapters/shared/commands/tasks.ts:634** - Property access masking - should use proper types
  ```typescript
  const message = (result as unknown)!.success
  ```

- **src/adapters/shared/commands/tasks.ts:635** - Property access masking - should use proper types
  ```typescript
  ? `Task ${(result as unknown)!.taskId} deleted successfully`
  ```

- **src/adapters/shared/commands/tasks.ts:636** - Property access masking - should use proper types
  ```typescript
  : `Failed to delete task ${(result as unknown)!.taskId}`;
  ```

- **src/adapters/shared/commands/tasks.ts:639** - Property access masking - should use proper types
  ```typescript
  if ((params as unknown)!.json) {
  ```

- **src/adapters/shared/commands/tasks.ts:642** - Property access masking - should use proper types
  ```typescript
  success: (result as unknown)!.success,
  ```

- **src/adapters/shared/commands/tasks.ts:643** - Property access masking - should use proper types
  ```typescript
  taskId: (result as unknown)!.taskId,
  ```

- **src/adapters/shared/commands/tasks.ts:644** - Property access masking - should use proper types
  ```typescript
  task: (result as unknown)!.task,
  ```

- **src/adapters/shared/commands/tasks.ts:656** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksListRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:659** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksGetRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:662** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksCreateRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:665** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksDeleteRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:668** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksStatusGetRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:671** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksStatusSetRegistration);
  ```

- **src/adapters/shared/commands/tasks.ts:674** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(tasksSpecRegistration);
  ```

- **src/adapters/shared/commands/config.ts:35** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/config.ts:40** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/config.ts:61** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/config.ts:66** - Property access masking - should use proper types
  ```typescript
  schema: (z.boolean() as unknown).default(false),
  ```

- **src/adapters/shared/commands/config.ts:77** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).CONFIG,
  ```

- **src/adapters/shared/commands/config.ts:84** - Property access masking - should use proper types
  ```typescript
  const sources = (config.util as unknown).getConfigSources();
  ```

- **src/adapters/shared/commands/config.ts:95** - Property access masking - should use proper types
  ```typescript
  json: (params as unknown).json || false,
  ```

- **src/adapters/shared/commands/config.ts:97** - Property access masking - should use proper types
  ```typescript
  name: (source as unknown).name,
  ```

- **src/adapters/shared/commands/config.ts:98** - Property access masking - should use proper types
  ```typescript
  original: (source as unknown).original,
  ```

- **src/adapters/shared/commands/config.ts:99** - Property access masking - should use proper types
  ```typescript
  parsed: (source as unknown).parsed,
  ```

- **src/adapters/shared/commands/config.ts:102** - Property access masking - should use proper types
  ```typescript
  showSources: (params as unknown).sources || false,
  ```

- **src/adapters/shared/commands/config.ts:110** - Property access masking - should use proper types
  ```typescript
  json: (params as unknown).json || false,
  ```

- **src/adapters/shared/commands/config.ts:123** - Property access masking - should use proper types
  ```typescript
  category: (CommandCategory as unknown).CONFIG,
  ```

- **src/adapters/shared/commands/config.ts:140** - Property access masking - should use proper types
  ```typescript
  json: (params as unknown).json || false,
  ```

- **src/adapters/shared/commands/config.ts:142** - Property access masking - should use proper types
  ```typescript
  showSources: (params as unknown).sources || false,
  ```

- **src/adapters/shared/commands/config.ts:143** - Property access masking - should use proper types
  ```typescript
  ...((params as unknown).sources && {
  ```

- **src/adapters/shared/commands/config.ts:145** - Property access masking - should use proper types
  ```typescript
  name: (source as unknown).name,
  ```

- **src/adapters/shared/commands/config.ts:146** - Property access masking - should use proper types
  ```typescript
  original: (source as unknown).original,
  ```

- **src/adapters/shared/commands/config.ts:147** - Property access masking - should use proper types
  ```typescript
  parsed: (source as unknown).parsed,
  ```

- **src/adapters/shared/commands/config.ts:157** - Property access masking - should use proper types
  ```typescript
  json: (params as unknown).json || false,
  ```

- **src/adapters/shared/commands/config.ts:169** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(configListRegistration);
  ```

- **src/adapters/shared/commands/config.ts:170** - Property access masking - should use proper types
  ```typescript
  (sharedCommandRegistry as unknown).registerCommand(configShowRegistration);
  ```

- **src/adapters/shared/commands/rules.ts:492** - Property access masking - should use proper types
  ```typescript
  const format = (params as unknown).format as RuleFormat | undefined;
  ```

- **src/adapters/shared/commands/rules.ts:497** - Property access masking - should use proper types
  ```typescript
  tag: (params as unknown).tag,
  ```

- **src/adapters/shared/commands/rules.ts:498** - Property access masking - should use proper types
  ```typescript
  query: (params as unknown).query,
  ```

- **src/adapters/shared/commands/sessiondb.ts:129** - Property access masking - should use proper types
  ```typescript
  sourceCount = (readResult.data as unknown).sessions?.length || 0;
  ```

- **src/adapters/shared/commands/sessiondb.ts:183** - Property access masking - should use proper types
  ```typescript
  if (Array.isArray((sourceData as unknown).sessions)) {
  ```

- **src/adapters/shared/commands/sessiondb.ts:184** - Property access masking - should use proper types
  ```typescript
  sessionRecords.push(...(sourceData as unknown).sessions);
  ```

- **src/adapters/shared/commands/sessiondb.ts:191** - Property access masking - should use proper types
  ```typescript
  ...(sessionData as unknown),
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:52** - Property access masking - should use proper types
  ```typescript
  return mappings.filter((mapping) => !(mapping.options as unknown).asArgument).map(createOptionFromMapping);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:59** - Property access masking - should use proper types
  ```typescript
  const argumentMappings = mappings.filter((mapping) => (mapping.options as unknown).asArgument);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:65** - Property access masking - should use proper types
  ```typescript
  const argName = formatArgumentName(name, (paramDef as unknown).required, (options as unknown).variadic);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:68** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).variadic) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:69** - Property access masking - should use proper types
  ```typescript
  command.argument(argName, (options as unknown).description || (paramDef as unknown).description || "");
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:71** - Property access masking - should use proper types
  ```typescript
  command.argument(argName, (options as unknown).description || (paramDef as unknown).description || "");
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:75** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).parser) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:91** - Property access masking - should use proper types
  ```typescript
  const schemaType = getZodSchemaType((paramDef as unknown).schema);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:94** - Property access masking - should use proper types
  ```typescript
  const flag = formatOptionFlag(name, (options as unknown).alias, schemaType);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:97** - Property access masking - should use proper types
  ```typescript
  const option = new Option(flag, (options as unknown).description || (paramDef as unknown).description || "");
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:100** - Property access masking - should use proper types
  ```typescript
  if ((options as unknown).hidden) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:104** - Property access masking - should use proper types
  ```typescript
  if ((paramDef as unknown).defaultValue !== undefined || (options as unknown).defaultValue !== undefined) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:105** - Property access masking - should use proper types
  ```typescript
  option.default((options as unknown).defaultValue ?? (paramDef as unknown).defaultValue);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:109** - Property access masking - should use proper types
  ```typescript
  addTypeHandlingToOption(option, schemaType, (options as unknown).parser);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:206** - Property access masking - should use proper types
  ```typescript
  return getZodSchemaType((schema as unknown).unwrap());
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:211** - Property access masking - should use proper types
  ```typescript
  return getZodSchemaType((schema._def as unknown).innerType);
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:233** - Property access masking - should use proper types
  ```typescript
  hidden: (paramDef as unknown).cliHidden,
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:257** - Property access masking - should use proper types
  ```typescript
  if ((paramDef as unknown).defaultValue !== undefined) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:258** - Property access masking - should use proper types
  ```typescript
  (result as unknown)[paramName] = (paramDef as unknown).defaultValue;
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:261** - Property access masking - should use proper types
  ```typescript
  if (!(paramDef as unknown).required) {
  ```

- **src/adapters/shared/bridges/parameter-mapper.ts:269** - Property access masking - should use proper types
  ```typescript
  const parsedValue = (paramDef.schema as unknown).parse(rawValue);
  ```

- **src/utils/test-utils/compatibility/mock-function.ts:214** - Masking null/undefined type errors - dangerous
  ```typescript
  result = undefined as unknown;
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

- **src/utils/test-utils/compatibility/mock-function.ts:392** - Property access masking - should use proper types
  ```typescript
  (mockFn as unknown).mock.originalImplementation = original;
  ```

- **src/utils/test-utils/compatibility/matchers.ts:118** - Property access masking - should use proper types
  ```typescript
  return `Any<${(this.expectedType as unknown)?.name || this.expectedType}>`;
  ```

- **src/utils/test-utils/compatibility/matchers.ts:122** - Property access masking - should use proper types
  ```typescript
  return `Any<${(this.expectedType as unknown)?.name || this.expectedType}>`;
  ```

- **src/utils/test-utils/compatibility/matchers.ts:408** - Property access masking - should use proper types
  ```typescript
  return obj !== null && typeof obj === "object" && typeof (obj as unknown).asymmetricMatch === "function";
  ```

- **src/utils/test-utils/compatibility/matchers.ts:420** - Property access masking - should use proper types
  ```typescript
  const originalEquals = (bun.expect as unknown).equals;
  ```

- **src/utils/test-utils/compatibility/matchers.ts:426** - Property access masking - should use proper types
  ```typescript
  (bun.expect as unknown).equals = (a: unknown, b: any): boolean => {
  ```

## Next Steps
1. Start with high priority items (2052 items)
2. Review error-masking assertions first
3. Fix underlying type issues rather than masking them
4. Consider proper type guards for legitimate type bridging
5. Document any assertions that must remain
