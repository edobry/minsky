/**
 * Integration tests for session.edit_file MCP tool with mock filesystem
 *
 * These tests verify that session.edit_file works with AI processing
 * using mock filesystem operations and fixtures.
 *
 * Usage: bun test tests/integration/session-edit-file-simplified.integration.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { applyEditPattern } from "../../src/adapters/mcp/session-edit-tools";
import {
  initializeConfiguration,
  CustomConfigFactory,
  getConfiguration,
} from "../../src/domain/configuration/index.js";
import { createMockFilesystem } from "../../src/utils/test-utils/filesystem/mock-filesystem";

interface TestConfig {
  hasValidMorphConfig: boolean;
  morphBaseUrl?: string;
  morphApiKey?: string;
}

import {
  validateEditResult,
  coreTestCases,
  phase1TestCases,
  phase2TestCases,
  phase3TestCases,
  type EditTestCase,
} from "./helpers/edit-test-helpers";

// Test configuration
let testConfig: TestConfig;
let mockFs: ReturnType<typeof createMockFilesystem>;
let loadedConfig: any; // The actual config loaded from environment, to be injected into SUT

// Mock fixture data (instead of reading from real files)
const mockFixtures: Record<string, string> = {
  "typescript/simple-class.ts": `export class Calculator {
  constructor() {
    console.log("Calculator initialized");
  }

  add(a: number, b: number): number {
    return a + b;
  }
}`,
  "typescript/class-with-properties.ts": `export class UserService {
  private users: User[] = [];
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.find(user => user.id === id) || null;
  }

  async createUser(userData: CreateUserData): Promise<User> {
    const user = { ...userData, id: generateId() };
    this.users.push(user);
    return user;
  }
}`,
  "typescript/service-with-imports.ts": `import { Logger } from "./utils/logger";

export class DataService {
  private logger: Logger;

  constructor() {
    this.logger = new Logger("DataService");
  }

  async processData(data: any[]): Promise<any[]> {
    this.logger.info("Processing data");
    return data.map(item => ({ ...item, processed: true }));
  }
}`,
  "typescript/class-multiple-methods.ts": `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  divide(a: number, b: number): number {
    if (b === 0) throw new Error("Division by zero");
    return a / b;
  }
}`,
  "typescript/interface-definitions.ts": `export interface User {
  id: string;
  name: string;
  email: string;
}

export interface CreateUserData {
  name: string;
  email: string;
}`,
  "typescript/generic-class.ts": `export class Box<T> {
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  getValue(): T {
    return this.value;
  }

  setValue(value: T): void {
    this.value = value;
  }

  map<U>(fn: (value: T) => U): Box<U> {
    return new Box(fn(this.value));
  }
}`,
  "typescript/nested-structures.ts": `export class FileProcessor {
  private config: ProcessorConfig;

  constructor(config: ProcessorConfig) {
    this.config = config;
  }

  process(files: string[]): ProcessedFile[] {
    return files.map(file => this.processFile(file));
  }

  private processFile(filename: string): ProcessedFile {
    return {
      filename,
      processed: true,
      timestamp: Date.now()
    };
  }
}

interface ProcessorConfig {
  outputDir: string;
  format: 'json' | 'yaml';
}`,
  "typescript/decorated-class.ts": `@Injectable()
export class UserRepository {
  private users: Map<string, User> = new Map();

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async create(user: User): Promise<void> {
    this.users.set(user.id, user);
  }
}`,
  "typescript/large-service.ts": `export class ApplicationService {
  private initialized = false;
  private config: AppConfig;
  private logger: Logger;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger("ApplicationService");
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.setupDatabase();
    await this.setupAuthentication();
    await this.setupRoutes();

    this.initialized = true;
    this.logger.info("Application initialized");
  }

  private async setupDatabase(): Promise<void> {
    // Database setup logic
  }

  private async setupAuthentication(): Promise<void> {
    // Auth setup logic
  }

  private async setupRoutes(): Promise<void> {
    // Route setup logic
  }
}`,
  "typescript/commented-service.ts": `/**
 * User management service
 * Handles CRUD operations for users
 */
export class UserService {
  private users: User[] = [];

  /**
   * Retrieves a user by ID
   * @param id - The user ID
   * @returns The user or null if not found
   */
  async getUser(id: string): Promise<User | null> {
    return this.users.find(user => user.id === id) || null;
  }

  /**
   * Creates a new user
   * @param userData - The user data
   * @returns The created user
   */
  async createUser(userData: CreateUserData): Promise<User> {
    const user = { ...userData, id: generateId() };
    this.users.push(user);
    return user;
  }
}`,
};

beforeAll(async () => {
  try {
    // Load the real config from environment (but don't set it globally)
    const factory = new CustomConfigFactory();
    const provider = await factory.createProvider({ workingDirectory: process.cwd() });
    loadedConfig = provider.getConfig();

    const morph = loadedConfig.ai?.providers?.morph as any;

    const baseUrl = morph?.baseURL || morph?.baseUrl;
    const apiKey = morph?.apiKey;

    testConfig = {
      hasValidMorphConfig: Boolean(morph?.enabled && baseUrl && apiKey),
      morphBaseUrl: baseUrl,
      morphApiKey: apiKey,
    };

    if (!testConfig.hasValidMorphConfig) {
      console.log("⚠️  Morph not configured - integration tests will be skipped");
      console.log("   To run these tests, configure Morph in your config:");
      console.log("   minsky config set ai.providers.morph.baseURL https://api.morphllm.com/v1");
      console.log("   minsky config set ai.providers.morph.apiKey your-api-key");
    } else {
      console.log(`✅ Morph configured via config system: ${baseUrl}`);
    }
  } catch (error) {
    console.error("Failed to load configuration:", error);
    testConfig = { hasValidMorphConfig: false };
  }
});

beforeEach(() => {
  // Create isolated mock filesystem for each test
  mockFs = createMockFilesystem(mockFixtures);

  // Mock filesystem operations to prevent real file access
  mock.module("fs/promises", () => ({
    readFile: mockFs.readFile,
    writeFile: mockFs.writeFile,
    stat: mockFs.stat,
    mkdir: mockFs.mkdir,
    rm: mockFs.rm,
    access: mockFs.access,
  }));

  mock.module("fs", () => ({
    existsSync: mockFs.existsSync,
    readFileSync: mockFs.readFileSync,
    writeFileSync: mockFs.writeFileSync,
    mkdirSync: mockFs.mkdirSync,
    promises: {
      readFile: mockFs.readFile,
      writeFile: mockFs.writeFile,
      stat: mockFs.stat,
      mkdir: mockFs.mkdir,
      rm: mockFs.rm,
      access: mockFs.access,
    },
  }));
});

// Helper function to load fixtures from mock filesystem
async function loadFixture(relPath: string): Promise<string> {
  return mockFixtures[relPath] || "";
}

describe.if(process.env.RUN_INTEGRATION_TESTS)("Session Edit File Integration Tests", () => {
  describe("Core Edit Patterns", () => {
    coreTestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          { config: loadedConfig }
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 1: Core TypeScript Patterns", () => {
    phase1TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          { config: loadedConfig }
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 2: Advanced Patterns", () => {
    phase2TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          { config: loadedConfig }
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 3: Complex Scenarios", () => {
    phase3TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          { config: loadedConfig }
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });
});
