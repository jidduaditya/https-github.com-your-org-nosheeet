import { get, patch } from './api';
import type { Deal, DealDetail, Stage } from './types';

export interface DealsParams {
  stage?: Stage;
  contact_id?: string;
}

export function fetchDeals(params: DealsParams = {}): Promise<Deal[]> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
  ).toString();
  return get<Deal[]>(`/deals${qs ? `?${qs}` : ''}`);
}

export function fetchDeal(id: string): Promise<DealDetail> {
  return get<DealDetail>(`/deals/${id}`);
}

export interface DealUpdatePayload {
  stage?: Stage;
  summary?: string;
  pain_points?: string[];
  stage_needs_confirm?: boolean;
}

export function updateDeal(id: string, payload: DealUpdatePayload): Promise<Deal> {
  return patch<Deal>(`/deals/${id}`, payload);
}
