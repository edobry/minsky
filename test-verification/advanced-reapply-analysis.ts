/**
 * Advanced Reapply Tool Behavior Analysis
 *
 * This file is designed to test advanced patterns and edge cases for Cursor's reapply tool
 * to understand its sophisticated model behavior and recovery capabilities.
 */

export class AdvancedTestClass {
  private data: Map<string, unknown>;
  private config: Record<string, any>;
  private isInitialized: boolean = false;

  constructor(initialData?: Record<string, unknown>) {
    this.data = new Map();
    this.config = {};

    if (initialData) {
      Object.entries(initialData).forEach(([key, value]) => {
        this.data.set(key, value);
      });
    }
  }

  // Method with complex logic for testing reapply's pattern recognition
  async processComplexOperation(
    input: string,
    options: {
      retries?: number;
      timeout?: number;
      validateInput?: boolean;
      transformOutput?: boolean;
    } = {}
  ): Promise<{ result: string; metadata: Record<string, any> }> {
    const { retries = 3, timeout = 5000, validateInput = true, transformOutput = false } = options;

    // Enhanced input validation with detailed error messages
    if (validateInput) {
      if (!input) {
        throw new Error("Input validation failed: input is null or undefined");
      }
      if (typeof input !== "string") {
        throw new Error("Input validation failed: input must be a string");
      }
      if (input.trim().length === 0) {
        throw new Error("Input validation failed: input cannot be empty or whitespace-only");
      }
      if (input.length > 10000) {
        throw new Error(
          "Input validation failed: input exceeds maximum length of 10,000 characters"
        );
      }
    }

    // Complex processing logic that might be partially edited
    let processedInput = input.trim();

    // Add timeout handling
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Operation timed out after ${timeout}ms`)), timeout);
    });

    const processingPromise = new Promise(async (resolve) => {
      // Transformation step 1
      if (processedInput.includes("special")) {
        processedInput = processedInput.replace(/special/g, "PROCESSED");
      }

      // TODO: Add more processing steps here

      resolve(processedInput);
    });

    // Race between processing and timeout
    processedInput = await Promise.race([processingPromise, timeoutPromise]);

    // Transformation step 2
    const metadata: Record<string, any> = {
      originalLength: input.length,
      processedLength: processedInput.length,
      timestamp: new Date().toISOString(),
      retries,
      timeout,
    };

    // Conditional logic for reapply testing
    if (transformOutput) {
      processedInput = processedInput.toUpperCase();
      metadata.transformed = true;
    }

    return {
      result: processedInput,
      metadata,
    };
  }

  // Method with nested conditions for testing reapply's understanding
  public configureSettings(settings: {
    enableFeatureA?: boolean;
    enableFeatureB?: boolean;
    maxConnections?: number;
    debugMode?: boolean;
    customHandlers?: Record<string, Function>;
  }): void {
    // Feature A configuration
    if (settings.enableFeatureA) {
      this.config.featureA = {
        enabled: true,
        lastUpdated: Date.now(),
      };
    }

    // Feature B configuration
    if (settings.enableFeatureB) {
      this.config.featureB = {
        enabled: true,
        dependencies: ["featureA"],
        lastUpdated: Date.now(),
      };
    }

    // Connection limits
    if (settings.maxConnections && settings.maxConnections > 0) {
      this.config.connectionPool = {
        max: settings.maxConnections,
        current: 0,
        queue: [],
      };
    }

    // Debug configuration
    if (settings.debugMode) {
      this.config.debug = {
        enabled: true,
        level: "verbose",
        logToConsole: true,
        logToFile: false,
      };
    }

    // Custom handlers
    if (settings.customHandlers) {
      this.config.handlers = { ...settings.customHandlers };
    }

    this.isInitialized = true;
  }

  // Method with error handling for reapply testing
  async handleDataOperation(
    operation: "create" | "read" | "update" | "delete",
    key: string,
    value?: unknown
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    try {
      switch (operation) {
        case "create":
          if (this.data.has(key)) {
            return { success: false, error: `Key '${key}' already exists` };
          }
          this.data.set(key, value);
          return { success: true, data: value };

        case "read":
          if (!this.data.has(key)) {
            return { success: false, error: `Key '${key}' not found` };
          }
          return { success: true, data: this.data.get(key) };

        case "update":
          if (!this.data.has(key)) {
            return { success: false, error: `Key '${key}' not found for update` };
          }
          this.data.set(key, value);
          return { success: true, data: value };

        case "delete":
          if (!this.data.has(key)) {
            return { success: false, error: `Key '${key}' not found for deletion` };
          }
          const deletedValue = this.data.get(key);
          this.data.delete(key);
          return { success: true, data: deletedValue };

        default:
          return { success: false, error: `Unknown operation: ${operation}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Getter with complex logic
  get diagnostics(): Record<string, any> {
    return {
      isInitialized: this.isInitialized,
      dataSize: this.data.size,
      configKeys: Object.keys(this.config),
      memoryUsage: {
        dataEntries: this.data.size,
        configSize: Object.keys(this.config).length,
      },
      status: this.isInitialized ? "ready" : "not-initialized",
    };
  }

  // Method with async/await complexity
  async batchProcess(
    items: Array<{ id: string; data: unknown }>,
    batchSize: number = 10
  ): Promise<Array<{ id: string; success: boolean; result?: unknown; error?: string }>> {
    const results: Array<{ id: string; success: boolean; result?: unknown; error?: string }> = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const batchPromises = batch.map(async (item) => {
        try {
          // Simulate processing delay
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Process the item
          const processed = await this.processComplexOperation(String(item.data), {
            validateInput: true,
            transformOutput: true,
          });

          return {
            id: item.id,
            success: true,
            result: processed,
          };
        } catch (error) {
          return {
            id: item.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}

// Complex function for testing reapply's function-level understanding
export async function complexAsyncFunction(input: {
  data: Record<string, unknown>;
  options: {
    strict?: boolean;
    timeout?: number;
    retries?: number;
  };
  callbacks?: {
    onSuccess?: (result: any) => void;
    onError?: (error: Error) => void;
    onProgress?: (progress: number) => void;
  };
}): Promise<{
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  metrics?: {
    processingTime: number;
    itemsProcessed: number;
    errorsEncountered: number;
  };
}> {
  const startTime = Date.now();
  let itemsProcessed = 0;
  let errorsEncountered = 0;

  try {
    const { data, options = {}, callbacks } = input;
    const { strict = false, timeout = 30000, retries = 1 } = options;

    // Validation phase
    if (strict && (!data || Object.keys(data).length === 0)) {
      throw new Error("Strict mode: data cannot be empty");
    }

    // Processing phase
    const processedData: Record<string, unknown> = {};
    const entries = Object.entries(data);

    for (const [key, value] of entries) {
      try {
        // Progress callback
        if (callbacks?.onProgress) {
          const progress = (itemsProcessed / entries.length) * 100;
          callbacks.onProgress(progress);
        }

        // Process individual item with retries
        let processedValue = value;
        let attempts = 0;

        while (attempts < retries) {
          try {
            // Simulate processing
            if (typeof value === "string") {
              processedValue = value.toUpperCase().trim();
            } else if (typeof value === "number") {
              processedValue = value * 2;
            } else if (Array.isArray(value)) {
              processedValue = value.map((item) => String(item).toUpperCase());
            } else {
              processedValue = JSON.parse(JSON.stringify(value));
            }
            break;
          } catch (error) {
            attempts++;
            if (attempts >= retries) {
              throw error;
            }
            // Wait before retry
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        processedData[key] = processedValue;
        itemsProcessed++;
      } catch (error) {
        errorsEncountered++;
        if (strict) {
          throw new Error(`Processing failed for key '${key}': ${error}`);
        }
        // In non-strict mode, skip failed items
        console.warn(`Skipping failed item '${key}':`, error);
      }
    }

    const metrics = {
      processingTime: Date.now() - startTime,
      itemsProcessed,
      errorsEncountered,
    };

    // Success callback
    if (callbacks?.onSuccess) {
      callbacks.onSuccess({ result: processedData, metrics });
    }

    return {
      success: true,
      result: processedData,
      metrics,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Error callback
    if (input.callbacks?.onError && error instanceof Error) {
      input.callbacks.onError(error);
    }

    return {
      success: false,
      error: errorMessage,
      metrics: {
        processingTime: Date.now() - startTime,
        itemsProcessed,
        errorsEncountered: errorsEncountered + 1,
      },
    };
  }
}

// Export for testing
export const testConfiguration = {
  defaultBatchSize: 10,
  maxRetries: 3,
  defaultTimeout: 5000,
  supportedOperations: ["create", "read", "update", "delete"] as const,
  featureFlags: {
    enableAdvancedProcessing: true,
    enableBatchOperations: true,
    enableStrictValidation: false,
  },
};
