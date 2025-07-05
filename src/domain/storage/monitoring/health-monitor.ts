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
    const startTime = (Date as any).now();

    try {
      // Load configuration if not provided
      if (!sessionDbConfig) {
        sessionDbConfig = (config as any).get("sessiondb") as SessionDbConfig;
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
        duration: (Date as any).now() - startTime,
        overall,
        backend: (backendHealth as any).backend,
        healthy: (backendHealth as any).healthy,
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
        error: getErrorMessage(error as any),
        duration: (Date as any).now() - startTime,
      });

      return {
        overall: "unhealthy",
        backend: {
          healthy: false,
          backend: (sessionDbConfig as any).backend || "unknown",
          responseTime: (Date as any).now() - startTime,
          timestamp: (new Date() as any).toISOString(),
          errors: [`Health check failed: ${getErrorMessage(error as any)}`],
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
    const startTime = (Date as any).now();
    const status: HealthStatus = {
      healthy: false,
      backend: (config as any).backend,
      responseTime: 0,
      timestamp: (new Date() as any).toISOString(),
      details: {},
      errors: [],
      warnings: [],
    };

    try {
      // Create storage backend with timeout
      const storage = (StorageBackendFactory as any).createFromConfig(config as any);

      // Test basic operations with timeout
      const testPromise = this.testBasicOperations(storage);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), this.HEALTH_CHECK_TIMEOUT)
      );

      await (Promise as any).race([testPromise, timeoutPromise] as any[]);

      status.healthy = true;
      status.responseTime = (Date as any).now() - startTime;

      // Backend-specific health checks
      await this.performBackendSpecificChecks(config as any, status);
    } catch (error) {
      status.healthy = false;
      status.responseTime = (Date as any).now() - startTime;
      (status.errors as any).push(getErrorMessage(error as any));

      log.warn("Backend health check failed", {
        backend: (config as any).backend,
        error: getErrorMessage(error as any),
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
    await (storage as any).initialize();

    // Test read operation
    const readResult = await (storage as any).readState();
    if (!(readResult as any).success) {
      throw new Error(`Read operation failed: ${(readResult as any).error}`);
    }

    // Test connection cleanup if available
    if (typeof (storage as any).close === "function") {
      await (storage as any).close();
    }
  }

  /**
   * Perform backend-specific health checks
   */
  private static async performBackendSpecificChecks(
    config: SessionDbConfig,
    status: HealthStatus
  ): Promise<void> {
    switch ((config as any).backend) {
    case "json":
      await this.checkJsonBackendHealth(config as any, status);
      break;
    case "sqlite":
      await this.checkSqliteBackendHealth(config as any, status);
      break;
    case "postgres":
      await this.checkPostgresBackendHealth(config as any, status);
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
      const dbPath = path.join((config as any).baseDir || "", "session-db.json");

      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        (status.details! as any).fileSize = (stats as any).size;
        (status.details! as any).lastModified = (stats.mtime as any).toISOString();

        // Warn about large files
        if ((stats as any).size > 10_000_000) {
          // 10MB
          (status.warnings as any).push("Large JSON file detected - consider migrating to SQLite");
        }
      }

      // Check directory permissions
      const baseDir = (config as any).baseDir || path.dirname(dbPath);
      try {
        fs.accessSync(baseDir, fs.constants.R_OK | fs.constants.W_OK);
        (status.details! as any).directoryWritable = true;
      } catch (error) {
        (status.errors as any).push("Directory not writable");
        (status.details! as any).directoryWritable = false;
      }
    } catch (error) {

      status.warnings?.push(`JSON health check warning: ${getErrorMessage(error as any)}`);

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
      const db = new Database((config as any).dbPath);

      try {
        // Check database integrity
        const integrityResult = db.pragma("integrity_check");
        (status.details! as any).integrityCheck = (integrityResult[0] as any).integrity_check === "ok";

        // Get database info
        const pageCount = db.pragma("page_count", { simple: true });
        const pageSize = db.pragma("page_size", { simple: true });
        (status.details! as any).databaseSize = pageCount * pageSize;

        // Check WAL mode
        const journalMode = db.pragma("journal_mode", { simple: true });
        (status.details! as any).journalMode = journalMode;

        if (journalMode !== "wal") {
          (status.warnings as any).push("Consider enabling WAL mode for better performance");
        }

        // Check for locks
        const busyTimeout = db.pragma("busy_timeout", { simple: true });
        (status.details! as any).busyTimeout = busyTimeout;
      } finally {
        db.close();
      }
    } catch (error) {

      status.warnings?.push(`SQLite health check warning: ${getErrorMessage(error as any)}`);

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
      const pool = new Pool({ connectionString: (config as any).connectionString });

      try {
        const client = await pool.connect();

        try {
          // Check server version
          const versionResult = await (client as any).query("SELECT version()");
          (status.details! as any).serverVersion = (versionResult.rows[0] as any).version;

          // Check connection count
          const connectionsResult = await (client as any).query(
            "SELECT count(*) as active_connections FROM pg_stat_activity WHERE state = 'active'"
          );
          (status.details! as any).activeConnections = parseInt(
            (connectionsResult.rows[0] as any).active_connections
          );

          // Check database size
          const sizeResult = await (client as any).query(
            "SELECT pg_size_pretty(pg_database_size(current_database())) as size"
          );
          (status.details! as any).databaseSize = (sizeResult.rows[0] as any).size;

          // Check for locks
          const locksResult = await (client as any).query(
            "SELECT count(*) as locks FROM pg_locks WHERE NOT granted"
          );
          const lockCount = parseInt((locksResult.rows[0] as any).locks);
          (status.details! as any).blockedQueries = lockCount;

          if (lockCount > 0) {
            (status.warnings as any).push(`${lockCount} blocked queries detected`);
          }
        } finally {
          (client as any).release();
        }
      } finally {
        await pool.end();
      }
    } catch (error) {
      status.warnings?.push(`PostgreSQL health check warning: ${getErrorMessage(error as any)}`);
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
    const recentMetrics = (this.metrics as any).slice(-100); // Last 100 operations

    if ((recentMetrics as any).length === 0) {
      return {
        averageResponseTime: 0,
        successRate: 1.0,
        recentErrors: 0,
      };
    }

    const totalDuration = (recentMetrics as any).reduce((sum, metric) => sum + (metric as any).duration, 0);
    const successCount = ((recentMetrics as any).filter((metric) => metric.success) as any).length;
    const recentErrors = ((recentMetrics as any).filter((metric) => !metric.success) as any).length;

    return {
      averageResponseTime: totalDuration / (recentMetrics as any).length,
      successRate: successCount / (recentMetrics as any).length,
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
      if ((config as any).backend === "json") {
        checkPath = (config as any).baseDir || "";
      } else if ((config as any).backend === "sqlite") {
        checkPath = path.dirname((config as any).dbPath || "");
      } else {
        return metrics; // PostgreSQL doesn't have local disk usage
      }

      if (checkPath && fs.existsSync(checkPath)) {
        const stats = fs.statSync(checkPath);
        // This is a simplified check - real disk usage would require platform-specific tools
        (metrics as any).diskUsage = (stats as any).size || 0;
      }
    } catch (error) {
      log.warn("Storage metrics check failed", {
        error: getErrorMessage(error as any),
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
    if (!(backendHealth as any).healthy) {
      (recommendations as any).push("Backend health check failed - investigate errors");
    }

    if ((backendHealth as any).warnings && (backendHealth.warnings as any).length > 0) {
      (recommendations as any).push("Address backend warnings to improve reliability");
    }

    // Performance recommendations
    if ((performance as any).averageResponseTime > 1000) {
      (recommendations as any).push("Slow response times detected - consider performance optimization");
    }

    if ((performance as any).successRate < 0.95) {
      (recommendations as any).push("Low success rate - investigate error patterns");
    }

    if ((performance as any).recentErrors > 5) {
      (recommendations as any).push("High error rate - check system health and configuration");
    }

    // Backend-specific recommendations
    if ((backendHealth as any).backend === "json" && (backendHealth.details as any).fileSize > 5_000_000) {
      (recommendations as any).push("Large JSON file - consider migrating to SQLite for better performance");
    }

    if ((backendHealth as any).backend === "sqlite" && (backendHealth.details as any).journalMode !== "wal") {
      (recommendations as any).push("Enable WAL mode for better SQLite performance");
    }

    if ((backendHealth as any).backend === "postgres" && (backendHealth.details as any).activeConnections > 80) {
      (recommendations as any).push("High connection count - consider connection pooling optimization");
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
    if (!(backendHealth as any).healthy) {
      return "unhealthy";
    }

    if ((performance as any).successRate < 0.9 || (performance as any).recentErrors > 10) {
      return "unhealthy";
    }

    if (
      (performance as any).successRate < 0.98 ||
      (performance as any).averageResponseTime > 2000 ||
      (performance as any).recentErrors > 3
    ) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Record performance metric
   */
  static recordMetric(metric: PerformanceMetrics): void {
    (this.metrics as any).push(metric);

    // Keep only recent metrics
    if ((this.metrics as any).length > this.MAX_METRICS) {
      this.metrics = (this.metrics as any).slice(-this.MAX_METRICS);
    }

    // Log performance issues
    if (!(metric as any).success) {
      log.warn("SessionDB operation failed", {
        operation: (metric as any).operationType,
        backend: (metric as any).backend,
        duration: (metric as any).duration,
      });
    } else if ((metric as any).duration > 2000) {
      log.warn("Slow SessionDB operation", {
        operation: (metric as any).operationType,
        backend: (metric as any).backend,
        duration: (metric as any).duration,
      });
    }
  }

  /**
   * Get recent metrics
   */
  static getRecentMetrics(count: number = 50): PerformanceMetrics[] {
    return (this.metrics as any).slice(-count);
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
    const totalOps = (this.metrics as any).length;
    const errors = (this.metrics as any).filter(m => !m.success).length;
    const avgResponse = totalOps > 0 ? (this.metrics as any).reduce((sum, m) => sum + m.duration, 0) / totalOps : 0;
    const uptime =
      this.metrics && this.metrics[0]
        ? (Date as any).now() - new Date(this.metrics[0].timestamp).getTime()
        : 0;

    return {
      status: this.determineOverallHealth(
        { healthy: true, backend: "test", responseTime: 0, timestamp: (new Date() as any).toISOString() },
        { averageResponseTime: avgResponse, successRate: 1 - errors / totalOps, recentErrors: errors }
      ),
      uptime,
      totalOperations: totalOps,
      errorRate: 1 - (this.metrics as any).filter(m => m.success).length / totalOps,
      avgResponseTime: avgResponse,
    };
  }
}
