import type { McpServer } from '@modelcontextprotocol/server';
import type { calendar_v3 } from 'googleapis/build/src/apis/calendar/v3.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { bounded, id, page, register, requireValue } from './register.js';

const calendarId = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\s/\\?\p{Cc}]+$/u, 'Use a calendar ID or primary, not a URL.');
const timestamp = z.iso.datetime({ offset: true });
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone.');
const eventTime = z.union([
  z.strictObject({ date: z.iso.date() }),
  z.strictObject({ dateTime: timestamp, timeZone: timeZone.optional() }),
]);
const fields = {
  summary: z.string().min(1).max(1000),
  description: z.string().max(100000).optional(),
  location: z.string().max(1000).optional(),
  start: eventTime,
  end: eventTime.describe('Exclusive end; for a one-day all-day event use the following date.'),
};
const write = {
  calendarId,
  sendUpdates: z
    .enum(['all', 'externalOnly', 'none'])
    .describe('Explicit guest notification policy. Google may still send some emails with none.'),
  dryRun: z.boolean().default(false),
};
function checkRange(start: string, end: string) {
  if (!(Date.parse(start) < Date.parse(end))) throw new UserError('The end must be after the start.');
}
function times(start: z.infer<typeof eventTime>, end: z.infer<typeof eventTime>) {
  if ('date' in start && 'date' in end) {
    checkRange(start.date, end.date);
    return {
      start: { date: start.date, dateTime: null, timeZone: null },
      end: { date: end.date, dateTime: null, timeZone: null },
    };
  }
  if ('dateTime' in start && 'dateTime' in end) {
    checkRange(start.dateTime, end.dateTime);
    return {
      start: { date: null, dateTime: start.dateTime, timeZone: start.timeZone ?? null },
      end: { date: null, dateTime: end.dateTime, timeZone: end.timeZone ?? null },
    };
  }
  throw new UserError('Start and end must both be dates or both be timestamps with time zone offsets.');
}

export function registerCalendar(server: McpServer, api: calendar_v3.Calendar) {
  register(
    server,
    'calendar_list_calendars',
    'Read one page of calendars, including IDs, time zones and access roles.',
    page,
    async ({ pageSize, pageToken }) =>
      bounded(await apiCall(() => api.calendarList.list({ maxResults: pageSize, pageToken }))),
  );
  register(
    server,
    'calendar_list_events',
    'Read one event page within an explicit time window. Expands recurring events into instances, ordered by start time.',
    { calendarId, timeMin: timestamp, timeMax: timestamp, q: z.string().min(1).max(1000).optional(), ...page },
    async ({ pageSize, ...input }) => {
      checkRange(input.timeMin, input.timeMax);
      return bounded(
        await apiCall(() =>
          api.events.list({
            ...input,
            maxResults: pageSize,
            singleEvents: true,
            orderBy: 'startTime',
            showDeleted: false,
          }),
        ),
      );
    },
  );
  register(
    server,
    'calendar_get_event',
    'Read an event and its etag for a later guarded edit.',
    { calendarId, eventId: id },
    async (input) => bounded(await apiCall(() => api.events.get(input))),
  );
  register(
    server,
    'calendar_freebusy',
    'Read busy intervals for up to 50 calendars. Per-calendar/group errors mean availability is unknown, not free.',
    { calendarIds: z.array(calendarId).min(1).max(50), timeMin: timestamp, timeMax: timestamp },
    async ({ calendarIds, timeMin, timeMax }) => {
      checkRange(timeMin, timeMax);
      return bounded(
        await apiCall(() =>
          api.freebusy.query({
            requestBody: { timeMin, timeMax, items: calendarIds.map((id) => ({ id })), calendarExpansionMax: 50 },
          }),
        ),
      );
    },
  );
  register(
    server,
    'calendar_create_event',
    'Create a single timed or all-day event. May invite attendees. Preview with dryRun; save the returned ID before retrying an ambiguous failure.',
    { ...write, ...fields, attendees: z.array(z.email().max(254)).max(100).optional() },
    async ({ calendarId, sendUpdates, dryRun, start, end, attendees, ...fields }) => {
      const requestBody = bounded({
        ...fields,
        ...times(start, end),
        attendees: attendees?.map((email) => ({ email })),
      });
      if (dryRun) return { dryRun, calendarId, sendUpdates, requestBody };
      return bounded(await apiCall(() => api.events.insert({ calendarId, sendUpdates, requestBody }), false));
    },
    { readOnly: false, idempotent: false },
  );
  register(
    server,
    'calendar_update_event',
    'Patch title, description, location or both times with etag protection. Supports single events and recurring instances, not whole series. Preview then pass expectedEtag.',
    {
      ...write,
      eventId: id,
      summary: fields.summary.optional(),
      description: fields.description,
      location: fields.location,
      start: eventTime.optional(),
      end: eventTime.optional(),
      expectedEtag: z.string().min(1).max(1024).optional(),
    },
    async ({ calendarId, eventId, sendUpdates, dryRun, expectedEtag, start, end, ...fields }) => {
      const requestBody: calendar_v3.Schema$Event = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      if (start || end) {
        if (!start || !end) throw new UserError('Supply both start and end when changing event times.');
        Object.assign(requestBody, times(start, end));
      }
      if (!Object.keys(requestBody).length) throw new UserError('Supply at least one event field to update.');
      bounded(requestBody);
      const current = await apiCall(() => api.events.get({ calendarId, eventId }));
      if (
        current.status === 'cancelled' ||
        current.recurrence?.length ||
        (current.eventType && current.eventType !== 'default')
      )
        throw new UserError(
          'Only active ordinary single events or recurring instances can be edited. Select an instance from calendar_list_events.',
        );
      const etag = requireValue(current.etag, 'Google returned no etag. Cannot safely edit.');
      if (expectedEtag && expectedEtag !== etag)
        throw new UserError('Event changed. Read and preview the event again.');
      if (dryRun) return { dryRun, calendarId, eventId, sendUpdates, expectedEtag: etag, requestBody };
      return bounded(
        await apiCall(
          () => api.events.patch({ calendarId, eventId, sendUpdates, requestBody }, { headers: { 'If-Match': etag } }),
          false,
        ),
      );
    },
    { readOnly: false, destructive: true, idempotent: false },
  );
}
