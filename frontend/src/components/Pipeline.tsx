import { Deal, STAGE_LABELS } from '../lib/api';
import DealCard from './DealCard';

interface Props {
  deals: Deal[];
  onDealUpdate: (updated: Deal) => void;
}

// Kanban shows the active pipeline stages (not closed/cold)
const PIPELINE_STAGES = ['NEW_LEAD', 'CONTACTED', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATING'] as const;

const COLUMN_COLORS: Record<string, string> = {
  NEW_LEAD: 'border-t-gray-400',
  CONTACTED: 'border-t-blue-400',
  INTERESTED: 'border-t-yellow-400',
  PROPOSAL_SENT: 'border-t-orange-400',
  NEGOTIATING: 'border-t-purple-400',
};

export default function Pipeline({ deals, onDealUpdate }: Props) {
  const byStage = (stage: string) => deals.filter((d) => d.stage === stage);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {PIPELINE_STAGES.map((stage) => {
        const stageDeals = byStage(stage);
        return (
          <div key={stage} className="flex-shrink-0 w-72">
            <div className={`bg-white rounded-xl border-2 border-slate-100 border-t-4 ${COLUMN_COLORS[stage]} p-3`}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-700">{STAGE_LABELS[stage]}</h2>
                <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5 font-medium">
                  {stageDeals.length}
                </span>
              </div>
              <div className="space-y-3">
                {stageDeals.length === 0 ? (
                  <p className="text-xs text-slate-300 text-center py-6">No deals</p>
                ) : (
                  stageDeals.map((deal) => (
                    <DealCard key={deal.id} deal={deal} onUpdate={onDealUpdate} />
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Closed / Cold section */}
      <div className="flex-shrink-0 w-72">
        <div className="bg-white rounded-xl border-2 border-slate-100 border-t-4 border-t-green-400 p-3 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Closed Won</h2>
            <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5 font-medium">
              {byStage('CLOSED_WON').length}
            </span>
          </div>
          <div className="space-y-3">
            {byStage('CLOSED_WON').slice(0, 5).map((deal) => (
              <DealCard key={deal.id} deal={deal} onUpdate={onDealUpdate} />
            ))}
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 border-slate-100 border-t-4 border-t-red-400 p-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Closed Lost</h2>
            <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5 font-medium">
              {byStage('CLOSED_LOST').length}
            </span>
          </div>
          <div className="space-y-3">
            {byStage('CLOSED_LOST').slice(0, 5).map((deal) => (
              <DealCard key={deal.id} deal={deal} onUpdate={onDealUpdate} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
