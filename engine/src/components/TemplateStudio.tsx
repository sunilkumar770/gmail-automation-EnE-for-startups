import React, { useState } from 'react';
import { Smartphone, Monitor, AlertTriangle, CheckCircle2, Code, Layers, FileText } from 'lucide-react';
import { TEMPLATE_REGISTRY, renderEmail, validateTemplateVariables } from '../engine/templates.ts';
import { GORENTLS_EVENT_CATALOG } from '../engine/gorentlsAdapter.ts';

export const TemplateStudio: React.FC = () => {
  const templateKeys = Object.keys(TEMPLATE_REGISTRY);
  const [selectedKey, setSelectedKey] = useState<string>('BOOKING_CONFIRMED');
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [activeTab, setActiveTab] = useState<'html' | 'text' | 'variables'>('html');

  // Find sample data from catalog or generate defaults
  const matchingPreset = GORENTLS_EVENT_CATALOG.find((p) => p.event === selectedKey);
  const [dataJson, setDataJson] = useState<string>(
    JSON.stringify(matchingPreset?.data || { userName: 'Sarah Miller', bookingId: '49204' }, null, 2)
  );

  const handleSelectTemplate = (key: string) => {
    setSelectedKey(key);
    const preset = GORENTLS_EVENT_CATALOG.find((p) => p.event === key);
    if (preset) {
      setDataJson(JSON.stringify(preset.data, null, 2));
    }
  };

  const def = TEMPLATE_REGISTRY[selectedKey];

  let parsedData: Record<string, any> = {};
  let parseError = '';
  try {
    parsedData = JSON.parse(dataJson);
  } catch (err: any) {
    parseError = err.message;
  }

  const validation = !parseError ? validateTemplateVariables(selectedKey, parsedData) : { valid: false, missing: [] };

  let renderedHtml = '';
  let renderedText = '';
  let renderedSubject = '';
  let renderError = '';

  if (validation.valid && !parseError) {
    try {
      const res = renderEmail(selectedKey, parsedData, {
        tenantName: 'GoRentals',
      });
      renderedHtml = res.html;
      renderedText = res.text;
      renderedSubject = res.subject;
    } catch (err: any) {
      renderError = err.message;
    }
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              Responsive Design System
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
              Email Template Studio
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Strictly separates Email Event from Template, Data Contract, and Transport. Enforces required variable contracts to prevent broken emails in production.
            </p>
          </div>

          {/* Viewport & View Mode Controls */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
              <button
                onClick={() => setViewport('desktop')}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewport === 'desktop'
                    ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <Monitor className="h-3.5 w-3.5" />
                <span>Desktop</span>
              </button>
              <button
                onClick={() => setViewport('mobile')}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewport === 'mobile'
                    ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Mobile</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left: Template Selector */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Registered Templates ({templateKeys.length})
          </h3>
          <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
            {templateKeys.map((key) => {
              const t = TEMPLATE_REGISTRY[key];
              const isSelected = selectedKey === key;
              return (
                <button
                  key={key}
                  onClick={() => handleSelectTemplate(key)}
                  className={`w-full text-left p-3 rounded-lg border text-xs transition-all ${
                    isSelected
                      ? 'border-teal-500 bg-teal-50/70 dark:bg-teal-950/40 text-teal-950 dark:text-teal-100 font-semibold ring-1 ring-teal-500'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-xs">{t.name}</span>
                    <span className="text-[10px] uppercase font-mono px-1 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                      v{t.version}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {key}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Center & Right: Live Sandbox & Variable Inspector */}
        <div className="lg:col-span-3 space-y-4">
          {/* Sub Navigation */}
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
            <div className="flex space-x-2">
              <button
                onClick={() => setActiveTab('html')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  activeTab === 'html'
                    ? 'bg-slate-900 text-white dark:bg-teal-600'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Rendered HTML Preview
              </button>
              <button
                onClick={() => setActiveTab('text')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  activeTab === 'text'
                    ? 'bg-slate-900 text-white dark:bg-teal-600'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Plain-Text Alternative
              </button>
              <button
                onClick={() => setActiveTab('variables')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  activeTab === 'variables'
                    ? 'bg-slate-900 text-white dark:bg-teal-600'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Payload & Variable Contracts
              </button>
            </div>

            {/* Validation Pill */}
            {validation.valid ? (
              <span className="text-[11px] text-teal-600 dark:text-teal-400 font-medium flex items-center space-x-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Strict Schema Validated</span>
              </span>
            ) : (
              <span className="text-[11px] text-rose-500 font-medium flex items-center space-x-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>Missing: {validation.missing.join(', ')}</span>
              </span>
            )}
          </div>

          {/* Tab Content */}
          {activeTab === 'html' && (
            <div className="bg-slate-100 dark:bg-slate-950 p-6 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-center overflow-auto min-h-[500px]">
              {validation.valid && renderedHtml ? (
                <div
                  className={`transition-all duration-300 bg-white rounded-lg shadow-xl overflow-hidden ${
                    viewport === 'mobile' ? 'w-[375px]' : 'w-full max-w-[620px]'
                  }`}
                >
                  <iframe
                    title="Rendered Email Preview"
                    srcDoc={renderedHtml}
                    className="w-full h-[640px] border-none"
                    sandbox="allow-same-origin"
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-12 text-center text-rose-500 max-w-md">
                  <AlertTriangle className="h-10 w-10 mb-3" />
                  <h4 className="font-bold text-sm">Rendering Aborted Safely</h4>
                  <p className="text-xs mt-1 text-slate-600 dark:text-slate-400">
                    {parseError || validation.error || renderError}
                  </p>
                  <p className="text-[11px] mt-3 text-slate-500">
                    The engine strictly refuses to render or dispatch emails when required variables are absent, preventing embarrassing or broken emails from ever reaching customers.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'text' && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  RFC 2822 Plain Text Alternative
                </span>
                <span className="text-[11px] text-slate-400">Required for spam prevention and accessibility</span>
              </div>
              <pre className="p-4 bg-slate-950 text-slate-200 rounded-lg text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-[550px] overflow-y-auto">
                {renderedText || 'Template rendering error. Check variable contracts.'}
              </pre>
            </div>
          )}

          {activeTab === 'variables' && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700/60">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 block mb-2">
                    Required Variables (Must be Present)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {def.requiredVariables.map((v) => (
                      <span
                        key={v}
                        className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-teal-100 text-teal-800 dark:bg-teal-950/70 dark:text-teal-300 border border-teal-200 dark:border-teal-800"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700/60">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 block mb-2">
                    Optional Variables
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {def.optionalVariables.map((v) => (
                      <span
                        key={v}
                        className="px-2 py-0.5 rounded text-xs font-mono bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Live Variable Editor (Modify JSON to test contract enforcement)
                </label>
                <textarea
                  rows={12}
                  value={dataJson}
                  onChange={(e) => setDataJson(e.target.value)}
                  className="w-full text-xs font-mono p-3.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
