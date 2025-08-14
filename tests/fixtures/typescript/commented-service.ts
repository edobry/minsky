/**
 * A service with rich comments and documentation to test comment preservation.
 */
export class CommentedService {
  /**
   * Creates the service
   */
  constructor() {}

  /**
   * Validates email format
   *
   * @param email - The email to validate
   * @returns true if valid
   */
  isValidEmail(email: string): boolean {
    return /.+@.+\..+/.test(email);
  }
}

/**
 * UserService handles all user-related operations
 *
 * @class UserService
 * @author Development Team
 * @version 1.0.0
 */
export class UserService {
  private users: User[] = [];

  /**
   * Creates a new user
   *
   * @param userData - The user data to create
   * @returns Promise resolving to the created user
   * @throws {ValidationError} When user data is invalid
   */
  async createUser(userData: CreateUserData): Promise<User> {
    // Validate user data
    this.validateUserData(userData);

    // Create new user instance
    const user = new User(userData);

    // Save to database
    this.users.push(user);

    return user;
  }

  /**
   * Validates user data before creation
   *
   * @private
   * @param userData - The user data to validate
   * @throws {ValidationError} When validation fails
   */
  private validateUserData(userData: CreateUserData): void {
    if (!userData.email || !userData.name) {
      throw new ValidationError("Email and name are required");
    }
  }
}
