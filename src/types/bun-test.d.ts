declare module "bun:test" {
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: jest.Expect;
  export const mock: {
    fn: <T extends (...args: any[]) => any>(implementation?: T) => jest.Mock<T>;
    module: (path: string, factory: () => any) => void;
    restoreAll: () => void;
  };
  export const beforeEach: (fn: () => void | Promise<void>) => void;
  export const afterEach: (fn: () => void | Promise<void>) => void;
  export type Mock<T> = jest.Mock<T>;
}

declare namespace jest {
  interface Expect {
    <T = any>(actual: T): jest.Matchers<T>;
    stringContaining(expected: string): any;
    any(constructor: any): any;
  }
  
  interface Matchers<R> {
    toHaveBeenCalled(): R;
    toHaveBeenCalledWith(...args: any[]): R;
    toBe(expected: any): R;
    toEqual(expected: any): R;
    toContain(expected: any): R;
    toMatch(expected: string | RegExp): R;
    not: Matchers<R>;
  }
  
  interface Mock<T = any> {
    (...args: Parameters<T>): ReturnType<T>;
    mockResolvedValue(value: any): void;
    mockImplementation(fn: (...args: any[]) => any): void;
    mockReturnValue(value: any): void;
    mockReset(): void;
  }
  
  type Mocked<T> = {
    [P in keyof T]: T[P] extends (...args: any[]) => any
      ? Mock<T[P]>
      : T[P];
  };
} 
