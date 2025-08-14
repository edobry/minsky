export class Outer {
  innerMethod() {
    return 1;
  }
}

export class DatabaseManager {
  private connections: Map<string, Connection> = new Map();

  private Connection = class {
    constructor(private readonly connectionString: string) {}

    async query<T>(sql: string, params?: any[]): Promise<T[]> {
      // Simulate database query
      return [];
    }

    async close(): Promise<void> {
      // Close connection
    }
  };

  async getConnection(name: string): Promise<Connection> {
    if (!this.connections.has(name)) {
      const connection = new this.Connection(`db://${name}`);
      this.connections.set(name, connection);
    }
    return this.connections.get(name)!;
  }

  private validateConnectionName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error("Connection name cannot be empty");
    }
  }
}
