import { GmailAccountConfig, FaultInjectionConfig } from '../types.ts';

export interface GmailSendParams {
  to: string;
  toName?: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  threadId?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export interface GmailSendResult {
  providerMessageId: string;
  providerThreadId: string;
  rfc822MessageId: string;
  unitsConsumed: number;
  rawMimePreview: string;
  timestamp: string;
  latencyMs: number;
}

export class GmailAdapter {
  private config: GmailAccountConfig = {
    connectedEmail: 'automation@gorentals.example',
    accountType: 'WORKSPACE',
    dailyQuotaLimit: 2000,
    dailyQuotaUsed: 42,
    rateLimitPerSec: 2.5, // 250 units / 100 units per send = 2.5/s
    oauthStatus: 'CONNECTED',
    tokenExpiresAt: new Date(Date.now() + 3200 * 1000).toISOString(),
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    senderName: 'GoRentals Notifications',
    replyToEmail: 'support@gorentals.example',
  };

  private faultConfig: FaultInjectionConfig = {
    forceError: null,
    artificialLatencyMs: 250,
  };

  public getConfig(): GmailAccountConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<GmailAccountConfig>): GmailAccountConfig {
    this.config = { ...this.config, ...updates };
    return this.getConfig();
  }

  public setFaultConfig(config: Partial<FaultInjectionConfig>): void {
    this.faultConfig = { ...this.faultConfig, ...config };
  }

  public getFaultConfig(): FaultInjectionConfig {
    return { ...this.faultConfig };
  }

  /**
   * Refreshes the OAuth2 access token if expiring.
   */
  public async refreshToken(): Promise<{ success: boolean; newExpiry: string }> {
    const newExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
    this.config.tokenExpiresAt = newExpiry;
    this.config.oauthStatus = 'CONNECTED';
    return { success: true, newExpiry };
  }

  /**
   * Construct an RFC 2822 compliant MIME message string.
   */
  public buildMimeMessage(params: GmailSendParams): { rawMime: string; rfc822MessageId: string; base64Url: string } {
    const boundary = '====_Boundary_' + Math.random().toString(36).substring(2) + '_' + Date.now();
    const rfc822MessageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 8)}@${this.config.connectedEmail.split('@')[1] || 'gorentals.com'}>`;
    const dateStr = new Date().toUTCString();

    const fromFormatted = params.fromName ? `"${params.fromName.replace(/"/g, '')}" <${params.from}>` : params.from;
    const toFormatted = params.toName ? `"${params.toName.replace(/"/g, '')}" <${params.to}>` : params.to;

    const headers: string[] = [
      `From: ${fromFormatted}`,
      `To: ${toFormatted}`,
      `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(params.subject)))}?=`,
      `Date: ${dateStr}`,
      `Message-ID: ${rfc822MessageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    if (params.replyTo) {
      headers.push(`Reply-To: ${params.replyTo}`);
    }

    if (params.threadId) {
      headers.push(`In-Reply-To: <thread-${params.threadId}@mail.gmail.com>`);
      headers.push(`References: <thread-${params.threadId}@mail.gmail.com>`);
    }

    if (params.headers) {
      for (const [key, val] of Object.entries(params.headers)) {
        headers.push(`${key}: ${val}`);
      }
    }

    const mimeBody = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      params.text,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      params.html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    // Gmail API requires base64url encoding (replace + with -, / with _, remove padding =)
    const base64Standard = btoa(unescape(encodeURIComponent(mimeBody)));
    const base64Url = base64Standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return { rawMime: mimeBody, rfc822MessageId, base64Url };
  }

  /**
   * Executes send via Gmail API (messages.send).
   * Respects user quota (100 units/send) and handles simulated or real faults.
   */
  public async send(params: GmailSendParams): Promise<GmailSendResult> {
    const startTime = Date.now();

    // Check artificial latency
    if (this.faultConfig.artificialLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.faultConfig.artificialLatencyMs));
    }

    // Check fault injections
    if (this.faultConfig.forceError === '429_RATE_LIMIT') {
      const error: any = new Error('Gmail API Rate Limit Exceeded: 250 quota units/sec exceeded (429)');
      error.status = 429;
      error.retryAfter = 3;
      throw error;
    }

    if (this.faultConfig.forceError === '503_SERVICE_UNAVAILABLE') {
      const error: any = new Error('Google Backend 503: Backend error encountered while sending email.');
      error.status = 503;
      throw error;
    }

    if (this.faultConfig.forceError === '401_TOKEN_EXPIRED') {
      this.config.oauthStatus = 'EXPIRED';
      const error: any = new Error('Gmail OAuth Error (401): The access token is expired or revoked (invalid_grant).');
      error.status = 401;
      throw error;
    }

    if (this.faultConfig.forceError === 'NETWORK_TIMEOUT') {
      const error: any = new Error('Network Timeout (ECONNRESET): Socket closed before Gmail API responded.');
      error.status = 408;
      throw error;
    }

    // Check daily quota limits
    if (this.config.dailyQuotaUsed >= this.config.dailyQuotaLimit) {
      const error: any = new Error(`Gmail Daily Send Quota Reached (${this.config.dailyQuotaLimit}/${this.config.dailyQuotaLimit} emails/day).`);
      error.status = 429;
      throw error;
    }

    // Generate RFC 2822 and Base64Url
    const { rawMime, rfc822MessageId } = this.buildMimeMessage(params);

    // Consume Gmail Quota:
    // messages.send costs 100 quota units in Google API quota ledger
    this.config.dailyQuotaUsed += 1;

    const providerMessageId = '18e9a' + Math.random().toString(16).substring(2, 11);
    const providerThreadId = params.threadId || ('18e9a' + Math.random().toString(16).substring(2, 11));

    const latencyMs = Date.now() - startTime;

    return {
      providerMessageId,
      providerThreadId,
      rfc822MessageId,
      unitsConsumed: 100,
      rawMimePreview: rawMime.substring(0, 800) + '...\n[Full RFC2822 payload encoded in base64url]',
      timestamp: new Date().toISOString(),
      latencyMs,
    };
  }
}

export const gmailAdapter = new GmailAdapter();
