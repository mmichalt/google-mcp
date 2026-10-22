import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkServices } from '../scripts/doctor.js';
import { readConfig } from '../src/config.js';
import type { Clients } from '../src/google/client.js';
import { createServer } from '../src/server.js';
import { MAX_TEXT_BYTES } from '../src/tools/register.js';

const calendar = {
  calendarList: { list: vi.fn() },
  events: { list: vi.fn(), get: vi.fn(), insert: vi.fn(), patch: vi.fn() },
  freebusy: { query: vi.fn() },
};
const gmail = {
  users: {
    getProfile: vi.fn(),
    messages: { list: vi.fn(), get: vi.fn(), send: vi.fn() },
    threads: { get: vi.fn() },
    drafts: { create: vi.fn() },
  },
};
const apis = { calendar, gmail } as unknown as Clients;
const connections: Client[] = [];
let client: Client;
async function connect(env: NodeJS.ProcessEnv = { GOOGLE_MCP_SERVICES: 'calendar,gmail' }) {
  const server = createServer(readConfig(env), apis);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const connection = new Client({ name: 'calendar-gmail-tests', version: '1.0.0' });
  await server.connect(b);
  await connection.connect(a);
  connections.push(connection);
  return connection;
}
async function call(name: string, args: Record<string, unknown>, failure = false) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError === true).toBe(failure);
  const content = result.content?.[0];
  if (content?.type !== 'text') throw new Error('Expected text result');
  return failure ? content.text : JSON.parse(content.text);
}
const window = { timeMin: '2026-10-22T00:00:00Z', timeMax: '2026-10-23T00:00:00Z' };
const event = {
  calendarId: 'primary',
  summary: 'Review',
  start: { dateTime: '2026-10-22T10:00:00+02:00' },
  end: { dateTime: '2026-10-22T11:00:00+02:00' },
  sendUpdates: 'none',
};
const mail = { to: ['reader@example.com'], subject: 'Résumé 🐈', body: 'Hello\nПривіт!' };
beforeEach(async () => {
  vi.resetAllMocks();
  calendar.events.get.mockResolvedValue({
    data: { id: 'event', etag: '"rev1"', attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }] },
  });
  calendar.events.insert.mockResolvedValue({ data: { id: 'new' } });
  calendar.events.patch.mockResolvedValue({ data: { id: 'event' } });
  gmail.users.getProfile.mockResolvedValue({ data: { emailAddress: 'sender@example.com' } });
  gmail.users.drafts.create.mockResolvedValue({ data: { id: 'draft', message: { id: 'message' } } });
  gmail.users.messages.send.mockResolvedValue({ data: { id: 'sent' } });
  client = await connect();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
});

describe('Calendar and Gmail registration', () => {
  it.each([
    ['calendar', 6],
    ['gmail', 4],
  ] as const)('registers only %s when selected', async (service, count) => {
    const selected = await connect({ GOOGLE_MCP_SERVICES: service });
    const { tools } = await selected.listTools();
    expect(tools).toHaveLength(count);
    expect(tools.every((tool) => tool.name.startsWith(`${service}_`))).toBe(true);
  });
  it('gates sending independently and marks writes as non-retriable', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(tools.some((tool) => tool.name === 'gmail_send_message')).toBe(false);
    await expect(
      client.callTool({ name: 'gmail_send_message', arguments: { ...mail, confirmSend: true } }),
    ).rejects.toThrow('not found');
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
    client = await connect({ GOOGLE_MCP_SERVICES: 'gmail', GOOGLE_MCP_GMAIL_SEND: 'true' });
    const enabled = (await client.listTools()).tools;
    expect(enabled).toHaveLength(5);
    for (const tool of [...tools, ...enabled].filter((tool) => /create|update|send/.test(tool.name)))
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });
  it('diagnoses both services using reads only', async () => {
    calendar.calendarList.list.mockResolvedValue({ data: {} });
    const report = vi.fn();
    await checkServices(readConfig({ GOOGLE_MCP_SERVICES: 'calendar,gmail' }), apis, {}, report);
    expect(calendar.calendarList.list).toHaveBeenCalledWith({ maxResults: 1 });
    expect(gmail.users.getProfile).toHaveBeenCalledWith({ userId: 'me' });
    expect(report.mock.calls.flat().join(' ')).toContain('sending untested');
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('Calendar', () => {
  it('paginates calendars and expands event instances in a bounded time window', async () => {
    calendar.calendarList.list.mockResolvedValue({ data: { items: [], nextPageToken: 'next' } });
    expect(await call('calendar_list_calendars', { pageSize: 3, pageToken: 'prior' })).toHaveProperty(
      'nextPageToken',
      'next',
    );
    expect(calendar.calendarList.list).toHaveBeenCalledWith({ maxResults: 3, pageToken: 'prior' });
    calendar.events.list.mockResolvedValue({ data: { items: [], nextPageToken: 'next' } });
    await call('calendar_list_events', {
      calendarId: 'en.usa#holiday@group.v.calendar.google.com',
      ...window,
      q: 'Review',
      pageSize: 5,
      pageToken: 'prior',
    });
    expect(calendar.events.list).toHaveBeenCalledWith({
      calendarId: 'en.usa#holiday@group.v.calendar.google.com',
      ...window,
      q: 'Review',
      maxResults: 5,
      pageToken: 'prior',
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
    });
    expect(await call('calendar_get_event', { calendarId: 'primary', eventId: 'event' })).toHaveProperty(
      'etag',
      '"rev1"',
    );
  });
  it('preserves per-calendar availability errors', async () => {
    const data = {
      calendars: {
        private: { errors: [{ reason: 'notFound' }] },
        primary: { busy: [{ start: window.timeMin, end: window.timeMax }] },
      },
    };
    calendar.freebusy.query.mockResolvedValue({ data });
    expect(await call('calendar_freebusy', { calendarIds: ['primary', 'private'], ...window })).toEqual(data);
    expect(calendar.freebusy.query).toHaveBeenCalledWith({
      requestBody: { ...window, items: [{ id: 'primary' }, { id: 'private' }], calendarExpansionMax: 50 },
    });
  });
  it('previews and creates single events with explicit notification policy', async () => {
    const preview = await call('calendar_create_event', { ...event, attendees: ['guest@example.com'], dryRun: true });
    expect(preview.requestBody).toMatchObject({
      summary: 'Review',
      attendees: [{ email: 'guest@example.com' }],
      start: { dateTime: event.start.dateTime },
    });
    expect(calendar.events.insert).not.toHaveBeenCalled();
    await call('calendar_create_event', { ...event, start: { date: '2026-10-22' }, end: { date: '2026-10-23' } });
    expect(calendar.events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ start: { date: '2026-10-22', dateTime: null, timeZone: null } }),
      }),
    );
  });
  it.each([
    { start: { date: '2026-02-30' }, end: { date: '2026-03-01' } },
    { end: event.start },
    { start: { date: '2026-10-22' } },
    { start: { dateTime: '2026-10-22T10:00:00' } },
    { start: { dateTime: event.start.dateTime, timeZone: 'Not/AZone' } },
    { calendarId: 'https://calendar.google.com/' },
    { sendUpdates: undefined },
  ])('rejects invalid event input before Google calls: %j', async (invalid) => {
    await call('calendar_create_event', { ...event, ...invalid }, true);
    expect(calendar.events.insert).not.toHaveBeenCalled();
  });
  it('rejects reversed read windows and excessive free/busy requests', async () => {
    await call(
      'calendar_list_events',
      { calendarId: 'primary', timeMin: window.timeMax, timeMax: window.timeMin },
      true,
    );
    await call('calendar_freebusy', { ...window, calendarIds: Array(51).fill('primary') }, true);
    expect(calendar.events.list).not.toHaveBeenCalled();
    expect(calendar.freebusy.query).not.toHaveBeenCalled();
  });
  it('guards sparse patches with the fetched etag and refuses stale previews', async () => {
    const edit = { calendarId: 'primary', eventId: 'event', summary: 'New title', sendUpdates: 'all' };
    expect(await call('calendar_update_event', { ...edit, dryRun: true })).toHaveProperty('expectedEtag', '"rev1"');
    expect(calendar.events.patch).not.toHaveBeenCalled();
    await call('calendar_update_event', { ...edit, expectedEtag: '"old"' }, true);
    expect(calendar.events.patch).not.toHaveBeenCalled();
    await call('calendar_update_event', { ...edit, expectedEtag: '"rev1"' });
    expect(calendar.events.patch).toHaveBeenCalledWith(
      { calendarId: 'primary', eventId: 'event', sendUpdates: 'all', requestBody: { summary: 'New title' } },
      { headers: { 'If-Match': '"rev1"' } },
    );
    calendar.events.patch.mockRejectedValue({ response: { status: 412 } });
    expect(await call('calendar_update_event', edit, true)).toContain('conflict');
    expect(calendar.events.patch).toHaveBeenCalledTimes(2);
  });
  it('clears the old time representation when converting an all-day event', async () => {
    await call('calendar_update_event', { ...event, eventId: 'event' });
    expect(calendar.events.patch.mock.calls[0]?.[0].requestBody.start).toEqual({
      date: null,
      dateTime: event.start.dateTime,
      timeZone: null,
    });
  });
  it.each([
    { recurrence: ['RRULE:FREQ=DAILY'] },
    { status: 'cancelled' },
    { eventType: 'outOfOffice' },
    { etag: undefined },
  ])('refuses unsafe target %j', async (target) => {
    calendar.events.get.mockResolvedValue({ data: { etag: '"rev1"', ...target } });
    await call(
      'calendar_update_event',
      { calendarId: 'primary', eventId: 'event', summary: 'Change', sendUpdates: 'none' },
      true,
    );
    expect(calendar.events.patch).not.toHaveBeenCalled();
  });
  it('rejects empty and partial time patches before fetching the event', async () => {
    const edit = { calendarId: 'primary', eventId: 'event', sendUpdates: 'none' };
    await call('calendar_update_event', edit, true);
    await call('calendar_update_event', { ...edit, start: event.start }, true);
    expect(calendar.events.get).not.toHaveBeenCalled();
  });
  it('bounds calendar results and never retries ambiguous writes', async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [{ description: 'x'.repeat(MAX_TEXT_BYTES) }] } });
    expect(await call('calendar_list_events', { ...window, calendarId: 'primary' }, true)).toContain('1 MiB');
    calendar.events.insert.mockRejectedValue({ response: { status: 503 } });
    await call('calendar_create_event', event, true);
    expect(calendar.events.insert).toHaveBeenCalledOnce();
    calendar.events.patch.mockRejectedValue({ response: { status: 503 } });
    await call('calendar_update_event', { ...event, eventId: 'event' }, true);
    expect(calendar.events.patch).toHaveBeenCalledOnce();
  });
});

describe('Gmail', () => {
  it('passes Gmail queries and pagination without changing mailbox state', async () => {
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'msg' }], nextPageToken: 'next' } });
    expect(
      await call('gmail_list_messages', { q: 'from:sender@example.com is:unread', pageSize: 4, pageToken: 'prior' }),
    ).toHaveProperty('nextPageToken', 'next');
    expect(gmail.users.messages.list).toHaveBeenCalledWith({
      userId: 'me',
      q: 'from:sender@example.com is:unread',
      maxResults: 4,
      pageToken: 'prior',
      includeSpamTrash: false,
    });
  });
  it('decodes nested MIME text with its charset and omits attachment bytes', async () => {
    const data = {
      id: 'msg',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: Buffer.from('Привіт').toString('base64url') } },
              {
                mimeType: 'text/html',
                headers: [{ name: 'Content-Type', value: 'text/html; charset="iso-8859-1"' }],
                body: { data: Buffer.from('<b>café</b>', 'latin1').toString('base64url') },
              },
            ],
          },
          {
            mimeType: 'text/plain',
            filename: 'private.txt',
            body: { data: Buffer.from('attachment-secret').toString('base64url'), attachmentId: 'att', size: 17 },
          },
          { mimeType: 'text/plain', body: { attachmentId: 'external-body', size: 500 } },
        ],
      },
    };
    gmail.users.messages.get.mockResolvedValue({ data });
    const result = await call('gmail_get_message', { messageId: 'msg' });
    expect(result.payload.parts[0].parts[0].text).toBe('Привіт');
    expect(result.payload.parts[0].parts[1].text).toBe('<b>café</b>');
    expect(result.payload.parts[1].body).toEqual({ attachmentId: 'att', size: 17 });
    expect(result.payload.parts[2].body.attachmentId).toBe('external-body');
    expect(JSON.stringify(result)).not.toContain('attachment-secret');
    expect(gmail.users.messages.get).toHaveBeenCalledWith(
      { userId: 'me', id: 'msg', format: 'full' },
      { maxContentLength: MAX_TEXT_BYTES },
    );
    gmail.users.threads.get.mockResolvedValue({ data: { id: 'thread', messages: [data] } });
    expect((await call('gmail_get_thread', { threadId: 'thread' })).messages[0]).toEqual(result);
  });
  it.each(['text/plain', 'text/html', 'multipart/alternative'])(
    'keeps unnamed %s attachments metadata-only in messages and threads',
    async (mimeType) => {
      const secret = 'attachment-secret';
      const encoded = Buffer.from(secret).toString('base64url');
      const data = {
        id: 'msg',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Disposition', value: 'inline' }],
              body: { data: Buffer.from('Message body').toString('base64url') },
            },
            ...['attachment', '  AtTaChMeNt \t; creation-date="today"'].map((disposition) => ({
              mimeType,
              filename: '',
              headers: [{ name: 'cOnTeNt-DiSpOsItIoN', value: disposition }],
              body: { data: encoded, size: secret.length, attachmentId: 'att' },
              parts:
                mimeType === 'multipart/alternative'
                  ? [{ mimeType: 'text/plain', body: { data: encoded, size: secret.length } }]
                  : undefined,
            })),
          ],
        },
      };
      gmail.users.messages.get.mockResolvedValue({ data });
      const result = await call('gmail_get_message', { messageId: 'msg' });
      expect(result.payload.parts[0].text).toBe('Message body');
      for (const part of result.payload.parts.slice(1)) {
        expect(part.text).toBeUndefined();
        expect(part.body).toEqual({ size: secret.length, attachmentId: 'att' });
        expect(part.parts?.[0]?.text).toBeUndefined();
      }
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(encoded);
      gmail.users.threads.get.mockResolvedValue({ data: { id: 'thread', messages: [data] } });
      expect((await call('gmail_get_thread', { threadId: 'thread' })).messages[0]).toEqual(result);
    },
  );
  it('rejects unsupported text encoding and oversized output', async () => {
    gmail.users.messages.get.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset=invalid' }],
          body: { data: 'aGk' },
        },
      },
    });
    expect(await call('gmail_get_message', { messageId: 'msg' }, true)).toContain('unsupported charset');
    gmail.users.threads.get.mockResolvedValue({ data: { messages: [{ snippet: 'x'.repeat(MAX_TEXT_BYTES) }] } });
    expect(await call('gmail_get_thread', { threadId: 'thread' }, true)).toContain('1 MiB');
  });
  it('previews drafts and encodes Unicode headers and body as valid folded MIME', async () => {
    const input = { ...mail, subject: 'Привіт 🐈 '.repeat(15) };
    expect(await call('gmail_create_draft', { ...input, dryRun: true })).toMatchObject({
      from: 'sender@example.com',
      to: mail.to,
      body: mail.body,
    });
    expect(gmail.users.drafts.create).not.toHaveBeenCalled();
    await call('gmail_create_draft', input);
    const raw = gmail.users.drafts.create.mock.calls[0]?.[0].requestBody.message.raw;
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    const [headers = '', encodedBody = ''] = mime.split('\r\n\r\n');
    expect(headers).toContain('From: sender@example.com\r\nTo: reader@example.com');
    const subject = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map((match) => Buffer.from(match[1] ?? '', 'base64').toString('utf8'))
      .join('');
    expect(subject).toBe(input.subject);
    expect(mime.split('\r\n').every((line) => line.length < 998)).toBe(true);
    expect(Buffer.from(encodedBody, 'base64').toString('utf8')).toBe('Hello\r\nПривіт!');
  });
  it.each([
    { to: ['reader@example.com\r\nBcc: thief@example.com'] },
    { to: ['Name <reader@example.com>'] },
    { subject: 'Title\r\nBcc: thief@example.com' },
    { subject: 'Title\u0000' },
    { to: [] },
  ])('blocks malformed mail and header injection before API calls: %j', async (invalid) => {
    await call('gmail_create_draft', { ...mail, ...invalid }, true);
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
    expect(gmail.users.drafts.create).not.toHaveBeenCalled();
  });
  it('rejects an invalid sender address returned by Google', async () => {
    gmail.users.getProfile.mockResolvedValue({
      data: { emailAddress: 'sender@example.com\r\nBcc: thief@example.com' },
    });
    await call('gmail_create_draft', mail, true);
    expect(gmail.users.drafts.create).not.toHaveBeenCalled();
  });
  it('requires explicit sending confirmation, supports previews and sends only once', async () => {
    client = await connect({ GOOGLE_MCP_SERVICES: 'gmail', GOOGLE_MCP_GMAIL_SEND: 'true' });
    await call('gmail_send_message', mail, true);
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
    await call('gmail_send_message', { ...mail, confirmSend: true, dryRun: true });
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
    await call('gmail_send_message', { ...mail, confirmSend: true });
    expect(gmail.users.messages.send).toHaveBeenCalledOnce();
    gmail.users.messages.send.mockRejectedValue({ response: { status: 503 } });
    expect(await call('gmail_send_message', { ...mail, confirmSend: true }, true)).toContain('may have succeeded');
    expect(gmail.users.messages.send).toHaveBeenCalledTimes(2);
    gmail.users.drafts.create.mockRejectedValue({ response: { status: 503 } });
    await call('gmail_create_draft', mail, true);
    expect(gmail.users.drafts.create).toHaveBeenCalledOnce();
  });
});
