import { Logger } from "./logger"; // Assume this exists for context

interface User {
  id: string;
  name: string;
  email: string;
}

interface UserServiceConfig {
  apiUrl: string;
  timeout: number;
}

export class UserService {
  private users: User[] = [];

  constructor(private readonly logger: Logger) {}

  getUserById(id: string): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  addUser(user: User): void {
    this.users.push(user);
  }
}
