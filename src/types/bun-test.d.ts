declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => Promise<void> | void): void;
  export function expect<T>(value: T): {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toContain(expected: any): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledWith(...args: any[]): void;
    not: {
      toBe(expected: any): void;
      toBeNull(): void;
      toEqual(expected: any): void;
      toContain(expected: any): void;
      toBeDefined(): void;
      toBeUndefined(): void;
    };
    rejects: {
      toThrow(message?: string): Promise<void>;
    };
  };
  export function beforeEach(fn: () => Promise<void> | void): void;
  export function afterEach(fn: () => Promise<void> | void): void;
  export function beforeAll(fn: () => Promise<void> | void): void;
  export function afterAll(fn: () => Promise<void> | void): void;
  export function mock<T extends (...args: any[]) => any>(
    implementation?: T
  ): jest.Mock<ReturnType<T>, Parameters<T>>;
  
  export namespace mock {
    function module(moduleName: string, factory: () => any): void;
    function restoreAll(): void;
  }
  
  namespace jest {
    interface Mock<T = any, Y extends any[] = any[]> {
      (...args: Y): T;
      getMockName(): string;
      mock: {
        calls: Y[];
        instances: T[];
        invocationCallOrder: number[];
        results: { type: string; value: T }[];
      };
      mockClear(): this;
      mockReset(): this;
      mockRestore(): void;
      mockImplementation(fn: (...args: Y) => T): this;
      mockImplementationOnce(fn: (...args: Y) => T): this;
      mockName(name: string): this;
      mockReturnThis(): this;
      mockReturnValue(value: T): this;
      mockReturnValueOnce(value: T): this;
    }
  }
} 
