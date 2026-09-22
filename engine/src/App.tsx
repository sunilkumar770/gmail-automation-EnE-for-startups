import React, { useState, useEffect } from 'react';
import { Header } from './components/Header.tsx';
import { EventDispatcher } from './components/EventDispatcher.tsx';
import { OutboxMonitor } from './components/OutboxMonitor.tsx';
import { TemplateStudio } from './components/TemplateStudio.tsx';
import { GmailConsole } from './components/GmailConsole.tsx';
import { ObservabilityView } from './components/ObservabilityView.tsx';
import { IntegrationGuide } from './components/IntegrationGuide.tsx';
import { ReportViewer } from './components/ReportViewer.tsx';
import { outboxEngine } from './engine/outbox.ts';
import { gmailAdapter } from './engine/gmailAdapter.ts';
import { emailEngine } from './engine/eventEmitter.ts';
import { GmailAccountConfig } from './types.ts';

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('dispatcher');
  const [gmailConfig, setGmailConfig] = useState<GmailAccountConfig>(gmailAdapter.getConfig());
  const [isDraining, setIsDraining] = useState(false);
  const [outboxCount, setOutboxCount] = useState(0);

  // Initialize initial sample data so the dashboard demonstrates live capabilities immediately
  useEffect(() => {
    const initializeSampleState = async () => {
      // 1. Initial Confirmed Booking (Sent)
      const res1 = await emailEngine.emit({
        event: 'BOOKING_CONFIRMED',
        tenant: 'gorentls',
        entityId: '49204',
        recipient: { email: 'david.chen@example.com', name: 'David Chen' },
        data: {
          customerName: 'David Chen',
          bookingId: '49204',
          listingName: '2024 Tesla Model Y Long Range',
          startDate: 'Oct 12, 2026 10:00 AM',
          endDate: 'Oct 15, 2026 06:00 PM',
          totalAmount: '389.00',
          depositAmount: '200.00',
          currency: 'USD',
          pickupLocation: 'Downtown Mobility Hub, Terminal 2',
          ownerName: 'Alex Rivers',
        },
      });

      // 2. Initial Payment Receipt (Sent)
      await emailEngine.emit({
        event: 'PAYMENT_SUCCESS',
        tenant: 'gorentls',
        entityId: 'inv_91823',
        recipient: { email: 'david.chen@example.com', name: 'David Chen' },
        data: {
          customerName: 'David Chen',
          invoiceId: 'INV-91823',
          bookingId: '49204',
          amount: '589.00',
          currency: 'USD',
          paymentMethod: 'Visa ending in •••• 4242',
          date: 'Oct 10, 2026, 09:14 AM UTC',
        },
      });

      // Process those first two so they appear in SENT state
      await outboxEngine.drainQueue('worker-init');

      // 3. One Queued event awaiting manual drain
      await emailEngine.emit({
        event: 'RENTAL_STARTING_SOON',
        tenant: 'gorentls',
        entityId: 'bkg_49204',
        recipient: { email: 'david.chen@example.com', name: 'David Chen' },
        data: {
          customerName: 'David Chen',
          bookingId: '49204',
          listingName: '2024 Tesla Model Y Long Range',
          startDate: 'Oct 12, 2026 10:00 AM',
          pickupLocation: 'Downtown Mobility Hub, Keybox Slot #14',
          securityPin: '8294',
        },
      });

      setOutboxCount(outboxEngine.getRows().filter((r) => r.state === 'QUEUED').length);
      setGmailConfig({ ...gmailAdapter.getConfig() });
    };

    initializeSampleState();
  }, []);

  const handleDrainWorker = async () => {
    setIsDraining(true);
    try {
      await outboxEngine.drainQueue('worker-manual');
      setOutboxCount(outboxEngine.getRows().filter((r) => r.state === 'QUEUED').length);
      setGmailConfig({ ...gmailAdapter.getConfig() });
    } finally {
      setIsDraining(false);
    }
  };

  const handleRefresh = () => {
    setOutboxCount(outboxEngine.getRows().filter((r) => r.state === 'QUEUED').length);
    setGmailConfig({ ...gmailAdapter.getConfig() });
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        gmailConfig={gmailConfig}
        onDrainWorker={handleDrainWorker}
        isDraining={isDraining}
        queuedCount={outboxCount}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'dispatcher' && (
          <EventDispatcher
            onEventSent={handleRefresh}
            onNavigateToOutbox={() => setActiveTab('outbox')}
          />
        )}

        {activeTab === 'outbox' && (
          <OutboxMonitor
            onRefresh={handleRefresh}
            onDrainWorker={handleDrainWorker}
            isDraining={isDraining}
          />
        )}

        {activeTab === 'templates' && <TemplateStudio />}

        {activeTab === 'gmail' && (
          <GmailConsole
            config={gmailConfig}
            onConfigChange={handleRefresh}
          />
        )}

        {activeTab === 'observability' && <ObservabilityView />}

        {activeTab === 'sdk' && <IntegrationGuide />}

        {activeTab === 'report' && <ReportViewer />}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-900/60 py-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>
            Gmail Automation Engine • Plug-and-Play Architecture for GoRentls & Startups
          </span>
          <span className="font-mono text-[11px] text-slate-400">
            Compliant with Google Workspace 250 units/sec Quota & RFC 2822
          </span>
        </div>
      </footer>
    </div>
  );
}
