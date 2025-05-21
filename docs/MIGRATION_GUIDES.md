# Test Migration Guides

This document provides step-by-step guides for migrating tests from Jest/Vitest to Bun. These guides cover common patterns and show before/after examples to make the transition smoother.

## Table of Contents

1. [Introduction](#introduction)
2. [Migration Strategy](#migration-strategy)
3. [Test Suite Setup](#test-suite-setup)
4. [Function Mocking Migration](#function-mocking-migration)
5. [Module Mocking Migration](#module-mocking-migration)
6. [Assertion Pattern Migration](#assertion-pattern-migration)
7. [Test Lifecycle Migration](#test-lifecycle-migration)
8. [Asynchronous Testing Migration](#asynchronous-testing-migration)
9. [Common Pitfalls](#common-pitfalls)
10. [Migration Checklist](#migration-checklist)

## Introduction

Migrating from Jest/Vitest to Bun's test runner brings several benefits:

- **Performance**: Bun's test runner is significantly faster than Jest
- **Simplicity**: Less configuration and setup overhead
- **Modern features**: Better support for ESM and TypeScript
- **Improved architecture**: Moving toward more maintainable Dependency Injection patterns

This guide provides concrete examples and step-by-step instructions for migrating different types of tests.

## Migration Strategy

We recommend a phased approach to migration:

1. **Preparation Phase**:
   - Understand the differences between Jest/Vitest and Bun
   - Identify the patterns used in your test suite
   - Plan the migration approach for each test file

2. **Compatibility Phase**:
   - Use the compatibility layer for tests that are difficult to migrate immediately
   - Make minimal changes to get tests running with Bun

3. **Gradual Migration Phase**:
   - Incrementally migrate tests from using the compatibility layer to native Bun patterns
   - Focus on high-priority tests first
   - Apply dependency injection where appropriate

4. **Optimization Phase**:
   - Remove all uses of the compatibility layer
   - Refactor tests to use Bun's features effectively
   - Apply best practices for performance and maintainability

## Test Suite Setup

### Before (Jest/Vitest)

```typescript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};

// jest.setup.js
jest.setTimeout(10000);
```

```typescript
// Example test file
import { describe, it, expect, beforeEach, afterEach } from 'jest';
import { someFunction } from '../src/module';

describe('Some Module', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should do something', () => {
    const result = someFunction();
    expect(result).toBe(true);
  });
});
```

### After (Bun with Compatibility Layer)

```typescript
// No configuration file needed for Bun tests

// Example test file
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestCompat, jest } from '../utils/test-utils/compatibility';
import { someFunction } from '../src/module';

// Set up Jest compatibility
setupTestCompat();

describe('Some Module', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should do something', () => {
    const result = someFunction();
    expect(result).toBe(true);
  });
});
```

### After (Native Bun)

```typescript
// No configuration file needed for Bun tests

// Example test file
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { someFunction } from '../src/module';

describe('Some Module', () => {
  beforeEach(() => {
    // Use Bun-specific timer mocking if needed
    // For many cases, you might not need timer mocking
  });

  afterEach(() => {
    // Cleanup
  });

  test('should do something', () => {
    const result = someFunction();
    expect(result).toBe(true);
  });
});
```

## Function Mocking Migration

### Before (Jest/Vitest)

```typescript
import { describe, it, expect, jest } from 'jest';
import { processData } from '../src/data-processor';
import { fetchData } from '../src/api';

// Mock the API module
jest.mock('../src/api');

describe('Data Processor', () => {
  it('should process data correctly', async () => {
    // Set up mock implementation
    (fetchData as jest.Mock).mockResolvedValue([
      { id: 1, name: 'Item 1' },
      { id: 2, name: 'Item 2' }
    ]);

    // Call the function being tested
    const result = await processData();

    // Assertions
    expect(fetchData).toHaveBeenCalled();
    expect(result).toEqual([
      { id: 1, name: 'ITEM 1' },
      { id: 2, name: 'ITEM 2' }
    ]);
    
    // Verify mock was called correctly
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(fetchData).toHaveBeenCalledWith({ limit: 10 });
  });
});
```

### After (Bun with Compatibility Layer)

```typescript
import { describe, test, expect } from 'bun:test';
import { setupTestCompat, createCompatMock, jest } from '../utils/test-utils/compatibility';
import { processData } from '../src/data-processor';
import { fetchData } from '../src/api';

// Set up compatibility layer
setupTestCompat();

// Mock the API module
jest.mock('../src/api', () => ({
  fetchData: createCompatMock()
}));

describe('Data Processor', () => {
  test('should process data correctly', async () => {
    // Set up mock implementation
    (fetchData as any).mockResolvedValue([
      { id: 1, name: 'Item 1' },
      { id: 2, name: 'Item 2' }
    ]);

    // Call the function being tested
    const result = await processData();

    // Assertions
    expect(fetchData).toHaveBeenCalled();
    expect(result).toEqual([
      { id: 1, name: 'ITEM 1' },
      { id: 2, name: 'ITEM 2' }
    ]);
    
    // Verify mock was called correctly
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(fetchData).toHaveBeenCalledWith({ limit: 10 });
  });
});
```

### After (Native Bun with Dependency Injection)

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { createDataProcessor } from '../src/data-processor';

describe('Data Processor', () => {
  test('should process data correctly', async () => {
    // Create a mock API
    const mockFetchData = mock(() => Promise.resolve([
      { id: 1, name: 'Item 1' },
      { id: 2, name: 'Item 2' }
    ]));
    
    const api = { fetchData: mockFetchData };
    
    // Use dependency injection to pass the mock
    const processor = createDataProcessor(api);

    // Call the function being tested
    const result = await processor.processData();

    // Assertions
    expect(mockFetchData.mock.calls.length).toBe(1);
    expect(result).toEqual([
      { id: 1, name: 'ITEM 1' },
      { id: 2, name: 'ITEM 2' }
    ]);
    
    // Verify mock was called correctly
    const args = mockFetchData.mock.calls[0] || [];
    expect(args[0]).toEqual({ limit: 10 });
  });
});
```

## Module Mocking Migration

### Before (Jest/Vitest)

```typescript
import { describe, it, expect, jest } from 'jest';
import { sendNotification } from '../src/notifier';

// Mock the entire logger module
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

// Import after mocking
import { log, error } from '../src/logger';

describe('Notifier', () => {
  it('should log notification success', () => {
    // Call the function being tested
    sendNotification('Test message');

    // Verify the logger was called correctly
    expect(log).toHaveBeenCalledWith('Notification sent: Test message');
    expect(error).not.toHaveBeenCalled();
  });

  it('should log notification failure', () => {
    // Call the function with a parameter that triggers an error
    sendNotification('');

    // Verify the error logger was called
    expect(error).toHaveBeenCalledWith('Failed to send notification: Invalid message');
    expect(log).not.toHaveBeenCalled();
  });
});
```

### After (Bun with Compatibility Layer)

```typescript
import { describe, test, expect } from 'bun:test';
import { setupTestCompat, jest } from '../utils/test-utils/compatibility';
import { sendNotification } from '../src/notifier';

// Set up compatibility layer
setupTestCompat();

// Mock the entire logger module
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

// Import after mocking
import { log, error } from '../src/logger';

describe('Notifier', () => {
  test('should log notification success', () => {
    // Call the function being tested
    sendNotification('Test message');

    // Verify the logger was called correctly
    expect(log).toHaveBeenCalledWith('Notification sent: Test message');
    expect(error).not.toHaveBeenCalled();
  });

  test('should log notification failure', () => {
    // Call the function with a parameter that triggers an error
    sendNotification('');

    // Verify the error logger was called
    expect(error).toHaveBeenCalledWith('Failed to send notification: Invalid message');
    expect(log).not.toHaveBeenCalled();
  });
});
```

### After (Native Bun with Dependency Injection)

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { createNotifier } from '../src/notifier';

describe('Notifier', () => {
  test('should log notification success', () => {
    // Create mock logger
    const mockLogger = {
      log: mock(),
      error: mock(),
      warn: mock()
    };
    
    // Create notifier with dependency injection
    const notifier = createNotifier(mockLogger);

    // Call the function being tested
    notifier.sendNotification('Test message');

    // Verify the logger was called correctly
    expect(mockLogger.log.mock.calls.length).toBe(1);
    expect(mockLogger.log.mock.calls[0][0]).toBe('Notification sent: Test message');
    expect(mockLogger.error.mock.calls.length).toBe(0);
  });

  test('should log notification failure', () => {
    // Create mock logger
    const mockLogger = {
      log: mock(),
      error: mock(),
      warn: mock()
    };
    
    // Create notifier with dependency injection
    const notifier = createNotifier(mockLogger);

    // Call the function with a parameter that triggers an error
    notifier.sendNotification('');

    // Verify the error logger was called
    expect(mockLogger.error.mock.calls.length).toBe(1);
    expect(mockLogger.error.mock.calls[0][0]).toBe('Failed to send notification: Invalid message');
    expect(mockLogger.log.mock.calls.length).toBe(0);
  });
});
```

## Assertion Pattern Migration

### Before (Jest/Vitest)

```typescript
import { describe, it, expect } from 'jest';
import { getUserProfile } from '../src/user-service';

describe('User Service', () => {
  it('should return user profile with correct structure', async () => {
    const profile = await getUserProfile(123);
    
    // Using Jest-specific matchers
    expect(profile).toMatchObject({
      id: 123,
      name: expect.any(String),
      email: expect.stringMatching(/@example\.com$/),
      roles: expect.arrayContaining(['user']),
      metadata: expect.objectContaining({
        createdAt: expect.any(Date)
      })
    });
    
    // Other Jest assertions
    expect(profile.name).toBeTruthy();
    expect(profile.roles).toHaveLength(2);
    expect(profile.active).toBe(true);
  });
});
```

### After (Bun with Compatibility Layer)

```typescript
import { describe, test, expect } from 'bun:test';
import { setupTestCompat, asymmetricMatchers } from '../utils/test-utils/compatibility';
import { getUserProfile } from '../src/user-service';

// Set up compatibility layer
setupTestCompat();

describe('User Service', () => {
  test('should return user profile with correct structure', async () => {
    const profile = await getUserProfile(123);
    
    // Using compatibility layer asymmetric matchers
    expect(profile).toEqual({
      id: 123,
      name: asymmetricMatchers.any(String),
      email: asymmetricMatchers.stringMatching(/@example\.com$/),
      roles: asymmetricMatchers.arrayContaining(['user']),
      metadata: asymmetricMatchers.objectContaining({
        createdAt: asymmetricMatchers.any(Date)
      }),
      active: true
    });
    
    // Bun assertions (some of these work the same way)
    expect(profile.name).toBeTruthy();
    expect(profile.roles.length).toBe(2);
    expect(profile.active).toBe(true);
  });
});
```

### After (Native Bun)

```typescript
import { describe, test, expect } from 'bun:test';
import { getUserProfile } from '../src/user-service';

describe('User Service', () => {
  test('should return user profile with correct structure', async () => {
    const profile = await getUserProfile(123);
    
    // Explicit assertions (most robust approach)
    expect(profile.id).toBe(123);
    expect(typeof profile.name).toBe('string');
    expect(profile.email.endsWith('@example.com')).toBe(true);
    expect(profile.roles.includes('user')).toBe(true);
    expect(profile.roles.length).toBe(2);
    expect(profile.metadata.createdAt instanceof Date).toBe(true);
    expect(profile.active).toBe(true);
    
    // Or a more structured approach for complex objects
    const { id, name, email, roles, metadata, active } = profile;
    
    expect(id).toBe(123);
    expect(typeof name).toBe('string');
    expect(email.endsWith('@example.com')).toBe(true);
    expect(roles.includes('user')).toBe(true);
    expect(roles.length).toBe(2);
    expect(metadata.createdAt instanceof Date).toBe(true);
    expect(active).toBe(true);
  });
});
```

## Test Lifecycle Migration

### Before (Jest/Vitest)

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'jest';
import { Database } from '../src/database';
import { UserRepository } from '../src/user-repository';

describe('User Repository', () => {
  let db: Database;
  let repo: UserRepository;
  
  beforeAll(async () => {
    db = new Database();
    await db.connect();
  });
  
  afterAll(async () => {
    await db.disconnect();
  });
  
  beforeEach(async () => {
    await db.clear();
    repo = new UserRepository(db);
    await repo.initialize();
  });
  
  afterEach(async () => {
    await repo.cleanup();
  });
  
  it('should create a user', async () => {
    const user = await repo.createUser({ name: 'Test User', email: 'test@example.com' });
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Test User');
  });
  
  it('should find a user by id', async () => {
    const created = await repo.createUser({ name: 'Find Me', email: 'findme@example.com' });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });
});
```

### After (Bun with Minimal Changes)

```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Database } from '../src/database';
import { UserRepository } from '../src/user-repository';

describe('User Repository', () => {
  let db: Database;
  let repo: UserRepository;
  
  beforeAll(async () => {
    db = new Database();
    await db.connect();
  });
  
  afterAll(async () => {
    await db.disconnect();
  });
  
  beforeEach(async () => {
    await db.clear();
    repo = new UserRepository(db);
    await repo.initialize();
  });
  
  afterEach(async () => {
    await repo.cleanup();
  });
  
  test('should create a user', async () => {
    const user = await repo.createUser({ name: 'Test User', email: 'test@example.com' });
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Test User');
  });
  
  test('should find a user by id', async () => {
    const created = await repo.createUser({ name: 'Find Me', email: 'findme@example.com' });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });
});
```

### After (Bun with Test Context)

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from '../src/database';
import { UserRepository } from '../src/user-repository';

// Define a test context interface for better type safety
interface TestContext {
  db: Database;
  repo: UserRepository;
}

describe('User Repository', () => {
  // Set up shared resources
  beforeAll(async () => {
    const db = new Database();
    await db.connect();
    
    // Return cleanup function
    return async () => {
      await db.disconnect();
    };
  });
  
  // Define test factory with context setup
  const testWithRepo = test.with({
    async beforeEach(ctx: TestContext) {
      // Create and set up context for this test
      ctx.db = new Database();
      await ctx.db.connect();
      await ctx.db.clear();
      
      ctx.repo = new UserRepository(ctx.db);
      await ctx.repo.initialize();
    },
    async afterEach(ctx: TestContext) {
      // Clean up resources after test
      await ctx.repo.cleanup();
      await ctx.db.disconnect();
    }
  });
  
  testWithRepo('should create a user', async ({ repo }) => {
    const user = await repo.createUser({ name: 'Test User', email: 'test@example.com' });
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Test User');
  });
  
  testWithRepo('should find a user by id', async ({ repo }) => {
    const created = await repo.createUser({ name: 'Find Me', email: 'findme@example.com' });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });
});
```

## Asynchronous Testing Migration

### Before (Jest/Vitest)

```typescript
import { describe, it, expect } from 'jest';
import { fetchUserData, processUserData } from '../src/user-service';

describe('User Service', () => {
  it('should fetch user data', async () => {
    const data = await fetchUserData(123);
    expect(data.id).toBe(123);
  });
  
  it('should process user data', () => {
    return processUserData({ id: 123, name: 'Test User' })
      .then(result => {
        expect(result.processed).toBe(true);
      });
  });
  
  it('should handle errors', async () => {
    await expect(fetchUserData(-1)).rejects.toThrow('Invalid user ID');
  });
  
  it('should handle errors with Promise syntax', () => {
    return expect(processUserData({})).rejects.toThrow('Invalid user data');
  });
});
```

### After (Bun with Minimal Changes)

```typescript
import { describe, test, expect } from 'bun:test';
import { fetchUserData, processUserData } from '../src/user-service';

describe('User Service', () => {
  test('should fetch user data', async () => {
    const data = await fetchUserData(123);
    expect(data.id).toBe(123);
  });
  
  test('should process user data', () => {
    return processUserData({ id: 123, name: 'Test User' })
      .then(result => {
        expect(result.processed).toBe(true);
      });
  });
  
  test('should handle errors', async () => {
    try {
      await fetchUserData(-1);
      // If we reach here, the test should fail
      expect(false).toBe(true); // This will fail the test
    } catch (error) {
      expect(error.message).toBe('Invalid user ID');
    }
  });
  
  test('should handle errors with Promise syntax', () => {
    return processUserData({}).then(
      () => {
        // If we reach here, the test should fail
        expect(false).toBe(true); // This will fail the test
      },
      error => {
        expect(error.message).toBe('Invalid user data');
      }
    );
  });
});
```

## Common Pitfalls

### 1. Missing Module Mocks

**Problem**: Module mocks aren't working correctly after migration.

**Solution**: When using the compatibility layer, ensure you're using `jest.mock()` before importing the module you want to mock.

### 2. Async/Await Issues

**Problem**: Test runs before async assertions complete.

**Solution**: Make sure your test function is declared as `async` and that you're using `await` for all async operations.

### 3. Matcher Compatibility

**Problem**: Jest matchers aren't working in Bun.

**Solution**: Use the compatibility layer's asymmetric matchers or refactor to use Bun's built-in matchers.

### 4. Type Issues

**Problem**: TypeScript errors when using mocks.

**Solution**: Use proper type assertions or create type-safe mocks with the compatibility layer's `mockFunction<T>()` utility.

### 5. Timer Mocking

**Problem**: Jest's timer mocks (`useFakeTimers`) don't work in Bun.

**Solution**: Use the compatibility layer's timer mocks or refactor to use more explicit testing approaches.

## Migration Checklist

Use this checklist to ensure you've covered all aspects of migration:

- [ ] Update imports from Jest/Vitest to Bun (`import { describe, test, expect } from 'bun:test'`)
- [ ] Replace `it()` with `test()`
- [ ] Add compatibility layer setup if needed (`setupTestCompat()`)
- [ ] Migrate function mocks (`jest.fn()` → `createCompatMock()` or Bun's `mock()`)
- [ ] Migrate module mocks
- [ ] Update assertions for compatibility
- [ ] Fix asynchronous test patterns
- [ ] Review and update test lifecycle hooks
- [ ] Run tests and fix any runtime issues
- [ ] Consider refactoring to use dependency injection for better testability
- [ ] Remove compatibility layer dependencies where possible 
