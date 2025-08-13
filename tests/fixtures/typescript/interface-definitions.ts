export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserService {
  findUser(id: string): Promise<User | null>;
  createUser(userData: Partial<User>): Promise<User>;
}

export type UserRole = "admin" | "user" | "guest";

export interface AdminUser extends User {
  role: "admin";
  permissions: string[];
}
