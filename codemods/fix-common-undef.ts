// console is a global
#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { join  } from 'path';

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry, of, entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.git')) {
        traverse(fullPath);
      } else if (stat.isFile() && entry.endsWith('.ts') && !entry.includes('.test.') && !entry.includes('.spec.')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

const files = findTsFiles('src');

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file, of, files) {
  const content = readFileSync(file, 'utf8') as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix common parameter name patterns
  const fixes = [
    // Fix error patterns - change to error
    { pattern: /\berror\b/g, replacement: 'error' },
    // Fix _params patterns - change to params  
    { pattern: /\b_params\b/g, replacement: 'params' },
    // Fix _args patterns - change to args
    { pattern: /\b_args\b/g, replacement: 'args' },
    // Fix _path patterns - change to path
    { pattern: /\b_path\b/g, replacement: 'path' },
    // Fix _options patterns - change to options
    { pattern: /\b_options\b/g, replacement: 'options' },
    // Fix _id patterns - change to id
    { pattern: /\b_id\b/g, replacement: 'id' },
    // Fix result patterns - change to result
    { pattern: /\bresult\b/g, replacement: 'result' },
    // Fix _data patterns - change to data
    { pattern: /\b_data\b/g, replacement: 'data' },
    // Fix _config patterns - change to config
    { pattern: /\b_config\b/g, replacement: 'config' },
    // Fix _context patterns - change to context
    { pattern: /\b_context\b/g, replacement: 'context' },
    // Fix _this patterns - change to this
    { pattern: /\b_this\b/g, replacement: 'this' },
    // Fix _value patterns - change to value
    { pattern: /\b_value\b/g, replacement: 'value' },
    // Fix _fn patterns - change to fn
    { pattern: /\b_fn\b/g, replacement: 'fn' },
    // Fix _meta patterns - change to meta
    { pattern: /\b_meta\b/g, replacement: 'meta' },
    // Fix _content patterns - change to content
    { pattern: /\b_content\b/g, replacement: 'content' },
    // Fix _session patterns - change to session
    { pattern: /\b_session\b/g, replacement: 'session' },
    // Fix _command patterns - change to command
    { pattern: /\b_command\b/g, replacement: 'command' },
    // Fix _taskId patterns - change to taskId
    { pattern: /\b_taskId\b/g, replacement: 'taskId' },
    // Fix _updates patterns - change to updates
    { pattern: /\b_updates\b/g, replacement: 'updates' },
    // Fix _backend patterns - change to backend
    { pattern: /\b_backend\b/g, replacement: 'backend' },
    // Fix _debug patterns - change to debug
    { pattern: /\b_debug\b/g, replacement: 'debug' },
    // Fix _index patterns - change to index
    { pattern: /\b_index\b/g, replacement: 'index' },
    // Fix _mcp patterns - change to mcp
    { pattern: /\b_mcp\b/g, replacement: 'mcp' },
    // Fix _normalizedError patterns - change to normalizedError
    { pattern: /\b_normalizedError\b/g, replacement: 'normalizedError' },
    // Fix _ruleFormat patterns - change to ruleFormat
    { pattern: /\b_ruleFormat\b/g, replacement: 'ruleFormat' },
    // Fix _newState patterns - change to newState
    { pattern: /\b_newState\b/g, replacement: 'newState' },
    // Fix _ensureFullyQualified patterns - change to ensureFullyQualified
    { pattern: /\b_ensureFullyQualified\b/g, replacement: 'ensureFullyQualified' },
    // Fix _CommandExecutionContext patterns - change to CommandExecutionContext
    { pattern: /\b_CommandExecutionContext\b/g, replacement: 'CommandExecutionContext' },
    // Fix _CommandCategory patterns - change to CommandCategory
    { pattern: /\b_CommandCategory\b/g, replacement: 'CommandCategory' }];

  for (const fix, of, fixes) {
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
    console.log(`${file}: ${fileChanges}, changes`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${changedFiles.size}, files`); 
 