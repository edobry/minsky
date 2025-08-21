/**
 * Mock Morph API responses for testing error handling scenarios
 * These mocks simulate various HTTP responses from the Morph API
 */

export interface MockResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * Successful Morph API response with proper edit pattern application
 */
export const SUCCESSFUL_EDIT_RESPONSE: MockResponse = {
  status: 200,
  statusText: "OK",
  headers: {
    "content-type": "application/json",
    "x-ratelimit-remaining": "98",
    "x-ratelimit-limit": "100",
  },
  body: {
    id: "chatcmpl-test123",
    object: "chat.completion",
    created: 1677652288,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  
  subtract(a: number, b: number): number {
    return a - b;
  }
  
  multiply(a: number, b: number): number {
    return a * b;
  }
}`,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 85,
      total_tokens: 110,
    },
  },
};

/**
 * Rate limit exceeded response (429)
 * BUG: Currently treated as successful content instead of throwing error
 */
export const RATE_LIMIT_RESPONSE: MockResponse = {
  status: 429,
  statusText: "Too Many Requests",
  headers: {
    "content-type": "application/json",
    "retry-after": "60",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-limit": "100",
    "x-ratelimit-reset": "1677652348",
  },
  body: {
    detail:
      "Rate limit exceeded. Upgrade to a paid plan at https://morphllm.com/dashboard/billing for higher limits. Contact support@morphllm.com if you need help.",
  },
};

/**
 * Authentication error response (401)
 */
export const AUTH_ERROR_RESPONSE: MockResponse = {
  status: 401,
  statusText: "Unauthorized",
  headers: {
    "content-type": "application/json",
  },
  body: {
    error: {
      message: "Invalid API key",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  },
};

/**
 * Server error response (500)
 */
export const SERVER_ERROR_RESPONSE: MockResponse = {
  status: 500,
  statusText: "Internal Server Error",
  headers: {
    "content-type": "application/json",
  },
  body: {
    error: {
      message: "Internal server error",
      type: "server_error",
      code: "internal_error",
    },
  },
};

/**
 * Bad request error (400)
 */
export const BAD_REQUEST_RESPONSE: MockResponse = {
  status: 400,
  statusText: "Bad Request",
  headers: {
    "content-type": "application/json",
  },
  body: {
    error: {
      message: "Invalid request format",
      type: "invalid_request_error",
      code: "invalid_request",
    },
  },
};

/**
 * Network timeout simulation
 */
export const NETWORK_TIMEOUT = {
  shouldTimeout: true,
  timeoutMs: 30000,
};

/**
 * Helper to create a mock fetch function that returns specific responses
 */
export function createMockFetch(responses: MockResponse[]): typeof fetch {
  let callCount = 0;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = responses[callCount] || responses[responses.length - 1];
    callCount++;

    // Simulate network timeout if configured
    if ("shouldTimeout" in response && response.shouldTimeout) {
      await new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Network timeout")), response.timeoutMs);
      });
    }

    // Create a Response object that matches the real fetch API
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Mock that alternates between rate limits and success
 * Useful for testing retry logic
 */
export function createRetryScenarioMock(): typeof fetch {
  let callCount = 0;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    callCount++;

    // First two calls return rate limit, third succeeds
    if (callCount <= 2) {
      return new Response(JSON.stringify(RATE_LIMIT_RESPONSE.body), {
        status: RATE_LIMIT_RESPONSE.status,
        statusText: RATE_LIMIT_RESPONSE.statusText,
        headers: RATE_LIMIT_RESPONSE.headers,
      });
    } else {
      return new Response(JSON.stringify(SUCCESSFUL_EDIT_RESPONSE.body), {
        status: SUCCESSFUL_EDIT_RESPONSE.status,
        statusText: SUCCESSFUL_EDIT_RESPONSE.statusText,
        headers: SUCCESSFUL_EDIT_RESPONSE.headers,
      });
    }
  };
}
