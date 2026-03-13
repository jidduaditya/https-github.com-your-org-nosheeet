import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Deal } from '../lib/api';
import Pipeline from '../components/Pipeline';

export default function Dashboard() {
  const navigate = useNavigate();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const fetchDeals = useCallback(async () => {
    try {
      const res = await api.get<Deal[]>('/deals');
      setDeals(res.data);
    } catch (err) {
      setError('Failed to load deals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeals();
    // Poll every 30 seconds for new deals/AI updates
    const interval = setInterval(fetchDeals, 30000);
    return () => clearInterval(interval);
  }, [fetchDeals]);

  const handleDealUpdate = (updated: Deal) => {
    setDeals((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const logout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const filteredDeals = search
    ? deals.filter(
        (d) =>
          d.contact_name?.toLowerCase().includes(search.toLowerCase()) ||
          d.contact_email?.toLowerCase().includes(search.toLowerCase()) ||
          d.title?.toLowerCase().includes(search.toLowerCase())
      )
    : deals;

  const pendingConfirmations = deals.filter((d) => d.stage_needs_confirm && d.ai_suggested_stage && d.ai_suggested_stage !== d.stage).length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="bg-white border-b border-slate-100 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-slate-900">NoSheeet</h1>
          {pendingConfirmations > 0 && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
              {pendingConfirmations} AI suggestion{pendingConfirmations > 1 ? 's' : ''} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search deals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 w-48 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={() => navigate('/onboarding')}
            className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100"
          >
            Channels
          </button>
          <button
            onClick={logout}
            className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100"
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-slate-400 text-sm">Loading deals...</div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-red-500 text-sm">{error}</div>
          </div>
        ) : deals.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-slate-500 mb-2">No deals yet.</p>
            <p className="text-slate-400 text-sm mb-4">Connect Gmail or WhatsApp to auto-create deals from your conversations.</p>
            <button
              onClick={() => navigate('/onboarding')}
              className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
            >
              Connect channels
            </button>
          </div>
        ) : (
          <Pipeline deals={filteredDeals} onDealUpdate={handleDealUpdate} />
        )}
      </main>
    </div>
  );
}
