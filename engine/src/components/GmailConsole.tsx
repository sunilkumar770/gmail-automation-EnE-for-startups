import React, { useState } from 'react';
import { ShieldCheck, RefreshCw, Key, AlertOctagon, Terminal, MailCheck, Gauge } from 'lucide-react';
import { gmailAdapter } from '../engine/gmailAdapter.ts';
import { GmailAccountConfig } from '../types.ts';

interface GmailConsoleProps {
  config: GmailAccountConfig;
  onConfigChange: () => void;
}

export const GmailConsole: React.FC<GmailConsoleProps> = ({ config, onConfigChange }) => {
  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);

  // Sample MIME encoder sandbox
  const sampleMime = gmailAdapter.buildMimeMessage({
    to: 'customer@example.com',
    toName: 'Sarah Miller',
    from: config.connectedEmail,
    fromName: config.senderName,
    replyTo: config.replyToEmail,
    subject: 'Confirmed: 2024 Tesla Model Y Long Range (#49204)',
    html: '<h1>Booking Confirmed</h1><p>Your vehicle is reserved.</p>',
    text: 'Booking Confirmed\nYour vehicle is reserved.',
    threadId: '18e9a9281a',
  });

  const handleRefreshToken = async () => {
    setIsRefreshingToken(true);
    setTokenNotice(null);
    try {
      const res = await gmailAdapter.refreshToken();
      setTokenNotice(`Access token refreshed successfully. New expiration: ${new Date(res.newExpiry).toLocaleTimeString()}`);
      onConfigChange();
    } catch (err: any) {
      setTokenNotice('Token refresh failed: ' + err.message);
    } finally {
      setIsRefreshingToken(false);
    }
  };

  const quotaPercent = Math.round((config.dailyQuotaUsed / config.dailyQuotaLimit) * 100);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              Provider Integration & Quota Ledger
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
              Gmail API Architecture & Security
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Grounded in official Google Workspace / Gmail API specifications. Tracks 250 units/sec rate limits, RFC 2822 base64url message encoding, and automated OAuth2 token lifecycle management.
            </p>
          </div>

          <button
            onClick={handleRefreshToken}
            disabled={isRefreshingToken}
            className="flex items-center space-x-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshingToken ? 'animate-spin' : ''}`} />
            <span>{isRefreshingToken ? 'Refreshing OAuth Token...' : 'Refresh Access Token'}</span>
          </button>
        </div>

        {tokenNotice && (
          <div className="mt-3 p-3 bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200 text-xs rounded-lg">
            {tokenNotice}
          </div>
        )}
      </div>

      {/* Metrics & Quota Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Daily Send Quota */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Daily Send Quota (24h)
            </span>
            <Gauge className="h-4 w-4 text-teal-500" />
          </div>

          <div className="flex items-baseline space-x-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-white">
              {config.dailyQuotaUsed}
            </span>
            <span className="text-xs text-slate-400">/ {config.dailyQuotaLimit} emails</span>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                quotaPercent > 85 ? 'bg-rose-500' : quotaPercent > 60 ? 'bg-amber-500' : 'bg-teal-500'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, quotaPercent))}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {config.accountType === 'WORKSPACE' ? 'Google Workspace Business tier (2,000/day)' : 'Consumer Gmail tier (500/day)'}
          </p>
        </div>

        {/* Per-User Rate Limits */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Per-User Rate Cap
            </span>
            <AlertOctagon className="h-4 w-4 text-amber-500" />
          </div>

          <div className="flex items-baseline space-x-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-white">
              250 units/sec
            </span>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-300">
            Google charges <strong className="text-teal-600 dark:text-teal-400">100 quota units</strong> per <code className="text-[11px] font-mono">messages.send</code> call.
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Maximum throughput without triggering HTTP 429 is <strong>2.5 sends/second</strong>. Handled by our Token Bucket rate limiter.
          </p>
        </div>

        {/* OAuth2 Security Credentials */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              OAuth2 Security & Scopes
            </span>
            <ShieldCheck className="h-4 w-4 text-teal-500" />
          </div>

          <div className="text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-500">Sender Account:</span>
              <span className="font-mono font-medium text-slate-900 dark:text-white">{config.connectedEmail}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Least-Privilege Scope:</span>
              <span className="font-mono text-[10px] text-teal-600 dark:text-teal-400">gmail.send only</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Token Status:</span>
              <span className="font-bold text-teal-600 dark:text-teal-400">{config.oauthStatus}</span>
            </div>
          </div>
          <p className="text-[11px] text-slate-500">
            Zero mailbox read or delete permissions requested.
          </p>
        </div>
      </div>

      {/* RFC 2822 / MIME Base64url Inspector */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              RFC 2822 MIME & Base64url Payload Inspector
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Exact RFC 2822 envelope constructed for Google Gmail API <code className="text-teal-600 font-mono">POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send</code>
            </p>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
            URL-Safe Base64 (RFC 4648)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Decoded RFC 2822 Multipart MIME
            </span>
            <pre className="p-3.5 bg-slate-950 text-slate-200 rounded-lg text-[11px] font-mono overflow-x-auto max-h-72 whitespace-pre-wrap leading-relaxed">
              {sampleMime.rawMime}
            </pre>
          </div>

          <div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Encoded Base64url String (<code className="text-teal-500">requestBody.raw</code>)
            </span>
            <pre className="p-3.5 bg-slate-950 text-teal-400 rounded-lg text-[11px] font-mono overflow-x-auto max-h-72 whitespace-pre-wrap break-all leading-relaxed">
              {sampleMime.base64Url}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
