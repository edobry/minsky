// Cursor Behavior Analysis Test File
// This file is designed to test various Cursor built-in tools systematically
// DO NOT MODIFY THIS FILE DURING TESTING - use copies for destructive tests

import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

/**
 * Sample class for testing code navigation and search functionality
 */
export class DatabaseConnection {
  private connectionString: string;
  private isConnected: boolean = false;
  private retryCount: number = 0;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  /**
   * Connects to the database with retry logic
   * @param maxRetries Maximum number of retry attempts
   * @returns Promise<boolean> indicating success
   */
  async connect(maxRetries: number = 3): Promise<boolean> {
    try {
      // Simulate connection logic
      const result = await this.performConnection();
      this.isConnected = true;
      return true;
    } catch (error) {
      this.retryCount++;
      if (this.retryCount < maxRetries) {
        console.log(`Connection failed, retrying... (${this.retryCount}/${maxRetries})`);
        return this.connect(maxRetries);
      }
      throw new Error(`Failed to connect after ${maxRetries} attempts: ${error}`);
    }
  }

  private async performConnection(): Promise<void> {
    // Simulate connection delay
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Simulate random connection failure
    if (Math.random() < 0.3) {
      throw new Error("Connection timeout");
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.retryCount = 0;
  }

  // Method with multiple parameters for testing search patterns
  async query(
    sql: string,
    params: unknown[] = [],
    options: {
      timeout?: number;
      retries?: number;
      logQuery?: boolean;
    } = {}
  ): Promise<unknown[]> {
    if (!this.isConnected) {
      throw new Error("Database not connected");
    }

    const { timeout = 5000, retries = 1, logQuery = false } = options;

    if (logQuery) {
      console.log("Executing query:", sql, "with params:", params);
    }

    // Simulate query execution
    return [];
  }
}

// Utility functions for testing different patterns
export const utilities = {
  // Function with complex parameter patterns
  processData: async (
    data: string | Buffer,
    options: {
      encoding?: "utf8" | "ascii" | "base64";
      transform?: (input: string) => string;
      validate?: boolean;
    } = {}
  ): Promise<string> => {
    const { encoding = "utf8", transform, validate = true } = options;

    let processed = typeof data === "string" ? data : data.toString();

    if (transform) {
      processed = transform(processed);
    }

    if (validate && processed.length === 0) {
      throw new Error("Processed data is empty");
    }

    return processed;
  },

  // Function for testing search with special characters
  escapeRegex: (input: string): string => {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  // Function with template literals for testing
  buildQuery: (
    table: string,
    fields: string[],
    conditions: Record<string, unknown> = {}
  ): string => {
    const fieldList = fields.join(", ");
    const whereClause = Object.entries(conditions)
      .map(([key, value]) => `${key} = '${value}'`)
      .join(" AND ");

    return `SELECT ${fieldList} FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ""}`;
  },
};

// Constants for testing constant search patterns
export const CONFIG = {
  DATABASE_URL: "postgresql://localhost:5432/testdb",
  MAX_CONNECTIONS: 10,
  TIMEOUT_MS: 30000,
  RETRY_INTERVALS: [1000, 2000, 5000],
  ERROR_MESSAGES: {
    CONNECTION_FAILED: "Failed to establish database connection",
    QUERY_TIMEOUT: "Query execution timed out",
    INVALID_PARAMS: "Invalid query parameters provided",
  },
} as const;

// Type definitions for testing type-based searches
export interface ApiResponse<T = unknown> {
  data: T;
  status: "success" | "error";
  message?: string;
  timestamp: Date;
}

export type QueryOptions = {
  limit?: number;
  offset?: number;
  orderBy?: string;
  direction?: "ASC" | "DESC";
};

// Class with inheritance for testing complex searches
export abstract class BaseService {
  protected abstract serviceName: string;

  protected log(message: string): void {
    console.log(`[${this.serviceName}] ${message}`);
  }

  abstract initialize(): Promise<void>;
}

export class UserService extends BaseService {
  protected serviceName = "UserService";

  async initialize(): Promise<void> {
    this.log("Initializing user service...");
    // Implementation here
  }

  async findUser(id: string): Promise<ApiResponse<{ id: string; name: string }>> {
    this.log(`Finding user with ID: ${id}`);
    return {
      data: { id, name: "Test User" },
      status: "success",
      timestamp: new Date(),
    };
  }
}

// Error classes for testing error-related searches
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code: string,
    public severity: "low" | "medium" | "high" = "medium"
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: unknown
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// Complex nested object for testing deep searches
export const complexConfig = {
  database: {
    primary: {
      host: "localhost",
      port: 5432,
      credentials: {
        username: "admin",
        password: "secret123",
      },
    },
    replica: {
      host: "192.168.1.100",
      port: 5432,
      credentials: {
        username: "readonly",
        password: "readonly123",
      },
    },
  },
  api: {
    endpoints: {
      users: "/api/v1/users",
      posts: "/api/v1/posts",
      auth: "/api/v1/auth",
    },
    middleware: ["cors", "helmet", "compression"],
    rateLimit: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
    },
  },
};

// Function with various comment styles for testing
export function complexFunction(
  // Single line comment parameter
  param1: string,
  /* Multi-line comment parameter */
  param2: number,
  /**
   * JSDoc comment parameter
   * @param param3 - Description of param3
   */
  param3?: boolean
): Promise<string> {
  // TODO: Implement error handling
  /* FIXME: This needs optimization */
  /**
   * NOTE: This function is for testing purposes only
   */

  return Promise.resolve(`${param1}-${param2}-${param3}`);
}

// Edge case patterns for comprehensive testing
export const edgeCases = {
  // Patterns with special regex characters
  regexChars: ".*+?^${}()|[]\\",

  // Unicode and special characters
  unicode: "🚀 emoji test αβγ δεζ ηθι",

  // Long lines for testing line-based operations
  longLine:
    "This is a very long line that might cause issues with certain text processing operations and should be used to test how tools handle extremely long content that spans way beyond normal line lengths and might cause buffer overflows or memory issues in poorly implemented tools",

  // Nested quotes and escapes
  nestedQuotes: "He said \"She said 'This is a test' to me\" yesterday",

  // Tab and whitespace patterns
  mixedWhitespace: "\t\t  \t   \t\t",

  // Empty and null-like values
  emptyValues: ["", null, undefined, 0, false, []],

  // Boundary values
  boundaries: {
    maxInt: Number.MAX_SAFE_INTEGER,
    minInt: Number.MIN_SAFE_INTEGER,
    maxFloat: Number.MAX_VALUE,
    minFloat: Number.MIN_VALUE,
  },
};

// Export all for testing
// export * from "./other-test-file"; // This will cause an import error intentionally - commented out to avoid linter errors
