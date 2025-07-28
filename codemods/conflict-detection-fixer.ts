/**
 * Conflict Detection Test Fixer
 *
 * This codemod specifically fixes the malformed mock assignment patterns
 * in the conflict-detection.test.ts file using targeted string replacements.
 */
import { readFileSync, writeFileSync } from "fs";

export class ConflictDetectionFixer {
  private readonly filePath = "src/domain/git/conflict-detection.test.ts";

  public async fix(): Promise<void> {
    console.log("🔧 Fixing conflict-detection.test.ts mock assignments...");

    let content = readFileSync(this.filePath, "utf-8");
    let changed = false;

    // Pattern 1: Fix the "= mock(" pattern by converting to proper chain
    const pattern1 = /(\s+)= mock\(([^}]+})\); \/\/ ([^\n]+)/g;
    if (pattern1.test(content)) {
      content = content.replace(
        pattern1,
        "$1.mockImplementationOnce(() => Promise.resolve($2)); // $3"
      );
      changed = true;
      console.log("✅ Fixed = mock( patterns");
    }

    // Pattern 2: Fix long single-line mock chains by splitting them
    const longChainPattern =
      /mockExecAsync = mock\([^)]+\)(\\.mockImplementationOnce\([^)]+\)){3,}/g;
    content = content.replace(longChainPattern, (match) => {
      // Split long chains into multiple lines for readability
      const parts = match.split(".mockImplementationOnce");
      if (parts.length > 1) {
        const result =
          parts[0] +
          "\n        " +
          parts
            .slice(1)
            .map((part) => ".mockImplementationOnce" + part)
            .join("\n        ");
        changed = true;
        return result;
      }
      return match;
    });

    // Pattern 3: Ensure proper termination of mock chains
    content = content.replace(
      /\)\) \/\/ ([^\n]+)\n(\s+)= mock\(/g,
      ")) // $1\n$2.mockImplementationOnce("
    );
    changed = true;

    if (changed) {
      writeFileSync(this.filePath, content);
      console.log(`✅ Fixed ${this.filePath}`);
    } else {
      console.log("ℹ️  No changes needed");
    }
  }
}

// Allow running directly from command line
if (require.main === module) {
  const fixer = new ConflictDetectionFixer();
  fixer.fix().catch(console.error);
}
