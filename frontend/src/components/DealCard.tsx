import { useState } from 'react';
import { api, Deal, STAGE_LABELS, STAGE_COLORS } from '../lib/api';

interface Props {
  deal: Deal;
  onUpdate: (updated: Deal) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const CHANNEL_ICONS: Record<string, string> = {
  gmail: '📧',
  whatsapp: '💬',
  calendar: '📅',
  manual: '✏️',
};

export default function DealCard({ deal, onUpdate }: Props) {
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryText, setSummaryText] = useState(deal.summary ?? '');

  const confirmStage = async () => {
    const res = await api.patch<Deal>(`/deals/${deal.id}`, {
      stage: deal.ai_suggested_stage,
      stage_needs_confirm: false,
    });
    onUpdate(res.data);
    // stage confirmed
  };

  const dismissStage = async () => {
    const res = await api.patch<Deal>(`/deals/${deal.id}`, { stage_needs_confirm: false });
    onUpdate(res.data);
  };

  const saveSummary = async () => {
    const res = await api.patch<Deal>(`/deals/${deal.id}`, { summary: summaryText });
    onUpdate(res.data);
    setEditingSummary(false);
  };

  const signalColor =
    (deal.ai_buy_signal ?? 0) >= 0.7
      ? 'bg-green-500'
      : (deal.ai_buy_signal ?? 0) >= 0.4
      ? 'bg-yellow-400'
      : 'bg-red-400';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-slate-900 text-sm">
            {CHANNEL_ICONS[deal.contact_channel] ?? '•'} {deal.contact_name ?? deal.contact_email ?? deal.contact_phone ?? 'Unknown'}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">{timeAgo(deal.last_activity)}</p>
        </div>
        {deal.ai_buy_signal !== undefined && (
          <div className="flex items-center gap-1" title={`Buy signal: ${Math.round((deal.ai_buy_signal ?? 0) * 100)}%`}>
            <div className={`w-2 h-2 rounded-full ${signalColor}`} />
            <span className="text-xs text-slate-500">{Math.round((deal.ai_buy_signal ?? 0) * 100)}%</span>
          </div>
        )}
      </div>

      {/* Stage badge */}
      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-2 ${STAGE_COLORS[deal.stage]}`}>
        {STAGE_LABELS[deal.stage]}
      </span>

      {/* AI stage suggestion */}
      {deal.stage_needs_confirm && deal.ai_suggested_stage && deal.ai_suggested_stage !== deal.stage && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3">
          <p className="text-xs text-amber-700 font-medium mb-1.5">
            AI suggests: <strong>{STAGE_LABELS[deal.ai_suggested_stage]}</strong>
          </p>
          <div className="flex gap-2">
            <button
              onClick={confirmStage}
              className="text-xs bg-amber-500 hover:bg-amber-600 text-white px-2 py-1 rounded font-medium"
            >
              Confirm
            </button>
            <button
              onClick={dismissStage}
              className="text-xs text-amber-600 hover:text-amber-800 px-2 py-1 font-medium"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Summary */}
      {editingSummary ? (
        <div className="mb-2">
          <textarea
            value={summaryText}
            onChange={(e) => setSummaryText(e.target.value)}
            className="w-full text-xs text-slate-600 border border-slate-200 rounded p-1.5 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex gap-2 mt-1">
            <button onClick={saveSummary} className="text-xs text-brand-600 font-medium">Save</button>
            <button onClick={() => setEditingSummary(false)} className="text-xs text-slate-400">Cancel</button>
          </div>
        </div>
      ) : deal.summary ? (
        <p
          className="text-xs text-slate-600 line-clamp-3 mb-2 cursor-pointer hover:text-slate-800"
          onClick={() => setEditingSummary(true)}
          title="Click to edit"
        >
          {deal.summary}
        </p>
      ) : null}

      {/* Pain points */}
      {deal.pain_points?.length > 0 && (
        <div className="mb-2">
          <p className="text-xs text-slate-400 font-medium mb-1">Pain points</p>
          <ul className="space-y-0.5">
            {deal.pain_points.slice(0, 3).map((p, i) => (
              <li key={i} className="text-xs text-slate-600 flex gap-1">
                <span className="text-slate-400 mt-0.5">•</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tags */}
      {deal.contact_tags?.includes('untagged_lead') && (
        <span className="inline-block text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
          untagged
        </span>
      )}
    </div>
  );
}
