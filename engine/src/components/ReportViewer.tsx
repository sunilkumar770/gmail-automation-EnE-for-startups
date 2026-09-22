import React, { useState } from 'react';
import { BookOpen, Search, Filter, Copy, Check, ChevronRight, Award } from 'lucide-react';
import { ENGINEERING_REPORT, ReportSection } from '../data/engineeringReport.ts';

export const ReportViewer: React.FC = () => {
  const [selectedSectionId, setSelectedSectionId] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [copied, setCopied] = useState(false);

  const categories = ['ALL', 'Forensic & Bugs', 'Architecture & Design', 'Engine Systems', 'GoRentls & Domain', 'Delivery & Certification'];

  const filteredSections = ENGINEERING_REPORT.filter((sec) => {
    if (categoryFilter !== 'ALL' && sec.category !== categoryFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      sec.title.toLowerCase().includes(q) ||
      sec.summary.toLowerCase().includes(q) ||
      sec.content.toLowerCase().includes(q)
    );
  });

  const currentSection = ENGINEERING_REPORT.find((s) => s.id === selectedSectionId) || filteredSections[0] || ENGINEERING_REPORT[0];

  const handleCopySection = () => {
    navigator.clipboard.writeText(`${currentSection.title}\n\n${currentSection.content}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <Award className="h-4 w-4 text-teal-500" />
              <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
                Authoritative 28-Phase Architectural Audit
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
              Engineering Organization Transformation Report
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Forensic analysis of <code className="text-teal-600 dark:text-teal-400 font-mono">sunilkumar770/gmail-automation-EnE-for-startups</code>, bug ledger, system architecture, and production certification.
            </p>
          </div>

          <button
            onClick={handleCopySection}
            className="flex items-center space-x-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-teal-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Copied to Clipboard' : 'Copy Current Section'}</span>
          </button>
        </div>

        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5 mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                categoryFilter === cat
                  ? 'bg-slate-900 text-white dark:bg-teal-600'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Navigation List of all 28 sections */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search 28 sections..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-white"
            />
          </div>

          <div className="space-y-1.5 max-h-[640px] overflow-y-auto pr-1">
            {filteredSections.map((section) => {
              const isSelected = section.id === currentSection.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setSelectedSectionId(section.id)}
                  className={`w-full text-left p-3 rounded-lg border text-xs transition-all ${
                    isSelected
                      ? 'border-teal-500 bg-teal-50/70 dark:bg-teal-950/40 text-teal-950 dark:text-teal-100 font-semibold ring-1 ring-teal-500'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-xs">{section.title}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                    {section.summary}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Section Deep Dive */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm min-h-[600px]">
          <div className="border-b border-slate-200 dark:border-slate-800 pb-4 mb-4">
            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-teal-600 dark:text-teal-400 font-bold">
              {currentSection.category}
            </span>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-2">
              {currentSection.title}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {currentSection.summary}
            </p>
          </div>

          <div className="prose dark:prose-invert max-w-none text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap font-sans">
            {currentSection.content}
          </div>
        </div>
      </div>
    </div>
  );
};
