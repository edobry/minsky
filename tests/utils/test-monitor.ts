/**
 * Test Quality Monitoring System
 * 
 * Provides flaky test detection, performance monitoring, and test categorization
 * to maintain high test quality and reliability.
 */

export interface TestExecution {
  testName: string;
  filePath: string;
  duration: number;
  status: 'pass' | 'fail' | 'skip';
  timestamp: number;
  memoryUsage?: number;
  error?: string;
}

export interface TestMetrics {
  totalRuns: number;
  failures: number;
  averageDuration: number;
  flakiness: number; // 0-1 score based on failure pattern
  lastFailure?: number;
  category: 'fast' | 'medium' | 'slow' | 'flaky' | 'critical';
}

/**
 * Tracks test executions and detects quality issues
 */
export class TestQualityMonitor {
  private executions: Map<string, TestExecution[]> = new Map();
  private readonly maxHistorySize = 100;
  
  /**
   * Record a test execution
   */
  recordExecution(execution: TestExecution): void {
    const key = `${execution.filePath}::${execution.testName}`;
    const history = this.executions.get(key) || [];
    
    history.push(execution);
    
    // Keep only recent executions
    if (history.length > this.maxHistorySize) {
      history.splice(0, history.length - this.maxHistorySize);
    }
    
    this.executions.set(key, history);
  }
  
  /**
   * Get metrics for a specific test
   */
  getTestMetrics(testName: string, filePath: string): TestMetrics | null {
    const key = `${filePath}::${testName}`;
    const history = this.executions.get(key);
    
    if (!history || history.length === 0) {
      return null;
    }
    
    const totalRuns = history.length;
    const failures = history.filter(e => e.status === 'fail').length;
    const averageDuration = history.reduce((sum, e) => sum + e.duration, 0) / totalRuns;
    
    // Calculate flakiness based on failure patterns
    const flakiness = this.calculateFlakiness(history);
    
    // Find last failure timestamp
    const lastFailure = history
      .filter(e => e.status === 'fail')
      .map(e => e.timestamp)
      .sort((a, b) => b - a)[0];
    
    // Categorize test
    const category = this.categorizeTest(averageDuration, flakiness, failures, totalRuns);
    
    return {
      totalRuns,
      failures,
      averageDuration,
      flakiness,
      lastFailure,
      category
    };
  }
  
  /**
   * Calculate flakiness score (0 = stable, 1 = completely unreliable)
   */
  private calculateFlakiness(history: TestExecution[]): number {
    if (history.length < 5) return 0; // Need enough data
    
    // Look for alternating patterns of success/failure
    let transitions = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i].status !== history[i-1].status) {
        transitions++;
      }
    }
    
    // Normalize by potential transitions
    const maxTransitions = history.length - 1;
    return transitions / maxTransitions;
  }
  
  /**
   * Categorize test based on performance and reliability
   */
  private categorizeTest(
    avgDuration: number, 
    flakiness: number, 
    failures: number, 
    totalRuns: number
  ): TestMetrics['category'] {
    // Flaky tests take priority
    if (flakiness > 0.3 || (failures > 0 && failures / totalRuns > 0.2)) {
      return 'flaky';
    }
    
    // Critical tests have high failure rate but low flakiness
    if (failures / totalRuns > 0.1) {
      return 'critical';
    }
    
    // Performance categories
    if (avgDuration > 5000) return 'slow';      // > 5s
    if (avgDuration > 1000) return 'medium';    // > 1s  
    return 'fast';                              // <= 1s
  }
  
  /**
   * Get all flaky tests
   */
  getFlakyTests(): Array<{testName: string, filePath: string, metrics: TestMetrics}> {
    const flakyTests: Array<{testName: string, filePath: string, metrics: TestMetrics}> = [];
    
    for (const [key, history] of this.executions) {
      const [filePath, testName] = key.split('::');
      const metrics = this.getTestMetrics(testName, filePath);
      
      if (metrics && metrics.category === 'flaky') {
        flakyTests.push({ testName, filePath, metrics });
      }
    }
    
    return flakyTests.sort((a, b) => b.metrics.flakiness - a.metrics.flakiness);
  }
  
  /**
   * Get slowest tests
   */
  getSlowestTests(limit: number = 10): Array<{testName: string, filePath: string, metrics: TestMetrics}> {
    const allTests: Array<{testName: string, filePath: string, metrics: TestMetrics}> = [];
    
    for (const [key, history] of this.executions) {
      const [filePath, testName] = key.split('::');
      const metrics = this.getTestMetrics(testName, filePath);
      
      if (metrics) {
        allTests.push({ testName, filePath, metrics });
      }
    }
    
    return allTests
      .sort((a, b) => b.metrics.averageDuration - a.metrics.averageDuration)
      .slice(0, limit);
  }
  
  /**
   * Generate quality report
   */
  generateQualityReport(): {
    totalTests: number;
    flakyTests: number;
    slowTests: number;
    criticalTests: number;
    averageTestDuration: number;
    worstOffenders: Array<{testName: string, filePath: string, reason: string, metrics: TestMetrics}>;
  } {
    let totalTests = 0;
    let flakyTests = 0;
    let slowTests = 0;
    let criticalTests = 0;
    let totalDuration = 0;
    const worstOffenders: Array<{testName: string, filePath: string, reason: string, metrics: TestMetrics}> = [];
    
    for (const [key, history] of this.executions) {
      const [filePath, testName] = key.split('::');
      const metrics = this.getTestMetrics(testName, filePath);
      
      if (metrics) {
        totalTests++;
        totalDuration += metrics.averageDuration;
        
        switch (metrics.category) {
          case 'flaky':
            flakyTests++;
            worstOffenders.push({
              testName, filePath, 
              reason: `Flakiness score: ${metrics.flakiness.toFixed(2)}`,
              metrics
            });
            break;
          case 'slow':
            slowTests++;
            worstOffenders.push({
              testName, filePath,
              reason: `Slow execution: ${metrics.averageDuration.toFixed(0)}ms`,
              metrics
            });
            break;
          case 'critical':
            criticalTests++;
            worstOffenders.push({
              testName, filePath,
              reason: `High failure rate: ${(metrics.failures/metrics.totalRuns*100).toFixed(1)}%`,
              metrics
            });
            break;
        }
      }
    }
    
    return {
      totalTests,
      flakyTests,
      slowTests,
      criticalTests,
      averageTestDuration: totalTests > 0 ? totalDuration / totalTests : 0,
      worstOffenders: worstOffenders
        .sort((a, b) => {
          // Sort by severity: flaky > critical > slow
          const severityOrder = { flaky: 3, critical: 2, slow: 1, fast: 0, medium: 0 };
          return severityOrder[b.metrics.category] - severityOrder[a.metrics.category];
        })
        .slice(0, 10)
    };
  }
  
  /**
   * Save monitoring data to file
   */
  exportData(): string {
    const data = {
      timestamp: Date.now(),
      executions: Array.from(this.executions.entries()).map(([key, history]) => ({
        key,
        history: history.slice(-10) // Keep last 10 executions per test
      }))
    };
    
    return JSON.stringify(data, null, 2);
  }
  
  /**
   * Load monitoring data from file
   */
  importData(jsonData: string): void {
    try {
      const data = JSON.parse(jsonData);
      this.executions.clear();
      
      for (const { key, history } of data.executions) {
        this.executions.set(key, history);
      }
    } catch (error) {
      console.error('Failed to import test monitoring data:', error);
    }
  }
}

// Global monitor instance
export const testMonitor = new TestQualityMonitor();

/**
 * Bun test reporter hook for automatic monitoring
 */
export function createTestReporter() {
  return {
    onTestStart: (test: any) => {
      // Track test start time
      test.__startTime = Date.now();
    },
    
    onTestComplete: (test: any) => {
      const duration = Date.now() - test.__startTime;
      
      testMonitor.recordExecution({
        testName: test.name,
        filePath: test.file,
        duration,
        status: test.passed ? 'pass' : 'fail',
        timestamp: Date.now(),
        error: test.error?.message
      });
    }
  };
}

