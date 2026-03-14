import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';

import { fetchContacts, fetchContact, fetchContactTimeline } from '../services/contacts';
import { fetchDeals, fetchDeal, updateDeal }                 from '../services/deals';
import { fetchReminders, snoozeReminder, markReminderDone }  from '../services/reminders';
import { fetchDashboardSummary }                             from '../services/dashboard';
import type {
  Contact, ContactDetail, TimelineEntry,
  Deal, DealDetail,
  Reminder, SnoozePayload,
  DashboardSummary,
} from '../services/types';
import type { ContactsParams }              from '../services/contacts';
import type { DealsParams, DealUpdatePayload } from '../services/deals';
import type { RemindersParams }             from '../services/reminders';

// ── Query key factory ─────────────────────────────────────────────────────────
export const qk = {
  contacts:          (p?: ContactsParams)              => ['contacts', p]             as const,
  contact:           (id: string)                      => ['contacts', id]            as const,
  contactTimeline:   (id: string, p?: object)          => ['contacts', id, 'timeline', p] as const,
  deals:             (p?: DealsParams)                 => ['deals', p]                as const,
  deal:              (id: string)                      => ['deals', id]               as const,
  reminders:         (p?: RemindersParams)             => ['reminders', p]            as const,
  dashboard:         ()                                => ['dashboard', 'summary']    as const,
};

// ── Contacts ──────────────────────────────────────────────────────────────────

export function useContacts(
  params: ContactsParams = {},
  options?: Omit<UseQueryOptions<Contact[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery<Contact[]>({
    queryKey: qk.contacts(params),
    queryFn:  () => fetchContacts(params),
    staleTime: 60_000,
    ...options,
  });
}

export function useContact(
  id: string,
  options?: Omit<UseQueryOptions<ContactDetail>, 'queryKey' | 'queryFn'>
) {
  return useQuery<ContactDetail>({
    queryKey: qk.contact(id),
    queryFn:  () => fetchContact(id),
    staleTime: 60_000,
    enabled:  Boolean(id),
    ...options,
  });
}

export function useContactTimeline(
  id: string,
  params: { before?: string; limit?: number } = {},
  options?: Omit<UseQueryOptions<TimelineEntry[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery<TimelineEntry[]>({
    queryKey: qk.contactTimeline(id, params),
    queryFn:  () => fetchContactTimeline(id, params),
    staleTime: 30_000,
    enabled:  Boolean(id),
    ...options,
  });
}

// ── Deals ────────────────────────────────────────────────────────────────────

export function useDeals(
  params: DealsParams = {},
  options?: Omit<UseQueryOptions<Deal[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery<Deal[]>({
    queryKey: qk.deals(params),
    queryFn:  () => fetchDeals(params),
    staleTime: 60_000,
    refetchInterval: 30_000,  // poll for AI updates
    ...options,
  });
}

export function useDeal(
  id: string,
  options?: Omit<UseQueryOptions<DealDetail>, 'queryKey' | 'queryFn'>
) {
  return useQuery<DealDetail>({
    queryKey: qk.deal(id),
    queryFn:  () => fetchDeal(id),
    staleTime: 60_000,
    enabled:  Boolean(id),
    ...options,
  });
}

export function useUpdateDeal() {
  const qc = useQueryClient();
  return useMutation<Deal, Error, { id: string; payload: DealUpdatePayload }>({
    mutationFn: ({ id, payload }) => updateDeal(id, payload),
    onSuccess: (updated) => {
      // Update the deal in the list caches
      qc.setQueriesData<Deal[]>({ queryKey: ['deals'] }, (old) =>
        old?.map(d => d.id === updated.id ? updated : d)
      );
      // Invalidate the single deal so its detail view refreshes
      qc.invalidateQueries({ queryKey: qk.deal(updated.id) });
    },
  });
}

// ── Reminders ────────────────────────────────────────────────────────────────

export function useReminders(
  params: RemindersParams = {},
  options?: Omit<UseQueryOptions<Reminder[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery<Reminder[]>({
    queryKey: qk.reminders(params),
    queryFn:  () => fetchReminders(params),
    staleTime: 30_000,
    refetchInterval: 20_000,  // reminders change frequently
    ...options,
  });
}

export function useSnoozeReminder() {
  const qc = useQueryClient();
  return useMutation<Reminder, Error, { id: string; payload: SnoozePayload }>({
    mutationFn: ({ id, payload }) => snoozeReminder(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reminders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useMarkReminderDone() {
  const qc = useQueryClient();
  return useMutation<Reminder, Error, string>({
    mutationFn: (id) => markReminderDone(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reminders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export function useDashboard(
  options?: Omit<UseQueryOptions<DashboardSummary>, 'queryKey' | 'queryFn'>
) {
  return useQuery<DashboardSummary>({
    queryKey: qk.dashboard(),
    queryFn:  fetchDashboardSummary,
    staleTime: 60_000,
    refetchInterval: 20_000,
    ...options,
  });
}
