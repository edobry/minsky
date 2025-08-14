import { readFile } from "fs/promises";
import { join } from "path";

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
];

/**
 * Test helpers for session.edit_file integration tests
 */

// Use mock.module() to mock filesystem operations
// Use mock.module() to mock filesystem operations
// import { readFile } from "fs/promises";
import { join } from "path";

// Import utilities
import {
  analyzeEditPattern,
  createMorphCompletionParams,
  MorphFastApplyRequest,
} from "../../../src/domain/ai/edit-pattern-utils.js";
import { DefaultAICompletionService } from "../../../src/domain/ai/completion-service.js";
import { getConfiguration } from "../../../src/domain/configuration/index.js";

// Test case interface
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
  };
}

// Configuration helper
export async function getTestConfig(): Promise<{
  hasValidMorphConfig: boolean;
  provider: string;
  model: string;
  baseURL: string;
}> {
  const config = getConfiguration();
  const morphConfig = config.ai?.providers?.morph;
  const baseURL = morphConfig?.baseURL || morphConfig?.baseUrl || "https://api.morphllm.com/v1";

  const hasValidMorphConfig = !!(morphConfig?.enabled && morphConfig?.apiKey && baseURL);

  return {
    hasValidMorphConfig,
    provider: "morph",
    model: morphConfig?.model || "morph-v3-large",
    baseURL,
  };
}

// Fixture loader
export async function loadFixture(name: string): Promise<string> {
  const fixturePath = join(process.cwd(), "tests", "fixtures", name);
  return await readFile(fixturePath, "utf-8");
}

// Simplified edit pattern application
export async function applyEditPattern(
  originalContent: string,
  editPattern: string,
  instruction: string,
  verbose = false
): Promise<string> {
  const testConfig = await getTestConfig();

  if (!testConfig.hasValidMorphConfig) {
    throw new Error("Morph configuration not available for testing");
  }

  // Analyze pattern (always do this for validation)
  const patternAnalysis = analyzeEditPattern(editPattern);

  if (verbose) {
    console.log(
      `📝 Pattern Analysis: ${patternAnalysis.hasMarkers ? "✅" : "❌"} markers, ${patternAnalysis.markerCount} sections`
    );
    if (!patternAnalysis.validation.isValid) {
      console.log(`⚠️  Issues: ${patternAnalysis.validation.issues.join(", ")}`);
    }
  }

  // Create completion service
  const config = getConfiguration();
  const completionService = new DefaultAICompletionService({
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  } as any);

  // Create Morph request using utilities
  const morphRequest: MorphFastApplyRequest = {
    instruction,
    originalCode: originalContent,
    editPattern,
  };

  const completionParams = createMorphCompletionParams(morphRequest, {
    provider: testConfig.provider,
    model: testConfig.model,
    temperature: 0.1,
    maxTokens: Math.max(originalContent.length * 2, 4000),
  });

  if (verbose) {
    console.log(
      `🚀 Calling ${testConfig.provider} with ${completionParams.prompt.length} char prompt`
    );
  }

  // Make API call
  const startTime = Date.now();
  const response = await completionService.complete(completionParams);
  const duration = Date.now() - startTime;

  if (verbose) {
    console.log(`✅ Response received in ${duration}ms (${response.content.length} chars)`);
  }

  return response.content.trim();
}

// Test result validator
export function validateEditResult(
  result: string,
  originalContent: string,
  editPattern: string,
  expected: EditTestCase["expected"]
): void {
  // Basic result validation
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
  expect(result.length).toBeGreaterThan(0);

  // Check for original content preservation
  if (expected.containsOriginal) {
    const originalLines = originalContent.split("\n").filter((line) => line.trim());
    const hasOriginalContent = originalLines.some((line) => result.includes(line.trim()));
    expect(hasOriginalContent).toBe(true);
  }

  // Check for new content
  expected.containsNew.forEach((expectedContent) => {
    expect(result).toContain(expectedContent);
  });

  // Check growth expectation
  if (expected.shouldGrow) {
    expect(result.length).toBeGreaterThan(originalContent.length);
  }

  // Check marker removal
  if (expected.noMarkers) {
    expect(result).not.toContain("// ... existing code ...");
  }

  // Validate TypeScript syntax (basic check)
  const openBraces = (result.match(/{/g) || []).length;
  const closeBraces = (result.match(/}/g) || []).length;
  expect(openBraces).toBe(closeBraces);
}

// Common test cases
export const commonTestCases: EditTestCase[] = [
  {
    name: "simple function addition",
    fixture: "typescript/simple-class.ts",
    instruction: "Add a multiply method to the Calculator class",
    editPattern: `// ... existing code ...
  
  multiply(a: number, b: number): number {
    return a * b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["multiply(a: number, b: number): number", "return a * b"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "method replacement",
    fixture: "typescript/simple-class.ts",
    instruction: "Replace the add method with a safer version that validates inputs",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Both arguments must be numbers');
    }
    return a + b;
  }
}`,
    expected: {
      containsOriginal: false, // Original add method should be replaced
      containsNew: ["typeof a !== 'number'", "throw new Error", "Both arguments must be numbers"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "multiple method addition",
    fixture: "typescript/simple-class.ts",
    instruction: "Add multiple mathematical operations to the Calculator class",
    editPattern: `// ... existing code ...
  
  subtract(a: number, b: number): number {
    return a - b;
  }
  
  multiply(a: number, b: number): number {
    return a * b;
  }
  
  divide(a: number, b: number): number {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["subtract(", "multiply(", "divide(", "Division by zero"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 1: Core Edit Patterns
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
    name: "import statement addition",
    fixture: "typescript/service-with-imports.ts",
    instruction: "Add Logger import for debugging functionality",
    editPattern: `import { EventEmitter } from 'events';
import { Logger } from './logger';

// ... existing code ...`,
    expected: {
      containsOriginal: true,
      containsNew: ["import { Logger } from './logger'"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "middle insertion between methods",
    fixture: "typescript/class-multiple-methods.ts",
    instruction: "Add a divide method between multiply and validateNumber",
    editPattern: `// ... existing code ...

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    this.validateNumber(a);
    this.validateNumber(b);
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }

  private validateNumber(value: number): void {
    // ... existing code ...
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "divide(a: number, b: number): number",
        "Division by zero",
        "this.validateNumber(a)",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "constructor parameter addition",
    fixture: "typescript/class-with-properties.ts",
    instruction: "Add a config parameter to the constructor",
    editPattern: `export class UserService {
  private users: User[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly config: UserServiceConfig
  ) {}

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["private readonly config: UserServiceConfig"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "static method addition",
    fixture: "typescript/simple-class.ts",
    instruction: "Add a static utility method to the Calculator class",
    editPattern: `export class Calculator {
  static isValidNumber(value: any): value is number {
    return typeof value === 'number' && !isNaN(value);
  }

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["static isValidNumber", "value is number", "!isNaN(value)"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "async method addition",
    fixture: "typescript/class-with-properties.ts",
    instruction: "Add an async method to save users to a database",
    editPattern: `// ... existing code ...

  async saveUser(user: User): Promise<void> {
    this.logger.debug(\`Saving user: \${user.id}\`);
    this.users.push(user);
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["async saveUser", "Promise<void>", "await new Promise"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 2: Structural Complexity
export const phase2TestCases: EditTestCase[] = [
  {
    name: "mixed operations (add + replace + modify)",
    fixture: "typescript/simple-class.ts",
    instruction:
      "Replace add method with validation, add multiply method, and modify class to extend BaseCalculator",
    editPattern: `export class Calculator extends BaseCalculator {
  add(a: number, b: number): number {
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Invalid input: both arguments must be numbers');
    }
    return a + b;
  }

  multiply(a: number, b: number): number {
    this.validateInputs(a, b);
    return a * b;
  }

  private validateInputs(a: number, b: number): void {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('Invalid input: arguments must be finite numbers');
    }
  }
}`,
    expected: {
      containsOriginal: false, // Original add method is replaced
      containsNew: [
        "extends BaseCalculator",
        "multiply(",
        "validateInputs",
        "Number.isFinite",
        "Invalid input",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "nested structure edits (inner class method addition)",
    fixture: "typescript/nested-structures.ts",
    instruction: "Add a transaction method to the inner Connection class",
    editPattern: `  class Connection {
    constructor(private readonly connectionString: string) {}

    async query<T>(sql: string, params?: any[]): Promise<T[]> {
      // Simulate database query
      return [];
    }

    async transaction<T>(callback: (conn: Connection) => Promise<T>): Promise<T> {
      // Begin transaction
      try {
        const result = await callback(this);
        // Commit transaction
        return result;
      } catch (error) {
        // Rollback transaction
        throw error;
      }
    }

    async close(): Promise<void> {
      // Close connection
    }
  }`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "async transaction",
        "callback: (conn: Connection)",
        "Begin transaction",
        "Rollback transaction",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "interface extension and property addition",
    fixture: "typescript/interface-definitions.ts",
    instruction: "Add new properties to User interface and extend UserService interface",
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
  listUsers(options?: ListOptions): Promise<User[]>;
}

// ... existing code ...`,
    expected: {
      containsOriginal: true,
      containsNew: ["createdAt: Date", "updateUser", "deleteUser", "listUsers", "ListOptions"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "generic class modifications",
    fixture: "typescript/generic-class.ts",
    instruction: "Add generic constraints and new methods with multiple type parameters",
    editPattern: `export class Repository<T extends { id: string; createdAt: Date }, K = string> {
  private items: T[] = [];
  private cache: Map<K, T> = new Map();

  constructor(private readonly tableName: string) {}

  // ... existing code ...

  async findByField<F extends keyof T>(field: F, value: T[F]): Promise<T[]> {
    return this.items.filter(item => item[field] === value);
  }

  async updateMany<U extends Partial<T>>(filter: Partial<T>, updates: U): Promise<T[]> {
    const itemsToUpdate = this.items.filter(item => 
      Object.entries(filter).every(([key, value]) => item[key as keyof T] === value)
    );
    
    return itemsToUpdate.map(item => ({ ...item, ...updates } as T));
  }

  getCacheStats(): { size: number; keys: K[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "T extends { id: string; createdAt: Date }, K = string",
        "findByField<F extends keyof T>",
        "updateMany",
        "getCacheStats",
        "private cache: Map<K, T>",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "type alias and union modifications",
    fixture: "typescript/interface-definitions.ts",
    instruction: "Add new type aliases and extend existing union types",
    editPattern: `// ... existing code ...

export type UserRole = 'admin' | 'user' | 'guest' | 'moderator' | 'viewer';

export type UserStatus = 'active' | 'inactive' | 'pending' | 'suspended';

export type UserWithRole = User & {
  role: UserRole;
  status: UserStatus;
};

export type CreateUserData = Omit<User, 'id' | 'createdAt' | 'updatedAt'> & {
  password: string;
  confirmPassword: string;
};

export type UserFilters = {
  role?: UserRole;
  status?: UserStatus;
  createdAfter?: Date;
  createdBefore?: Date;
};

// ... existing code ...`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "'moderator'",
        "'viewer'",
        "UserStatus",
        "UserWithRole",
        "CreateUserData",
        "UserFilters",
        "Omit<User",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "complex method signature with generics and constraints",
    fixture: "typescript/generic-class.ts",
    instruction: "Add a complex method with multiple generic parameters and constraints",
    editPattern: `// ... existing code ...

  async aggregateResults<
    R extends Record<string, any>,
    A extends keyof R = keyof R
  >(
    aggregateBy: A,
    aggregateFunction: (items: T[]) => R[A],
    filterCondition?: (item: T) => boolean
  ): Promise<Map<T[A], R[A]>> {
    const filteredItems = filterCondition 
      ? this.items.filter(filterCondition)
      : this.items;
    
    const groups = new Map<T[A], T[]>();
    
    for (const item of filteredItems) {
      const key = item[aggregateBy];
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
    }
    
    const result = new Map<T[A], R[A]>();
    for (const [key, groupItems] of groups) {
      result.set(key, aggregateFunction(groupItems));
    }
    
    return result;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "aggregateResults<",
        "R extends Record<string, any>",
        "A extends keyof R",
        "aggregateFunction",
        "filterCondition",
        "Map<T[A], R[A]>",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 3: Advanced Patterns
export const phase3TestCases: EditTestCase[] = [
  {
    name: "multiple markers with complex insertions",
    fixture: "typescript/class-multiple-methods.ts",
    instruction: "Add error handling to existing methods and insert logging between operations",
    editPattern: `export class MathUtils {
  add(a: number, b: number): number {
    try {
      // ... existing code ...
      
      console.log(\`Adding \${a} + \${b}\`);
      return a + b;
    } catch (error) {
      console.error('Addition failed:', error);
      throw error;
    }
  }

  subtract(a: number, b: number): number {
    try {
      // ... existing code ...
      
      console.log(\`Subtracting \${a} - \${b}\`);
      return a - b;
    } catch (error) {
      console.error('Subtraction failed:', error);
      throw error;
    }
  }

  // ... existing code ...

  private logOperation(operation: string, a: number, b: number, result: number): void {
    console.log(\`\${operation}(\${a}, \${b}) = \${result}\`);
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["try {", "catch (error)", "console.log", "logOperation", "console.error"],
      shouldGrow: true,
      noMarkers: false, // Multiple markers may be preserved during complex insertions
    },
  },
  {
    name: "decorator addition to class",
    fixture: "typescript/decorated-class.ts",
    instruction: "Add validation decorators to properties and method decorators",
    editPattern: `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import { IsEmail, IsNotEmpty, Length } from 'class-validator';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @Column()
  @IsNotEmpty()
  @Length(2, 50)
  name: string;

  @Column({ default: true })
  @IsNotEmpty()
  isActive: boolean;

  // ... existing code ...

  @BeforeInsert()
  @BeforeUpdate()
  validateData(): void {
    if (!this.email || !this.name) {
      throw new Error('Email and name are required');
    }
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "@IsEmail()",
        "@IsNotEmpty()",
        "@Length(2, 50)",
        "@BeforeInsert()",
        "validateData()",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
  {
    name: "comment preservation during edits",
    fixture: "typescript/commented-service.ts",
    instruction: "Add new method while preserving all existing documentation and comments",
    editPattern: `  // ... existing code ...

  /**
   * Updates an existing user
   * 
   * @param id - The user ID to update
   * @param updateData - The data to update
   * @returns Promise resolving to the updated user
   * @throws {ValidationError} When update data is invalid
   * @throws {NotFoundError} When user is not found
   */
  async updateUser(id: string, updateData: Partial<CreateUserData>): Promise<User> {
    // Validate update data
    this.validateUpdateData(updateData);
    
    // Find existing user
    const existingUser = this.users.find(user => user.id === id);
    if (!existingUser) {
      throw new NotFoundError(\`User with ID \${id} not found\`);
    }
    
    // Merge update data
    Object.assign(existingUser, updateData);
    
    return existingUser;
  }

  /**
   * Validates update data
   * 
   * @private
   * @param updateData - The update data to validate
   * @throws {ValidationError} When validation fails
   */
  private validateUpdateData(updateData: Partial<CreateUserData>): void {
    if (updateData.email && !this.isValidEmail(updateData.email)) {
      throw new ValidationError('Invalid email format');
    }
  }

  // ... existing code ...`,
    expected: {
      containsOriginal: true,
      containsNew: [
        "updateUser",
        "validateUpdateData",
        "@param id",
        "@throws {NotFoundError}",
        "Object.assign",
      ],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];
