import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Channel {
  provider: string;
  expires_at: string;
  updated_at: string;
}

export default function Onboarding() {
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api.get<Channel[]>('/channels').then((res) => {
      setChannels(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const isConnected = (provider: string) => channels.some((c) => c.provider === provider);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.post('/channels/connect', { provider: 'google' });
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p>Loading...</p></div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-lg">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Connect your channels</h1>
        <p className="text-slate-500 mb-8">NoSheeet pulls from your existing conversations — no data entry needed.</p>

        <div className="space-y-4">
          {/* Gmail */}
          <div className="flex items-center justify-between p-4 border-2 rounded-xl border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center text-xl">📧</div>
              <div>
                <p className="font-semibold text-slate-800">Gmail</p>
                <p className="text-sm text-slate-400">Last 90 days of emails</p>
              </div>
            </div>
            {isConnected('google') ? (
              <span className="text-green-600 font-medium text-sm flex items-center gap-1">
                <span>✓</span> Connected
              </span>
            ) : (
              <a
                href={`${import.meta.env.VITE_API_URL ?? 'http://localhost:3001'}/auth/google`}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Connect
              </a>
            )}
          </div>

          {/* Google Calendar */}
          <div className="flex items-center justify-between p-4 border-2 rounded-xl border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center text-xl">📅</div>
              <div>
                <p className="font-semibold text-slate-800">Google Calendar</p>
                <p className="text-sm text-slate-400">Auto-linked to contacts</p>
              </div>
            </div>
            {isConnected('google') ? (
              <span className="text-green-600 font-medium text-sm flex items-center gap-1">
                <span>✓</span> Connected
              </span>
            ) : (
              <span className="text-slate-400 text-sm">Included with Gmail</span>
            )}
          </div>

          {/* WhatsApp */}
          <div className="flex items-center justify-between p-4 border-2 rounded-xl border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center text-xl">💬</div>
              <div>
                <p className="font-semibold text-slate-800">WhatsApp Business</p>
                <p className="text-sm text-slate-400">Real-time message ingestion</p>
              </div>
            </div>
            <span className="text-slate-400 text-sm">Via webhook (v2)</span>
          </div>
        </div>

        {isConnected('google') && (
          <div className="mt-6">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 px-4 rounded-lg transition-colors text-sm"
            >
              {syncing ? 'Syncing...' : 'Re-sync Google data'}
            </button>
          </div>
        )}

        <button
          onClick={() => navigate('/dashboard')}
          className="mt-4 w-full bg-brand-600 hover:bg-brand-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
        >
          {isConnected('google') ? 'Go to Dashboard' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}
