export class MathUtils {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  private validateNumber(value: number): void {
    if (typeof value !== "number" || isNaN(value)) {
      throw new Error("Invalid number");
    }
  }
}
