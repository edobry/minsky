export class UserService {
  private users: User[] = [];

  constructor(private readonly logger: Logger) {}

  async findUser(id: string): Promise<User | null> {
    this.logger.debug(`Finding user: ${id}`);
    return this.users.find((user) => user.id === id) || null;
  }
}
