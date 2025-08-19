import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface EditTestCase {
  name: string;
  fixture: string;
  instruction: string;
  editPattern: string;
  expected: {
    containsOriginal: boolean;
    containsNew: string[];
    shouldGrow: boolean;
    noMarkers: boolean;
    notContains?: string[];
  };
}

export async function loadFixture(relPath: string): Promise<string> {
  const fullPath = join(process.cwd(), "tests/fixtures", relPath);
  return await readFile(fullPath, "utf-8");
}

export function validateEditResult(
  result: string,
  originalContent: string,
  editPattern: string,
  expected: EditTestCase["expected"]
): void {
  if (typeof result !== "string" || result.length === 0) {
    throw new Error("Result is empty or not a string");
  }

  if (expected.containsOriginal) {
    if (!result.includes(originalContent.split("\n")[0])) {
      throw new Error("Result appears to not preserve original content header");
    }
  }

  for (const newContent of expected.containsNew) {
    if (!result.includes(newContent)) {
      throw new Error(`Result missing expected new content: ${newContent}`);
    }
  }

  if (expected.shouldGrow) {
    if (!(result.length >= editPattern.length)) {
      throw new Error("Result did not grow relative to pattern length");
    }
  }

  if (expected.noMarkers) {
    if (result.includes("// ... existing code ...")) {
      throw new Error("Markers not removed from final content");
    }
  }

  if (expected.notContains && expected.notContains.length > 0) {
    for (const missing of expected.notContains) {
      if (result.includes(missing)) {
        throw new Error(`Result should not contain: ${missing}`);
      }
    }
  }
}

// Core
export const coreTestCases: EditTestCase[] = [
  {
    name: "method addition to simple class",
    fixture: "typescript/simple-class.ts",
    instruction: "Add a multiply method to the Calculator class",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["multiply", "a * b"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "replace method body in simple class",
    fixture: "typescript/simple-class.ts",
    instruction: "Change add to return 0 when any operand is 0",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return a + b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["if (a === 0 || b === 0) return 0"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 1
export const phase1TestCases: EditTestCase[] = [
  {
    name: "property/field addition to class",
    fixture: "typescript/class-with-properties.ts",
    instruction: "Add a cache property and maxRetries field to the UserService class",
    editPattern: `export class UserService {
  private users: User[] = [];
  private cache: Map<string, User> = new Map();
  private readonly maxRetries: number = 3;

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["private cache: Map<string, User>", "maxRetries: number = 3"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "sequential edit chain (two additions)",
    fixture: "typescript/simple-class.ts",
    instruction: "Add subtract and multiply methods to the Calculator class",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["subtract(", "multiply("],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "insert import at top",
    fixture: "typescript/service-with-imports.ts",
    instruction: "Add import for HttpClient and a fetch method",
    editPattern: `import { Logger } from "./logger";
import { HttpClient } from "./http";

export class Service {
  constructor(private readonly logger: Logger) {}

  // ... existing code ...

  async fetch(url: string): Promise<string> {
    return "ok";
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["import { HttpClient }", "async fetch("],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "constructor parameter addition",
    fixture: "typescript/class-with-properties.ts",
    instruction: "Add config parameter to constructor",
    editPattern: `export class UserService {
  private users: User[] = [];

  constructor(private readonly logger: Logger, private readonly config: UserServiceConfig) {}
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["UserServiceConfig"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "middle insertion between methods",
    fixture: "typescript/class-multiple-methods.ts",
    instruction: "Insert multiply between add and subtract",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["multiply(a: number, b: number)"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "static method addition",
    fixture: "typescript/simple-class.ts",
    instruction: "Add a static from method",
    editPattern: `export class Calculator {
  static from(): Calculator { return new Calculator(); }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["static from()"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 2
export const phase2TestCases: EditTestCase[] = [
  {
    name: "interface modification",
    fixture: "typescript/interface-definitions.ts",
    instruction: "Add isActive to User interface",
    editPattern: `export interface User {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["isActive: boolean"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "delete removal edit (remove method)",
    fixture: "typescript/class-multiple-methods.ts",
    instruction: "Remove subtract method from Calculator class",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["add(a: number, b: number)"],
      shouldGrow: true,
      noMarkers: false,
    },
  },
  {
    name: "generic class method addition",
    fixture: "typescript/generic-class.ts",
    instruction: "Add flatMap method to Box<T>",
    editPattern: `export class Box<T> {
  constructor(public value: T) {}
  map<U>(fn: (t: T) => U): Box<U> { return new Box(fn(this.value)); }

  flatMap<U>(fn: (t: T) => Box<U>): Box<U> { return fn(this.value); }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["flatMap<U>"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "nested structure addition",
    fixture: "typescript/nested-structures.ts",
    instruction: "Add nested helper function",
    editPattern: `export class Outer {
  innerMethod() {
    function inner() { return 42; }
    // ... existing code ...
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["function inner()"],
      shouldGrow: true,
      noMarkers: false,
    },
  },
  {
    name: "interface extension and property addition",
    fixture: "typescript/interface-definitions.ts",
    instruction: "Extend User interface and add UserService interface",
    editPattern: `export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface UserService {
  findUser(id: string): Promise<User | null>;
  createUser(userData: Partial<User>): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User>;
  deleteUser(id: string): Promise<void>;
  listUsers(options?: { limit?: number; offset?: number }): Promise<User[]>;
}`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "createdAt: Date",
        "updatedAt: Date",
        "isActive: boolean",
        "export interface UserService",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "type alias and union modifications",
    fixture: "typescript/interface-definitions.ts",
    instruction: "Add UserRole, UserStatus, and typed CreateUserData",
    editPattern: `// ... existing code ...

export type UserRole = 'admin' | 'user' | 'guest' | 'moderator' | 'viewer';

export type UserStatus = 'active' | 'inactive' | 'pending' | 'suspended';

export type CreateUserData = Omit<User, 'id' | 'createdAt' | 'updatedAt'> & {
  password: string;
  confirmPassword: string;
};
`,
    expected: {
      containsOriginal: true,
      containsNew: ["UserRole", "UserStatus", "CreateUserData", "'moderator'", "'viewer'"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 3
export const phase3TestCases: EditTestCase[] = [
  {
    name: "decorator addition",
    fixture: "typescript/decorated-class.ts",
    instruction: "Add @Injectable() to Repo class if missing and a save method",
    editPattern: `import { Injectable } from "./decorators";
@Injectable()
export class Repo {
  find(): any[] { return []; }
  save<T>(t: T): void {}
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["@Injectable()", "save<"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "multiple markers in large file",
    fixture: "typescript/large-service.ts",
    instruction: "Add a log method and wire it after init",
    editPattern: `export class LargeService {
  // ... existing code ...
  log(msg: string): void { /* noop */ }
  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["log(msg: string)"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "comment preservation during edits",
    fixture: "typescript/commented-service.ts",
    instruction: "Add updateUser method with full JSDoc, preserve comments",
    editPattern: `  // ... existing code ...

  /**
   * Updates an existing user
   *
   * @param id - The user ID to update
   * @param updateData - The data to update
   * @returns Promise resolving to the updated user
   * @throws {Error} When user is not found
   */
  async updateUser(id: string, updateData: Partial<{ email: string; name: string }>): Promise<{ id: string } & Record<string, any>> {
    // Find existing user
    // ... existing code ...
    return { id, ...updateData } as any;
  }
`,
    expected: {
      containsOriginal: true,
      containsNew: ["/**", "@param id", "@returns", "updateUser("],
      shouldGrow: true,
      noMarkers: false,
    },
  },
  {
    name: "conflicting edit detection (ambiguous position)",
    fixture: "typescript/simple-class.ts",
    instruction: "Insert method using ambiguous markers only",
    editPattern: `// ... existing code ...
// ... existing code ...
// ... existing code ...`,
    expected: {
      containsOriginal: true,
      containsNew: [],
      shouldGrow: false,
      noMarkers: false,
    },
  },
  {
    name: "formatting preservation (spacing and comments)",
    fixture: "typescript/commented-service.ts",
    instruction: "Add noop method without altering existing indentation or comments",
    editPattern: `  // ... existing code ...

  // lightweight diagnostic utility
  noop(): void {
    // intentionally empty
  }
`,
    expected: {
      containsOriginal: true,
      containsNew: ["noop(): void"],
      shouldGrow: true,
      noMarkers: false,
    },
  },
];
