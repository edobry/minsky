beforeEach(() => {
  console.log("🔄 Setting up enhanced error handling test environment");

  // Reset circuit breaker state between tests to prevent interference
  const { retryService } = require("../../src/domain/ai/intelligent-retry-service.js");
  if (retryService && typeof retryService.resetCircuitBreakers === "function") {
    retryService.resetCircuitBreakers();
  }
});
