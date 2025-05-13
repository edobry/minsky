/**
 * Helper function to read from stdin
 */
export async function readFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";

    // Use Node.js process.stdin since Bun.stdin doesn't have .on() method
    process.stdin.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });

    process.stdin.on("end", () => {
      resolve(data);
    });
  });
}
