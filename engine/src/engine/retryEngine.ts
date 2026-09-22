import { ErrorClassification } from '../types.ts';

export interface RetryPolicy {
  maxAttempts: number;
  initialIntervalMs: number;
  maxIntervalMs: number;
  backoffMultiplier: number;
  jitterRatio: number; // 0 to 1
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialIntervalMs: 2000, // 2 seconds
  maxIntervalMs: 60000, // 60 seconds
  backoffMultiplier: 2.0,
  jitterRatio: 0.5,
};

export class RetryEngine {
  /**
   * Classify any error into a deterministic category.
   */
  public classifyError(error: any): { classification: ErrorClassification; isRetryable: boolean; suggestedRetryAfterMs?: number } {
    if (!error) {
      return { classification: 'RETRYABLE_5XX_SERVER_ERROR', isRetryable: true };
    }

    const message = (error.message || String(error)).toLowerCase();
    const status = error.status || error.statusCode || error.code;

    // 429 Rate Limit
    if (status === 429 || message.includes('rate limit') || message.includes('quota exceeded') || message.includes('userateLimitExceeded')) {
      return {
        classification: 'RETRYABLE_429_RATE_LIMIT',
        isRetryable: true,
        suggestedRetryAfterMs: error.retryAfter ? error.retryAfter * 1000 : 5000,
      };
    }

    // 401 / 403 Auth Failure
    if (status === 401 || message.includes('invalid_grant') || message.includes('token expired') || message.includes('unauthenticated')) {
      return {
        classification: 'PERMANENT_AUTH_FAILURE',
        isRetryable: false, // Requires token refresh / operator intervention
      };
    }

    // 400 Bad Request or Template Variable Validation
    if (message.includes('missing required variable') || message.includes('validation failed')) {
      return {
        classification: 'PERMANENT_TEMPLATE_VALIDATION',
        isRetryable: false,
      };
    }

    if (message.includes('invalid recipient') || message.includes('malformed address')) {
      return {
        classification: 'PERMANENT_INVALID_RECIPIENT',
        isRetryable: false,
      };
    }

    if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
      return {
        classification: 'PERMANENT_BAD_REQUEST',
        isRetryable: false,
      };
    }

    // Network timeout / connection reset
    if (status === 408 || message.includes('timeout') || message.includes('econnreset') || message.includes('etimedout') || message.includes('network error')) {
      return {
        classification: 'RETRYABLE_NETWORK_TIMEOUT',
        isRetryable: true,
      };
    }

    // 5xx Server Errors (Google Backend issues)
    if (status >= 500 && status <= 599) {
      return {
        classification: 'RETRYABLE_5XX_SERVER_ERROR',
        isRetryable: true,
      };
    }

    // Default: treat unknown exceptions as retryable 5xx until max attempts
    return {
      classification: 'RETRYABLE_5XX_SERVER_ERROR',
      isRetryable: true,
    };
  }

  /**
   * Calculates next attempt delay using Exponential Backoff with Full Jitter.
   * Full Jitter formula: sleep = rand(0, min(maxInterval, initialInterval * 2^attempt))
   */
  public calculateNextAttemptDelayMs(attemptNumber: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
    const rawBackoff = Math.min(
      policy.maxIntervalMs,
      policy.initialIntervalMs * Math.pow(policy.backoffMultiplier, Math.max(0, attemptNumber - 1))
    );

    // Apply full jitter to prevent thundering herd against Gmail API
    const jitter = Math.random() * (rawBackoff * policy.jitterRatio);
    const minFloor = rawBackoff * (1 - policy.jitterRatio);
    return Math.round(minFloor + jitter);
  }
}

export const retryEngine = new RetryEngine();
