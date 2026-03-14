import { get } from './api';
import type { Contact, ContactDetail, TimelineEntry } from './types';

export interface ContactsParams {
  search?: string;
  tag?: string;
  source?: string;
}

export function fetchContacts(params: ContactsParams = {}): Promise<Contact[]> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
  ).toString();
  return get<Contact[]>(`/contacts${qs ? `?${qs}` : ''}`);
}

export function fetchContact(id: string): Promise<ContactDetail> {
  return get<ContactDetail>(`/contacts/${id}`);
}

export function fetchContactTimeline(
  id: string,
  params: { before?: string; limit?: number } = {}
): Promise<TimelineEntry[]> {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)])
  ).toString();
  return get<TimelineEntry[]>(`/contacts/${id}/timeline${qs ? `?${qs}` : ''}`);
}
