import { get, post } from './api';
import type { Reminder, SnoozePayload } from './types';

export interface RemindersParams {
  status?: 'scheduled' | 'sent' | 'snoozed' | 'dismissed' | 'cancelled';
  deal_id?: string;
}

export function fetchReminders(params: RemindersParams = {}): Promise<Reminder[]> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
  ).toString();
  return get<Reminder[]>(`/reminders${qs ? `?${qs}` : ''}`);
}

export function snoozeReminder(id: string, payload: SnoozePayload): Promise<Reminder> {
  return post<Reminder>(`/reminders/${id}/snooze`, payload);
}

export function markReminderDone(id: string): Promise<Reminder> {
  return post<Reminder>(`/reminders/${id}/done`, {});
}
