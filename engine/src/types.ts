export type EmailStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'SENDING'
  | 'SENT'
  | 'RETRYING'
  | 'RETRY_WAIT'
  | 'FAILED'
  | 'PERMANENTLY_FAILED'
  | 'CANCELLED'
  | 'UNKNOWN'
  | 'SUPPRESSED';

export type ErrorClassification =
  | 'RETRYABLE_429_RATE_LIMIT'
  | 'RETRYABLE_5XX_SERVER_ERROR'
  | 'RETRYABLE_NETWORK_TIMEOUT'
  | 'PERMANENT_INVALID_RECIPIENT'
  | 'PERMANENT_TEMPLATE_VALIDATION'
  | 'PERMANENT_AUTH_FAILURE'
  | 'PERMANENT_BAD_REQUEST'
  | 'AMBIGUOUS_TIMEOUT';

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64?: string;
  sizeBytes: number;
}

export interface OutboxRecord {
  id: string;
  logicalEventId: string; // e.g. booking:123:BOOKING_CONFIRMED
  tenant: string; // e.g. 'gorentls' | 'saas_platform'
  event: string; // e.g. 'BOOKING_CONFIRMED'
  recipient: EmailRecipient;
  templateKey: string;
  templateVersion: number;
  payload: Record<string, any>;
  state: EmailStatus;
  priority: number; // 1 (highest) to 10
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  failedAt?: string;
  lastError?: string;
  lastErrorClass?: ErrorClassification;
  providerMessageId?: string;
  providerThreadId?: string;
  correlationId: string;
  retryCount: number;
}

export interface SendAttemptLog {
  id: string;
  outboxId: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILURE' | 'AMBIGUOUS';
  errorClass?: ErrorClassification;
  statusCode?: number;
  errorMessage?: string;
  idempotencyKeyUsed: string;
  providerMessageId?: string;
  providerThreadId?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  correlationId: string;
  logicalEventId: string;
  event: string;
  action: string;
  details: string;
  level: 'info' | 'warn' | 'error' | 'security';
  metadata?: Record<string, any>;
}

export interface TemplateDefinition {
  key: string;
  version: number;
  name: string;
  category: 'authentication' | 'customer' | 'owner' | 'platform';
  description: string;
  requiredVariables: string[];
  optionalVariables: string[];
  defaultSubject: string;
  preheader: string;
  ctaText?: string;
  ctaUrlTemplate?: string;
}

export interface GmailAccountConfig {
  connectedEmail: string;
  accountType: 'WORKSPACE' | 'CONSUMER_GMAIL';
  dailyQuotaLimit: number;
  dailyQuotaUsed: number;
  rateLimitPerSec: number;
  oauthStatus: 'CONNECTED' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNAUTHENTICATED';
  tokenExpiresAt: string;
  scopes: string[];
  senderName: string;
  replyToEmail: string;
}

export interface EmitEventRequest {
  event: string;
  tenant?: string;
  entityId: string | number;
  recipient: {
    email: string;
    name?: string;
  };
  data: Record<string, any>;
  idempotencyKey?: string;
  priority?: number;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
  threadId?: string;
}

export interface FaultInjectionConfig {
  forceError: null | '429_RATE_LIMIT' | '503_SERVICE_UNAVAILABLE' | '401_TOKEN_EXPIRED' | 'NETWORK_TIMEOUT' | 'INVALID_TEMPLATE_VARIABLE' | 'DUPLICATE_CONCURRENT_SEND';
  artificialLatencyMs: number;
}

export interface ObservabilityMetrics {
  totalEventsReceived: number;
  totalEmailsSent: number;
  totalEmailsFailed: number;
  totalRetries: number;
  rateLimit429Count: number;
  serverError5xxCount: number;
  validationErrorCount: number;
  duplicatesDeduplicated: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  uptimeSeconds: number;
}
