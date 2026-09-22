import React from 'react';
import { Mail, ShieldCheck, Activity, RefreshCw, Layers } from 'lucide-react';
import { GmailAccountConfig } from '../types.ts';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  gmailConfig: GmailAccountConfig;
  onDrainWorker: () => void;
  isDraining: boolean;
  queuedCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  gmailConfig,
  onDrainWorker,
  isDraining,
  queuedCount,
}) => {
  const tabs = [
    { id: 'dispatcher', label: 'Event Testbench & Chaos' },
    { id: 'outbox', label: 'Transactional Outbox', badge: queuedCount > 0 ? queuedCount : null },
    { id: 'templates', label: 'Template Studio' },
    { id: 'gmail', label: 'Gmail API & Quotas' },
    { id: 'observability', label: 'Observability & Audit' },
    { id: 'sdk', label: 'Integration SDK' },
    { id: 'report', label: '28-Phase Forensic Report' },
  ];

  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white sticky top-0 z-40">
      {/* Top bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-xl bg-teal-500/20 border border-teal-500/40 flex items-center justify-center text-teal-400 shadow-sm">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-lg font-bold tracking-tight text-white">Gmail Automation Engine</h1>
              <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-teal-950 text-teal-300 border border-teal-800/60">
                Production Engine v2.4
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Plug-and-play event-driven email platform for GoRentls & Startups
            </p>
          </div>
        </div>

        {/* Status Indicators & Action */}
        <div className="flex items-center space-x-4">
          <div className="hidden sm:flex items-center space-x-2 text-xs bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700/60">
            <ShieldCheck className="h-4 w-4 text-teal-400" />
            <span className="text-slate-300">Gmail API:</span>
            <span className="font-semibold text-white">{gmailConfig.oauthStatus}</span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-300">Daily Quota:</span>
            <span className="font-semibold text-teal-400">
              {gmailConfig.dailyQuotaUsed} / {gmailConfig.dailyQuotaLimit}
            </span>
          </div>

          <button
            onClick={onDrainWorker}
            disabled={isDraining}
            className="flex items-center space-x-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 rounded-lg shadow-sm transition-all"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isDraining ? 'animate-spin' : ''}`} />
            <span>{isDraining ? 'Processing...' : 'Drain Outbox Worker'}</span>
          </button>
        </div>
      </div>

      {/* Navigation tabs */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex overflow-x-auto scrollbar-none border-t border-slate-800/80">
        <nav className="flex space-x-1 py-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-3.5 py-2.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-teal-400 border-b-2 border-teal-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge !== null && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
