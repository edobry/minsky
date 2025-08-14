import { EventEmitter } from "events";
import { Logger } from "./logger";

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export class UserService extends EventEmitter {
  private users: Map<string, User> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  async createUser(userData: Omit<User, "id" | "createdAt">): Promise<User> {
    const user: User = {
      id: this.generateId(),
      ...userData,
      createdAt: new Date(),
    };

    this.users.set(user.id, user);
    this.logger.info(`Created user: ${user.id}`);
    this.emit("userCreated", user);

    return user;
  }

  async getUser(id: string): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) {
      this.logger.warn(`User not found: ${id}`);
      return null;
    }
    return user;
  }

  async updateUser(
    id: string,
    updates: Partial<Omit<User, "id" | "createdAt">>
  ): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) {
      this.logger.warn(`Cannot update non-existent user: ${id}`);
      return null;
    }

    const updatedUser = { ...user, ...updates };
    this.users.set(id, updatedUser);
    this.logger.info(`Updated user: ${id}`);
    this.emit("userUpdated", updatedUser);

    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    const deleted = this.users.delete(id);
    if (deleted) {
      this.logger.info(`Deleted user: ${id}`);
      this.emit("userDeleted", id);
    } else {
      this.logger.warn(`Cannot delete non-existent user: ${id}`);
    }
    return deleted;
  }

  async listUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }
}
