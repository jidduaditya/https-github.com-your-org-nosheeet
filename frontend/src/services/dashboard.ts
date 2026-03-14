import { get } from './api';
import type { DashboardSummary } from './types';

export function fetchDashboardSummary(): Promise<DashboardSummary> {
  return get<DashboardSummary>('/dashboard/summary');
}
