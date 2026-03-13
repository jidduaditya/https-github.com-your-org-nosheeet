import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT from localStorage
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auto-logout on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export interface Deal {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  contact_channel: string;
  contact_tags: string[];
  title: string;
  stage: string;
  ai_suggested_stage?: string;
  stage_needs_confirm: boolean;
  summary?: string;
  pain_points: string[];
  ai_buy_signal?: number;
  last_activity: string;
  created_at: string;
}

export interface Contact {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  primary_channel: string;
  tags: string[];
  message_count: number;
  deal_count: number;
  last_message_at?: string;
  created_at: string;
}

export const STAGES = [
  'NEW_LEAD',
  'CONTACTED',
  'INTERESTED',
  'PROPOSAL_SENT',
  'NEGOTIATING',
  'CLOSED_WON',
  'CLOSED_LOST',
  'COLD',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<string, string> = {
  NEW_LEAD: 'New Lead',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  PROPOSAL_SENT: 'Proposal Sent',
  NEGOTIATING: 'Negotiating',
  CLOSED_WON: 'Closed Won',
  CLOSED_LOST: 'Closed Lost',
  COLD: 'Cold',
};

export const STAGE_COLORS: Record<string, string> = {
  NEW_LEAD: 'bg-gray-100 text-gray-700',
  CONTACTED: 'bg-blue-100 text-blue-700',
  INTERESTED: 'bg-yellow-100 text-yellow-700',
  PROPOSAL_SENT: 'bg-orange-100 text-orange-700',
  NEGOTIATING: 'bg-purple-100 text-purple-700',
  CLOSED_WON: 'bg-green-100 text-green-700',
  CLOSED_LOST: 'bg-red-100 text-red-700',
  COLD: 'bg-gray-100 text-gray-400',
};
