import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix common parameter name patterns where underscore prefixed versions are used but non-prefixed are referenced
  const fixes = [
    // Fix _error patterns - change to error
    { pattern: /\b_error\b/g, replacement: "error" },
    // Fix _err patterns - change to err
    { pattern: /\b_err\b/g, replacement: "err" },
    // Fix _params patterns - change to params
    { pattern: /\b_params\b/g, replacement: "params" },
    // Fix _args patterns - change to args
    { pattern: /\b_args\b/g, replacement: "args" },
    // Fix _options patterns - change to options
    { pattern: /\b_options\b/g, replacement: "options" },
    // Fix _command patterns - change to command
    { pattern: /\b_command\b/g, replacement: "command" },
    // Fix _result patterns - change to result
    { pattern: /\b_result\b/g, replacement: "result" },
    // Fix _sources patterns - change to sources
    { pattern: /\b_sources\b/g, replacement: "sources" },
    // Fix _data patterns - change to data
    { pattern: /\b_data\b/g, replacement: "data" },
    // Fix _config patterns - change to config
    { pattern: /\b_config\b/g, replacement: "config" },
    // Fix _context patterns - change to context
    { pattern: /\b_context\b/g, replacement: "context" },
    // Fix _value patterns - change to value
    { pattern: /\b_value\b/g, replacement: "value" },
    // Fix _content patterns - change to content
    { pattern: /\b_content\b/g, replacement: "content" },
    // Fix _session patterns - change to session
    { pattern: /\b_session\b/g, replacement: "session" },
    // Fix _taskId patterns - change to taskId
    { pattern: /\b_taskId\b/g, replacement: "taskId" },
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
    }
  }

  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    changedFiles.add(file);
    totalChanges += fileChanges;
    console.log(`${file}: ${fileChanges} changes`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${changedFiles.size} files`);
