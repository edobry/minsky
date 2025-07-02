/**
 * SessionDB Health Monitoring Service
 *
 * Provides health checks, performance monitoring, and diagnostics
 * for all SessionDB storage backends.
 */

import { log } from "../../../utils/logger";
import { StorageBackendFactory } from "../storage-backend-factory";
import { SessionDbConfig } from "../../configuration/types";
import { configurationService } from "../../configuration";
import config from "config";
import { getErrorMessage } from "../../../errors";

export interface HealthStatus {
  healthy: boolean;
  backend: string;
  responseTime: number;
  timestamp: string;
  details?: Record<string, any>;
  errors?: string[];
  warnings?: string[];
}

export interface PerformanceMetrics {
  operationType: string;
  duration: number;
  success: boolean;
  timestamp: string;
  backend: string;
  sessionCount?: number;
}

export interface SystemHealth {
  overall: "healthy" | "degraded" | "unhealthy";
  backend: HealthStatus;
  performance: {
    averageResponseTime: number;
    successRate: number;
    recentErrors: number;
  };
  storage: {
    diskUsage?: number;
    connectionCount?: number;
    locksHeld?: number;
  };
  recommendations: string[];
}

export class SessionDbHealthMonitor {
  private static metrics: PerformanceMetrics[] = [];
  private static readonly MAX_METRICS = 1000; // Keep last 1000 metrics
  private static readonly HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds

  /**
   * Perform comprehensive health check
   */
  static async performHealthCheck(sessionDbConfig?: SessionDbConfig): Promise<SystemHealth> {
    const startTime = Date.now();

    try {
      // Load configuration if not provided
      if (!sessionDbConfig) {
        sessionDbConfig = config.get("sessiondb") as SessionDbConfig;
      }

      // Check backend health
      const backendHealth = await this.checkBackendHealth(sessionDbConfig);

      // Analyze performance metrics
      const performance = this.analyzePerformance();

      // Check storage-specific metrics
      const storage = await this.checkStorageMetrics(sessionDbConfig);

      // Generate recommendations
      const recommendations = this.generateRecommendations(backendHealth, performance, storage);

      // Determine overall health
      const overall = this.determineOverallHealth(backendHealth, performance);

      log.info("Health check completed", {
        duration: Date.now() - startTime,
        overall,
        backend: backendHealth.backend,
        healthy: backendHealth.healthy,
      });

      return {
        overall,
        backend: backendHealth,
        performance,
        storage,
        recommendations,
      };
    } catch (error) {
      log.error("Health check failed", {
        error: getErrorMessage(error),
        duration: Date.now() - startTime,
      });

      return {
        overall: "unhealthy",
        backend: {
          healthy: false,
          backend: sessionDbConfig?.backend || "unknown",
          responseTime: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          errors: [`Health check failed: ${getErrorMessage(error)}`],
        },
        performance: {
          averageResponseTime: 0,
          successRate: 0,
          recentErrors: 1,
        },
        storage: {},
        recommendations: ["Health monitoring failed - check system logs"],
      };
    }
  }

  /**
   * Check specific backend health
   */
  private static async checkBackendHealth(config: SessionDbConfig): Promise<HealthStatus> {
    const startTime = Date.now();
    const status: HealthStatus = {
      healthy: false,
      backend: config.backend,
      responseTime: 0,
      timestamp: new Date().toISOString(),
      details: {},
      errors: [],
      warnings: [],
    };

    try {
      // Create storage backend with timeout
      const storage = StorageBackendFactory.createFromConfig(config);

      // Test basic operations with timeout
      const testPromise = this.testBasicOperations(storage);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), this.HEALTH_CHECK_TIMEOUT)
      );

      await Promise.race([testPromise, timeoutPromise]);

      status.healthy = true;
      status.responseTime = Date.now() - startTime;

      // Backend-specific health checks
      await this.performBackendSpecificChecks(config, status);
    } catch (error) {
      status.healthy = false;
      status.responseTime = Date.now() - startTime;
      status.errors?.push(getErrorMessage(error));

      log.warn("Backend health check failed", {
        backend: config.backend,
        error: getErrorMessage(error),
        responseTime: status.responseTime,
      });
    }

    return status;
  }

  /**
   * Test basic storage operations
   */
  private static async testBasicOperations(storage: any): Promise<void> {
    // Initialize storage
    await storage.initialize();

    // Test read operation
    const readResult = await storage.readState();
    if (!readResult.success) {
      throw new Error(`Read operation failed: ${readResult.error}`);
    }

    // Test connection cleanup if available
    if (typeof storage.close === "function") {
      await storage.close();
    }
  }

  /**
   * Perform backend-specific health checks
   */
  private static async performBackendSpecificChecks(
    config: SessionDbConfig,
    status: HealthStatus
  ): Promise<void> {
    switch (config.backend) {
    case "json":
      await this.checkJsonBackendHealth(config, status);
      break;
    case "sqlite":
      await this.checkSqliteBackendHealth(config, status);
      break;
    case "postgres":
      await this.checkPostgresBackendHealth(config, status);
      break;
    }
  }

  /**
   * JSON backend specific health checks
   */
  private static async checkJsonBackendHealth(
    config: SessionDbConfig,
    status: HealthStatus
  ): Promise<void> {
    const fs = require("fs");
    const path = require("path");

    try {
      const dbPath = path.join(config.baseDir || "", "session-db.json");

      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        status.details!.fileSize = stats.size;
        status.details!.lastModified = stats.mtime.toISOString();

        // Warn about large files
        if (stats.size > 10_000_000) {
          // 10MB
          status.warnings?.push("Large JSON file detected - consider migrating to SQLite");
        }
      }

      // Check directory permissions
      const baseDir = config.baseDir || path.dirname(dbPath);
      try {
        fs.accessSync(baseDir, fs.constants.R_OK | fs.constants.W_OK);
        status.details!.directoryWritable = true;
      } catch (error) {
        status.errors?.push("Directory not writable");
        status.details!.directoryWritable = false;
      }
    } catch (error) {

      status.warnings?.push(`JSON health check warning: ${getErrorMessage(error)}`);

      status.warnings?.push(
        `JSON health check warning: ${error instanceof Error ? error.message : String(error)}`
      );

    }
  }

  /**
   * SQLite backend specific health checks
   */
  private static async checkSqliteBackendHealth(
    config: SessionDbConfig,
    status: HealthStatus
  ): Promise<void> {
    try {
      const Database = require("better-sqlite3");
      const db = new Database(config.dbPath);

      try {
        // Check database integrity
        const integrityResult = db.pragma("integrity_check");
        status.details!.integrityCheck = integrityResult[0].integrity_check === "ok";

        // Get database info
        const pageCount = db.pragma("page_count", { simple: true });
        const pageSize = db.pragma("page_size", { simple: true });
        status.details!.databaseSize = pageCount * pageSize;

        // Check WAL mode
        const journalMode = db.pragma("journal_mode", { simple: true });
        status.details!.journalMode = journalMode;

        if (journalMode !== "wal") {
          status.warnings?.push("Consider enabling WAL mode for better performance");
        }

        // Check for locks
        const busyTimeout = db.pragma("busy_timeout", { simple: true });
        status.details!.busyTimeout = busyTimeout;
      } finally {
        db.close();
      }
    } catch (error) {

      status.warnings?.push(`SQLite health check warning: ${getErrorMessage(error)}`);

      status.warnings?.push(
        `SQLite health check warning: ${error instanceof Error ? error.message : String(error)}`
      );

    }
  }

  /**
   * PostgreSQL backend specific health checks
   */
  private static async checkPostgresBackendHealth(
    config: SessionDbConfig,
    status: HealthStatus
  ): Promise<void> {
    try {
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString: config.connectionString });

      try {
        const client = await pool.connect();

        try {
          // Check server version
          const versionResult = await client.query("SELECT version()");
          status.details!.serverVersion = versionResult.rows[0].version;

          // Check connection count
          const connectionsResult = await client.query(
            "SELECT count(*) as active_connections FROM pg_stat_activity WHERE state = 'active'"
          );
          status.details!.activeConnections = parseInt(
            connectionsResult.rows[0].active_connections
          );

          // Check database size
          const sizeResult = await client.query(
            "SELECT pg_size_pretty(pg_database_size(current_database())) as size"
          );
          status.details!.databaseSize = sizeResult.rows[0].size;

          // Check for locks
          const locksResult = await client.query(
            "SELECT count(*) as locks FROM pg_locks WHERE NOT granted"
          );
          const lockCount = parseInt(locksResult.rows[0].locks);
          status.details!.blockedQueries = lockCount;

          if (lockCount > 0) {
            status.warnings?.push(`${lockCount} blocked queries detected`);
          }
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    } catch (error) {
      status.warnings?.push(`PostgreSQL health check warning: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Analyze performance metrics
   */
  private static analyzePerformance(): {
    averageResponseTime: number;
    successRate: number;
    recentErrors: number;
    } {
    const recentMetrics = this.metrics.slice(-100); // Last 100 operations

    if (recentMetrics.length === 0) {
      return {
        averageResponseTime: 0,
        successRate: 1.0,
        recentErrors: 0,
      };
    }

    const totalDuration = recentMetrics.reduce((sum, metric) => sum + metric.duration, 0);
    const successCount = recentMetrics.filter((metric) => metric.success).length;
    const recentErrors = recentMetrics.filter((metric) => !metric.success).length;

    return {
      averageResponseTime: totalDuration / recentMetrics.length,
      successRate: successCount / recentMetrics.length,
      recentErrors,
    };
  }

  /**
   * Check storage-specific metrics
   */
  private static async checkStorageMetrics(config: SessionDbConfig): Promise<{
    diskUsage?: number;
    connectionCount?: number;
    locksHeld?: number;
  }> {
    const metrics: Record<string, any> = {};

    try {
      // Check disk usage
      const fs = require("fs");
      const path = require("path");

      let checkPath: string;
      if (config.backend === "json") {
        checkPath = config.baseDir || "";
      } else if (config.backend === "sqlite") {
        checkPath = path.dirname(config.dbPath || "");
      } else {
        return metrics; // PostgreSQL doesn't have local disk usage
      }

      if (checkPath && fs.existsSync(checkPath)) {
        const stats = fs.statSync(checkPath);
        // This is a simplified check - real disk usage would require platform-specific tools
        metrics.diskUsage = stats.size || 0;
      }
    } catch (error) {
      log.warn("Storage metrics check failed", {
        error: getErrorMessage(error),
      });
    }

    return metrics;
  }

  /**
   * Generate health recommendations
   */
  private static generateRecommendations(
    backendHealth: HealthStatus,
    performance: { averageResponseTime: number; successRate: number; recentErrors: number },
    storage: Record<string, any>
  ): string[] {
    const recommendations: string[] = [];

    // Backend health recommendations
    if (!backendHealth.healthy) {
      recommendations.push("Backend health check failed - investigate errors");
    }

    if (backendHealth.warnings && backendHealth.warnings.length > 0) {
      recommendations.push("Address backend warnings to improve reliability");
    }

    // Performance recommendations
    if (performance.averageResponseTime > 1000) {
      recommendations.push("Slow response times detected - consider performance optimization");
    }

    if (performance.successRate < 0.95) {
      recommendations.push("Low success rate - investigate error patterns");
    }

    if (performance.recentErrors > 5) {
      recommendations.push("High error rate - check system health and configuration");
    }

    // Backend-specific recommendations
    if (backendHealth.backend === "json" && backendHealth.details?.fileSize > 5_000_000) {
      recommendations.push("Large JSON file - consider migrating to SQLite for better performance");
    }

    if (backendHealth.backend === "sqlite" && backendHealth.details?.journalMode !== "wal") {
      recommendations.push("Enable WAL mode for better SQLite performance");
    }

    if (backendHealth.backend === "postgres" && backendHealth.details?.activeConnections > 80) {
      recommendations.push("High connection count - consider connection pooling optimization");
    }

    return recommendations;
  }

  /**
   * Determine overall system health
   */
  private static determineOverallHealth(
    backendHealth: HealthStatus,
    performance: { averageResponseTime: number; successRate: number; recentErrors: number }
  ): "healthy" | "degraded" | "unhealthy" {
    if (!backendHealth.healthy) {
      return "unhealthy";
    }

    if (performance.successRate < 0.9 || performance.recentErrors > 10) {
      return "unhealthy";
    }

    if (
      performance.successRate < 0.98 ||
      performance.averageResponseTime > 2000 ||
      performance.recentErrors > 3
    ) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Record performance metric
   */
  static recordMetric(metric: PerformanceMetrics): void {
    this.metrics.push(metric);

    // Keep only recent metrics
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }

    // Log performance issues
    if (!metric.success) {
      log.warn("SessionDB operation failed", {
        operation: metric.operationType,
        backend: metric.backend,
        duration: metric.duration,
      });
    } else if (metric.duration > 2000) {
      log.warn("Slow SessionDB operation", {
        operation: metric.operationType,
        backend: metric.backend,
        duration: metric.duration,
      });
    }
  }

  /**
   * Get recent metrics
   */
  static getRecentMetrics(count: number = 50): PerformanceMetrics[] {
    return this.metrics.slice(-count);
  }

  /**
   * Clear metrics (useful for testing)
   */
  static clearMetrics(): void {
    this.metrics = [];
  }

  /**
   * Get health summary for monitoring dashboards
   */
  static async getHealthSummary(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    uptime: number;
    totalOperations: number;
    errorRate: number;
    avgResponseTime: number;
  }> {
    const performance = this.analyzePerformance();
    const totalOperations = this.metrics.length;

    // Simple uptime calculation (time since first metric)
    const uptime =
      this.metrics.length > 0 ? Date.now() - new Date(this.metrics[0].timestamp).getTime() : 0;

    return {
      status:
        performance.successRate < 0.9
          ? "unhealthy"
          : performance.successRate < 0.98
            ? "degraded"
            : "healthy",
      uptime,
      totalOperations,
      errorRate: 1 - performance.successRate,
      avgResponseTime: performance.averageResponseTime,
    };
  }
}
