/**
 * Large service file for testing edit operations on substantial codebases
 * This file is intentionally large to test performance and reliability
 */
import { Logger } from "./logger";
import { Database } from "./database";
import { Validator } from "./validator";
import { EmailService } from "./email-service";
import { CacheService } from "./cache-service";
import { MetricsService } from "./metrics-service";

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  lastLogin?: Date;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: "light" | "dark";
  language: string;
  notifications: {
    email: boolean;
    push: boolean;
    sms: boolean;
  };
  privacy: {
    profileVisible: boolean;
    emailVisible: boolean;
    lastSeenVisible: boolean;
  };
}

export interface CreateUserData {
  email: string;
  name: string;
  password: string;
  preferences?: Partial<UserPreferences>;
}

export interface UpdateUserData {
  name?: string;
  email?: string;
  preferences?: Partial<UserPreferences>;
  isActive?: boolean;
}

export interface UserFilters {
  isActive?: boolean;
  createdAfter?: Date;
  createdBefore?: Date;
  lastLoginAfter?: Date;
  emailDomain?: string;
  theme?: "light" | "dark";
}

export interface PaginationOptions {
  page: number;
  limit: number;
  sortBy?: keyof User;
  sortOrder?: "asc" | "desc";
}

export interface UserListResult {
  users: User[];
  total: number;
  page: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * Comprehensive user management service
 * Handles all user-related operations with proper error handling,
 * caching, metrics, and logging
 */
export class UserManagementService {
  private readonly logger: Logger;
  private readonly database: Database;
  private readonly validator: Validator;
  private readonly emailService: EmailService;
  private readonly cacheService: CacheService;
  private readonly metricsService: MetricsService;

  private readonly defaultUserPreferences: UserPreferences = {
    theme: "light",
    language: "en",
    notifications: {
      email: true,
      push: true,
      sms: false,
    },
    privacy: {
      profileVisible: true,
      emailVisible: false,
      lastSeenVisible: true,
    },
  };

  constructor(
    logger: Logger,
    database: Database,
    validator: Validator,
    emailService: EmailService,
    cacheService: CacheService,
    metricsService: MetricsService
  ) {
    this.logger = logger;
    this.database = database;
    this.validator = validator;
    this.emailService = emailService;
    this.cacheService = cacheService;
    this.metricsService = metricsService;
  }

  /**
   * Creates a new user with comprehensive validation and setup
   */
  async createUser(userData: CreateUserData): Promise<User> {
    const startTime = Date.now();
    this.logger.info("Creating new user", { email: userData.email });

    try {
      // Validate input data
      await this.validateCreateUserData(userData);

      // Check if user already exists
      const existingUser = await this.findUserByEmail(userData.email);
      if (existingUser) {
        throw new Error(`User with email ${userData.email} already exists`);
      }

      // Create user object
      const user: User = {
        id: this.generateUserId(),
        email: userData.email,
        name: userData.name,
        createdAt: new Date(),
        updatedAt: new Date(),
        isActive: true,
        preferences: {
          ...this.defaultUserPreferences,
          ...userData.preferences,
        },
      };

      // Save to database
      await this.database.users.create(user);

      // Clear cache
      await this.invalidateUserCaches(user.email);

      // Send welcome email
      await this.emailService.sendWelcomeEmail(user);

      // Record metrics
      this.metricsService.increment("user.created");
      this.metricsService.timing("user.create.duration", Date.now() - startTime);

      this.logger.info("User created successfully", { userId: user.id, email: user.email });
      return user;
    } catch (error) {
      this.logger.error("Failed to create user", {
        email: userData.email,
        error: error.message,
      });
      this.metricsService.increment("user.create.error");
      throw error;
    }
  }

  /**
   * Retrieves a user by ID with caching
   */
  async getUserById(id: string): Promise<User | null> {
    this.logger.debug("Retrieving user by ID", { userId: id });

    try {
      // Check cache first
      const cacheKey = `user:${id}`;
      const cachedUser = await this.cacheService.get<User>(cacheKey);
      if (cachedUser) {
        this.metricsService.increment("user.cache.hit");
        return cachedUser;
      }

      // Fetch from database
      const user = await this.database.users.findById(id);
      if (user) {
        // Cache the result
        await this.cacheService.set(cacheKey, user, 300); // 5 minutes
        this.metricsService.increment("user.cache.miss");
      }

      return user;
    } catch (error) {
      this.logger.error("Failed to retrieve user by ID", { userId: id, error: error.message });
      this.metricsService.increment("user.get.error");
      throw error;
    }
  }

  /**
   * Retrieves a user by email
   */
  async findUserByEmail(email: string): Promise<User | null> {
    this.logger.debug("Finding user by email", { email });

    try {
      const user = await this.database.users.findByEmail(email);
      return user;
    } catch (error) {
      this.logger.error("Failed to find user by email", { email, error: error.message });
      throw error;
    }
  }

  /**
   * Updates an existing user
   */
  async updateUser(id: string, updateData: UpdateUserData): Promise<User> {
    const startTime = Date.now();
    this.logger.info("Updating user", { userId: id, updateData });

    try {
      // Validate update data
      await this.validateUpdateUserData(updateData);

      // Get existing user
      const existingUser = await this.getUserById(id);
      if (!existingUser) {
        throw new Error(`User with ID ${id} not found`);
      }

      // Check email uniqueness if email is being updated
      if (updateData.email && updateData.email !== existingUser.email) {
        const userWithNewEmail = await this.findUserByEmail(updateData.email);
        if (userWithNewEmail) {
          throw new Error(`User with email ${updateData.email} already exists`);
        }
      }

      // Create updated user object
      const updatedUser: User = {
        ...existingUser,
        ...updateData,
        updatedAt: new Date(),
        preferences: updateData.preferences
          ? { ...existingUser.preferences, ...updateData.preferences }
          : existingUser.preferences,
      };

      // Save to database
      await this.database.users.update(id, updatedUser);

      // Clear caches
      await this.invalidateUserCaches(existingUser.email);
      if (updateData.email && updateData.email !== existingUser.email) {
        await this.invalidateUserCaches(updateData.email);
      }

      // Record metrics
      this.metricsService.increment("user.updated");
      this.metricsService.timing("user.update.duration", Date.now() - startTime);

      this.logger.info("User updated successfully", { userId: id });
      return updatedUser;
    } catch (error) {
      this.logger.error("Failed to update user", { userId: id, error: error.message });
      this.metricsService.increment("user.update.error");
      throw error;
    }
  }

  /**
   * Deletes a user (soft delete)
   */
  async deleteUser(id: string): Promise<void> {
    this.logger.info("Deleting user", { userId: id });

    try {
      const user = await this.getUserById(id);
      if (!user) {
        throw new Error(`User with ID ${id} not found`);
      }

      // Soft delete by setting isActive to false
      await this.updateUser(id, { isActive: false });

      // Clear cache
      await this.invalidateUserCaches(user.email);

      // Record metrics
      this.metricsService.increment("user.deleted");

      this.logger.info("User deleted successfully", { userId: id });
    } catch (error) {
      this.logger.error("Failed to delete user", { userId: id, error: error.message });
      this.metricsService.increment("user.delete.error");
      throw error;
    }
  }

  /**
   * Lists users with filtering and pagination
   */
  async listUsers(
    filters: UserFilters = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<UserListResult> {
    this.logger.debug("Listing users", { filters, pagination });

    try {
      const { users, total } = await this.database.users.findMany(filters, pagination);

      const totalPages = Math.ceil(total / pagination.limit);
      const hasNext = pagination.page < totalPages;
      const hasPrevious = pagination.page > 1;

      this.metricsService.increment("user.list");

      return {
        users,
        total,
        page: pagination.page,
        totalPages,
        hasNext,
        hasPrevious,
      };
    } catch (error) {
      this.logger.error("Failed to list users", { error: error.message });
      this.metricsService.increment("user.list.error");
      throw error;
    }
  }

  /**
   * Records user login
   */
  async recordLogin(userId: string): Promise<void> {
    this.logger.debug("Recording user login", { userId });

    try {
      await this.updateUser(userId, { lastLogin: new Date() });
      this.metricsService.increment("user.login");
    } catch (error) {
      this.logger.error("Failed to record login", { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Gets user statistics
   */
  async getUserStatistics(): Promise<{
    total: number;
    active: number;
    inactive: number;
    recentLogins: number;
  }> {
    try {
      const stats = await this.database.users.getStatistics();
      this.metricsService.increment("user.stats.requested");
      return stats;
    } catch (error) {
      this.logger.error("Failed to get user statistics", { error: error.message });
      throw error;
    }
  }

  /**
   * Validates create user data
   */
  private async validateCreateUserData(userData: CreateUserData): Promise<void> {
    if (!userData.email || !userData.name || !userData.password) {
      throw new Error("Email, name, and password are required");
    }

    if (!this.validator.isEmail(userData.email)) {
      throw new Error("Invalid email format");
    }

    if (userData.name.length < 2) {
      throw new Error("Name must be at least 2 characters long");
    }

    if (userData.password.length < 8) {
      throw new Error("Password must be at least 8 characters long");
    }
  }

  /**
   * Validates update user data
   */
  private async validateUpdateUserData(updateData: UpdateUserData): Promise<void> {
    if (updateData.email && !this.validator.isEmail(updateData.email)) {
      throw new Error("Invalid email format");
    }

    if (updateData.name && updateData.name.length < 2) {
      throw new Error("Name must be at least 2 characters long");
    }
  }

  /**
   * Generates a unique user ID
   */
  private generateUserId(): string {
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Invalidates all caches related to a user
   */
  private async invalidateUserCaches(email: string): Promise<void> {
    try {
      await this.cacheService.delete(`user:email:${email}`);
      await this.cacheService.delete(`user:search:${email}`);
    } catch (error) {
      this.logger.warn("Failed to invalidate user caches", { email, error: error.message });
    }
  }
}
