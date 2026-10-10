import { Readable } from 'node:stream';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkServices } from '../scripts/doctor.js';
import { readConfig } from '../src/config.js';
import type { Clients } from '../src/google/client.js';
import { createServer } from '../src/server.js';
import { MAX_TEXT_BYTES } from '../src/tools/register.js';

const tasks = { tasklists: { list: vi.fn() }, tasks: { list: vi.fn(), insert: vi.fn(), get: vi.fn(), patch: vi.fn() } };
const drive = { files: { get: vi.fn(), export: vi.fn(), list: vi.fn() }, permissions: { list: vi.fn() } };
const sheets = {
  spreadsheets: { get: vi.fn(), create: vi.fn(), values: { get: vi.fn(), update: vi.fn(), append: vi.fn() } },
};
const docs = { documents: { get: vi.fn(), create: vi.fn(), batchUpdate: vi.fn() } };
const meet = { conferenceRecords: { list: vi.fn(), transcripts: { list: vi.fn(), entries: { list: vi.fn() } } } };
const apis = { tasks, drive, sheets, docs, meet, forms: {} } as unknown as Clients;
let client: Client;
const connections: Client[] = [];
async function connect(env: NodeJS.ProcessEnv) {
  const server = createServer(readConfig(env), apis);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workspace-tests', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  connections.push(client);
  return client;
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content?.[0];
  if (content?.type !== 'text') throw new Error('Expected JSON text result');
  return JSON.parse(content.text);
}
async function failure(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}
function tab(tabId: string, content = 'Text\n') {
  return {
    tabProperties: { tabId, title: tabId },
    documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content } }] } }] } },
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  tasks.tasks.get.mockResolvedValue({ data: { id: 'task' } });
  tasks.tasks.patch.mockResolvedValue({ data: { id: 'task' } });
  sheets.spreadsheets.values.update.mockResolvedValue({ data: { updatedRange: 'Data!A1:B1' } });
  sheets.spreadsheets.values.append.mockResolvedValue({
    data: { updates: { updatedRange: 'Data!A15:B15', updatedRows: 1 } },
  });
  docs.documents.get.mockResolvedValue({
    data: { documentId: 'doc', title: 'Report', revisionId: 'rev1', tabs: [tab('first')] },
  });
  docs.documents.batchUpdate.mockResolvedValue({ data: { replies: [] } });
  drive.files.get.mockResolvedValue({
    data: { id: 'file', mimeType: 'text/plain', capabilities: { canDownload: true } },
  });
  client = await connect({
    GOOGLE_MCP_SERVICES: 'forms,drive,tasks,sheets,docs,meet',
    GOOGLE_MCP_DRIVE_ATTACHMENTS: 'true',
  });
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
});

describe('service discovery and diagnostics', () => {
  it.each([
    ['tasks', 4],
    ['sheets', 5],
    ['docs', 4],
    ['meet', 3],
    ['drive', 4],
  ] as const)('registers only %s when selected', async (service, count) => {
    const selected = await connect({ GOOGLE_MCP_SERVICES: service });
    const { tools } = await selected.listTools();
    expect(tools).toHaveLength(count);
    expect(tools.every((tool) => tool.name.startsWith(`${service}_`))).toBe(true);
  });
  it('exposes all 31 tools and conservative write annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(31);
    for (const name of [
      'tasks_create_task',
      'sheets_create',
      'sheets_append_rows',
      'docs_create',
      'docs_append_text',
      'docs_replace_text',
      'sheets_write_range',
    ]) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
    }
    expect(tools.filter((tool) => tool.name.startsWith('meet_')).every((tool) => tool.annotations?.readOnlyHint)).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === 'forms_update')?.annotations?.idempotentHint).toBe(true);
  });
  it('checks cheap reads and reports services without selected resources as untested', async () => {
    tasks.tasklists.list.mockResolvedValue({ data: { items: [] } });
    meet.conferenceRecords.list.mockResolvedValue({ data: {} });
    drive.files.list.mockResolvedValue({ data: {} });
    const report = vi.fn();
    await checkServices(
      readConfig({ GOOGLE_MCP_SERVICES: 'drive,tasks,sheets,docs,meet', GOOGLE_MCP_DRIVE_ATTACHMENTS: 'true' }),
      apis,
      {},
      report,
    );
    expect(tasks.tasklists.list).toHaveBeenCalledWith({ maxResults: 1 });
    expect(meet.conferenceRecords.list).toHaveBeenCalledWith({ pageSize: 1 });
    expect(report.mock.calls.flat().join(' ')).toMatch(/Sheets connectivity untested/);
    expect(report.mock.calls.flat().join(' ')).toMatch(/Docs connectivity untested/);
    expect(report.mock.calls.flat().join(' ')).toMatch(/Drive content download untested/);
    expect(sheets.spreadsheets.get).not.toHaveBeenCalled();
    expect(docs.documents.get).not.toHaveBeenCalled();
  });
  it('uses known resource IDs for Sheets and Docs diagnostic reads', async () => {
    sheets.spreadsheets.get.mockResolvedValue({ data: { spreadsheetId: 'sheet' } });
    await checkServices(
      readConfig({ GOOGLE_MCP_SERVICES: 'sheets,docs' }),
      apis,
      { GOOGLE_MCP_TEST_SPREADSHEET_ID: 'sheet', GOOGLE_MCP_TEST_DOCUMENT_ID: 'doc' },
      vi.fn(),
    );
    expect(sheets.spreadsheets.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: 'sheet', includeGridData: false }),
    );
    expect(docs.documents.get).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc', includeTabsContent: true }),
    );
  });
});

describe('Tasks', () => {
  it('preserves task-list and task pagination and explicit filters including @default', async () => {
    tasks.tasklists.list.mockResolvedValue({ data: { items: [{ id: 'list' }], nextPageToken: 'next' } });
    expect(await call('tasks_list_tasklists', { pageSize: 7, pageToken: 'previous' })).toHaveProperty(
      'nextPageToken',
      'next',
    );
    expect(tasks.tasklists.list).toHaveBeenCalledWith({ maxResults: 7, pageToken: 'previous' });
    tasks.tasks.list.mockResolvedValue({ data: { items: [], nextPageToken: 'next' } });
    await call('tasks_list_tasks', {
      tasklist: '@default',
      pageToken: 'previous',
      showCompleted: true,
      showHidden: true,
      showAssigned: true,
    });
    expect(tasks.tasks.list).toHaveBeenCalledWith({
      tasklist: '@default',
      pageToken: 'previous',
      maxResults: 100,
      showCompleted: true,
      showHidden: true,
      showAssigned: true,
      showDeleted: false,
    });
    await call('tasks_list_tasks', { tasklist: 'list' });
    expect(tasks.tasks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ showCompleted: false, showHidden: false, showAssigned: false }),
    );
  });
  it('creates scheduled dates at midnight and never retries an ambiguous create failure', async () => {
    tasks.tasks.insert.mockResolvedValueOnce({ data: { id: 'new' } }).mockRejectedValue({ response: { status: 503 } });
    await call('tasks_create_task', { tasklist: '@default', title: 'Review', scheduledDate: '2028-02-29' });
    expect(tasks.tasks.insert).toHaveBeenCalledWith({
      tasklist: '@default',
      requestBody: { title: 'Review', notes: undefined, due: '2028-02-29T00:00:00.000Z' },
    });
    expect(await failure('tasks_create_task', { tasklist: '@default', title: 'Review' })).toContain(
      'may have succeeded',
    );
    expect(tasks.tasks.insert).toHaveBeenCalledTimes(2);
  });
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-10T12:00:00Z'])(
    'rejects invalid scheduled date %s before writes',
    async (scheduledDate) => {
      await failure('tasks_create_task', { tasklist: '@default', title: 'Review', scheduledDate });
      await failure('tasks_update_task', { tasklist: '@default', task: 'task', scheduledDate });
      expect(tasks.tasks.insert).not.toHaveBeenCalled();
      expect(tasks.tasks.patch).not.toHaveBeenCalled();
    },
  );
  it('patches supplied fields and clears the completion timestamp when reopening tasks', async () => {
    await call('tasks_update_task', { tasklist: '@default', task: 'task', status: 'completed' });
    expect(tasks.tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 'task',
      requestBody: { status: 'completed' },
    });
    await call('tasks_update_task', { tasklist: '@default', task: 'task', status: 'needsAction' });
    expect(tasks.tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 'task',
      requestBody: { status: 'needsAction', completed: null },
    });
    await call('tasks_update_task', { tasklist: '@default', task: 'task', status: 'needsAction', scheduledDate: null });
    expect(tasks.tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 'task',
      requestBody: { status: 'needsAction', completed: null, due: null },
    });
    expect(tasks.tasks.get).not.toHaveBeenCalled();
  });
  it('rejects empty patches, invalid status/URLs and notes for Docs assignments', async () => {
    await failure('tasks_update_task', { tasklist: '@default', task: 'task' });
    await failure('tasks_update_task', { tasklist: '@default', task: 'task', status: 'done' });
    await failure('tasks_update_task', { tasklist: 'https://invalid', task: 'task', title: 'Review' });
    tasks.tasks.get.mockResolvedValue({ data: { assignmentInfo: { surfaceType: 'DOCUMENT' } } });
    expect(await failure('tasks_update_task', { tasklist: '@default', task: 'task', notes: 'New notes' })).toContain(
      'assigned from Google Docs',
    );
    expect(tasks.tasks.patch).not.toHaveBeenCalled();
  });
  it('allows clearing personal notes and leaves other fields untouched', async () => {
    await call('tasks_update_task', { tasklist: '@default', task: 'task', notes: '' });
    expect(tasks.tasks.patch).toHaveBeenCalledWith({ tasklist: '@default', task: 'task', requestBody: { notes: '' } });
  });
});

describe('Drive text content', () => {
  it('reads UTF-8 text incrementally, including multibyte sequences across chunks', async () => {
    const bytes = Buffer.from('Hello 🌍');
    const stream = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
    drive.files.get
      .mockResolvedValueOnce({ data: { mimeType: 'text/plain', capabilities: { canDownload: true } } })
      .mockResolvedValueOnce({ data: stream });
    expect(await call('drive_read_text', { fileId: 'file' })).toMatchObject({
      text: 'Hello 🌍',
      format: 'text/plain',
      encoding: 'UTF-8',
      bytes: bytes.length,
    });
    expect(drive.files.get).toHaveBeenLastCalledWith(
      { fileId: 'file', alt: 'media', supportsAllDrives: true },
      expect.objectContaining({ responseType: 'stream', signal: expect.any(AbortSignal) }),
    );
    expect(stream.destroyed).toBe(true);
  });
  it.each(['document', 'presentation'])('exports native %s as plain text', async (kind) => {
    drive.files.get.mockResolvedValue({
      data: { mimeType: `application/vnd.google-apps.${kind}`, capabilities: { canDownload: true } },
    });
    drive.files.export.mockResolvedValue({ data: Readable.from([Buffer.from('Export')]) });
    expect(await call('drive_read_text', { fileId: 'file' })).toMatchObject({
      text: 'Export',
      format: 'text/plain',
      sourceMimeType: `application/vnd.google-apps.${kind}`,
    });
    expect(drive.files.export).toHaveBeenCalledWith(
      { fileId: 'file', mimeType: 'text/plain' },
      expect.objectContaining({ responseType: 'stream' }),
    );
  });
  it.each(['application/pdf', 'application/octet-stream', 'application/vnd.google-apps.spreadsheet'])(
    'reports unsupported %s without downloading',
    async (mimeType) => {
      drive.files.get.mockResolvedValue({ data: { mimeType, capabilities: { canDownload: true } } });
      expect(await call('drive_read_text', { fileId: 'file' })).toHaveProperty('supported', false);
      expect(drive.files.get).toHaveBeenCalledOnce();
      expect(drive.files.export).not.toHaveBeenCalled();
    },
  );
  it('rejects denied downloads and known oversized blobs before fetching content', async () => {
    drive.files.get
      .mockResolvedValueOnce({ data: { mimeType: 'text/plain', capabilities: { canDownload: false } } })
      .mockResolvedValueOnce({
        data: { mimeType: 'text/plain', size: String(MAX_TEXT_BYTES + 1), capabilities: { canDownload: true } },
      });
    expect(await failure('drive_read_text', { fileId: 'file' })).toContain('does not allow');
    expect(await failure('drive_read_text', { fileId: 'file' })).toContain('1 MiB');
    expect(drive.files.get).toHaveBeenCalledTimes(2);
  });
  it('aborts oversized streams without consuming the rest', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_TEXT_BYTES), Buffer.from('x'), Buffer.from('never needed')]);
    drive.files.get
      .mockResolvedValueOnce({ data: { mimeType: 'text/plain', capabilities: { canDownload: true } } })
      .mockResolvedValueOnce({ data: stream });
    expect(await failure('drive_read_text', { fileId: 'file' })).toContain('1 MiB');
    expect(stream.destroyed).toBe(true);
  });
  it('rejects invalid UTF-8 and JSON-escaped output exceeding the bound', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(MAX_TEXT_BYTES / 2, 0)]) {
      drive.files.get
        .mockResolvedValueOnce({ data: { mimeType: 'text/plain', capabilities: { canDownload: true } } })
        .mockResolvedValueOnce({ data: Readable.from([bytes]) });
      await failure('drive_read_text', { fileId: 'file' });
    }
  });
  it('sanitizes stream failures and closes the stream', async () => {
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from('Partial');
        throw new Error('private payload');
      })(),
    );
    drive.files.get
      .mockResolvedValueOnce({ data: { mimeType: 'text/plain', capabilities: { canDownload: true } } })
      .mockResolvedValueOnce({ data: stream });
    expect(await failure('drive_read_text', { fileId: 'file' })).not.toContain('private payload');
    expect(stream.destroyed).toBe(true);
  });
});

describe('Sheets', () => {
  it('returns multiple tab metadata without grid data', async () => {
    const data = {
      spreadsheetId: 'sheet',
      sheets: [{ properties: { title: 'First' } }, { properties: { title: 'Second' } }],
    };
    sheets.spreadsheets.get.mockResolvedValue({ data });
    expect(await call('sheets_get_spreadsheet', { spreadsheetId: 'sheet' })).toEqual(data);
    expect(sheets.spreadsheets.get).toHaveBeenCalledWith(
      expect.objectContaining({ includeGridData: false, fields: expect.stringContaining('sheets(properties)') }),
    );
  });
  it('reads an explicitly selected tab and preserves formulas when requested', async () => {
    sheets.spreadsheets.values.get.mockResolvedValue({
      data: { range: "'Second tab'!A1:B2", values: [[1, '=SUM(A1:A2)']] },
    });
    await call('sheets_read_range', {
      spreadsheetId: 'sheet',
      range: "'Second tab'!A1:B2",
      valueRenderOption: 'FORMULA',
    });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith(
      expect.objectContaining({ range: "'Second tab'!A1:B2", valueRenderOption: 'FORMULA', majorDimension: 'ROWS' }),
    );
  });
  it.each([
    'Data!A1:B5001',
    'A1:B2',
    'Data!A:B',
    'Data!B2:A1',
    'Data!A0',
    'Data!A1:A10000001',
    'Data!A1,Other!A1',
    'NamedRange',
  ])('rejects unbounded, invalid or oversized range %s before API access', async (range) => {
    await failure('sheets_read_range', { spreadsheetId: 'sheet', range });
    await failure('sheets_write_range', { spreadsheetId: 'sheet', range, values: [[1]] });
    expect(sheets.spreadsheets.values.get).not.toHaveBeenCalled();
    expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
  });
  it('allows exactly 10,000 cells and escaped tab names/absolute references', async () => {
    sheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [[1]] } });
    await call('sheets_read_range', { spreadsheetId: 'sheet', range: "'O''Brien'!$A$1:$B$5000" });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledOnce();
  });
  it('bounds returned cell counts and JSON payloads', async () => {
    sheets.spreadsheets.values.get
      .mockResolvedValueOnce({ data: { values: [[1, 2]] } })
      .mockResolvedValueOnce({ data: { values: [['x'.repeat(MAX_TEXT_BYTES)]] } });
    await failure('sheets_read_range', { spreadsheetId: 'sheet', range: 'Data!A1' });
    expect(await failure('sheets_read_range', { spreadsheetId: 'sheet', range: 'Data!A1' })).toContain('1 MiB');
  });
  it('previews target ranges and values without writing, and RAW preserves formula-like response strings', async () => {
    const input = { spreadsheetId: 'sheet', range: 'Data!A1:B1', values: [['=1+1', 2]] };
    expect(await call('sheets_write_range', { ...input, dryRun: true })).toMatchObject({
      dryRun: true,
      range: 'Data!A1:B1',
      valueInputOption: 'RAW',
      requestBody: { values: input.values },
    });
    expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
    await call('sheets_write_range', input);
    expect(sheets.spreadsheets.values.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        valueInputOption: 'RAW',
        requestBody: { majorDimension: 'ROWS', values: input.values },
      }),
    );
    await call('sheets_write_range', { ...input, valueInputOption: 'USER_ENTERED' });
    expect(sheets.spreadsheets.values.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ valueInputOption: 'USER_ENTERED' }),
    );
  });
  it('rejects ragged/mismatched matrices, non-finite values, cell and byte overflows before writes', async () => {
    for (const values of [
      [[1, 2], [3]],
      [[1]],
      [[Number.NaN, 1]],
      [['x'.repeat(MAX_TEXT_BYTES), 2]],
      Array.from({ length: 5001 }, () => [1, 2]),
    ]) {
      await failure('sheets_write_range', { spreadsheetId: 'sheet', range: 'Data!A1:B2', values });
    }
    expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
  });
  it('previews append without reserving a row and returns Google’s actual updated range', async () => {
    const input = { spreadsheetId: 'sheet', range: 'Data!A1:B100', values: [[1, 2]] };
    expect(await call('sheets_append_rows', { ...input, dryRun: true })).toHaveProperty(
      'placement',
      expect.stringContaining('not reserved'),
    );
    expect(sheets.spreadsheets.values.append).not.toHaveBeenCalled();
    expect(await call('sheets_append_rows', input)).toHaveProperty('updates.updatedRange', 'Data!A15:B15');
    expect(sheets.spreadsheets.values.append).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'Data!A1:B100', insertDataOption: 'INSERT_ROWS', valueInputOption: 'RAW' }),
    );
  });
  it('does not retry ambiguous append/create/update failures', async () => {
    sheets.spreadsheets.values.append.mockRejectedValue({ response: { status: 503 } });
    sheets.spreadsheets.values.update.mockRejectedValue({ response: { status: 503 } });
    sheets.spreadsheets.create.mockRejectedValue({ response: { status: 503 } });
    await failure('sheets_append_rows', { spreadsheetId: 'sheet', range: 'Data!A1:B100', values: [[1, 2]] });
    await failure('sheets_write_range', { spreadsheetId: 'sheet', range: 'Data!A1:B1', values: [[1, 2]] });
    await failure('sheets_create', { title: 'Report' });
    expect(sheets.spreadsheets.values.append).toHaveBeenCalledOnce();
    expect(sheets.spreadsheets.values.update).toHaveBeenCalledOnce();
    expect(sheets.spreadsheets.create).toHaveBeenCalledOnce();
  });
  it('creates a spreadsheet and returns its ID/link', async () => {
    sheets.spreadsheets.create.mockResolvedValue({
      data: { spreadsheetId: 'new', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new/edit' },
    });
    expect(await call('sheets_create', { title: 'Report' })).toHaveProperty('spreadsheetId', 'new');
    expect(sheets.spreadsheets.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { properties: { title: 'Report' } } }),
    );
  });
});

describe('Docs', () => {
  it('accepts dotted Google Docs tab IDs for reads and edits', async () => {
    docs.documents.get.mockResolvedValue({ data: { documentId: 'doc', revisionId: 'rev1', tabs: [tab('t.0')] } });
    expect((await call('docs_get', { documentId: 'doc', tabId: 't.0' })).tabs[0].tabId).toBe('t.0');
    await call('docs_append_text', { documentId: 'doc', tabId: 't.0', text: 'Notes' });
    expect(docs.documents.batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: {
          requests: [{ insertText: { text: 'Notes', endOfSegmentLocation: { tabId: 't.0' } } }],
          writeControl: { requiredRevisionId: 'rev1' },
        },
      }),
    );
  });
  it('reads nested tabs and table/TOC text within a shared character budget', async () => {
    const first = tab('first', 'Body\n');
    first.documentTab.body.content.push({
      table: {
        tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Cell\n' } }] } }] }] }],
      },
    } as never);
    first.documentTab.body.content.push({
      tableOfContents: { content: [{ paragraph: { elements: [{ textRun: { content: 'TOC\n' } }] } }] },
    } as never);
    docs.documents.get.mockResolvedValue({
      data: { documentId: 'doc', revisionId: 'rev1', tabs: [{ ...first, childTabs: [tab('nested', 'Nested\n')] }] },
    });
    const result = await call('docs_get', { documentId: 'doc', maxCharacters: 18 });
    expect(result.tabs).toEqual([
      expect.objectContaining({ tabId: 'first', text: 'Body\nCell\nTOC\n', truncated: false }),
      expect.objectContaining({ tabId: 'nested', text: 'Nest', truncated: true }),
    ]);
    expect(docs.documents.get).toHaveBeenCalledWith({ documentId: 'doc', includeTabsContent: true });
    expect((await call('docs_get', { documentId: 'doc', tabId: 'nested' })).tabs).toEqual([
      expect.objectContaining({ text: 'Nested\n' }),
    ]);
  });
  it('requires a selected tab for ambiguous edits and supports nested tab append previews', async () => {
    docs.documents.get.mockResolvedValue({
      data: { revisionId: 'rev1', tabs: [{ ...tab('first'), childTabs: [tab('nested')] }] },
    });
    expect(await failure('docs_append_text', { documentId: 'doc', text: 'Notes' })).toContain('Select a tabId');
    await failure('docs_replace_text', { documentId: 'doc', tabId: 'missing', searchText: 'A', replacementText: 'B' });
    const preview = await call('docs_append_text', { documentId: 'doc', tabId: 'nested', text: 'Notes', dryRun: true });
    expect(preview).toMatchObject({
      tabId: 'nested',
      writeControl: { requiredRevisionId: 'rev1' },
      requests: [{ insertText: { text: 'Notes', endOfSegmentLocation: { tabId: 'nested' } } }],
    });
    expect(docs.documents.batchUpdate).not.toHaveBeenCalled();
  });
  it('applies with the preview revision and rejects stale previews', async () => {
    const preview = await call('docs_append_text', { documentId: 'doc', text: 'Notes', dryRun: true });
    await call('docs_append_text', {
      documentId: 'doc',
      text: 'Notes',
      expectedRevisionId: preview.writeControl.requiredRevisionId,
    });
    expect(docs.documents.batchUpdate).toHaveBeenCalledWith({
      documentId: 'doc',
      requestBody: { requests: preview.requests, writeControl: { requiredRevisionId: 'rev1' } },
    });
    docs.documents.get.mockResolvedValue({ data: { revisionId: 'rev2', tabs: [tab('first')] } });
    expect(
      await failure('docs_append_text', { documentId: 'doc', text: 'Notes', expectedRevisionId: 'rev1' }),
    ).toContain('Document revision changed');
    expect(docs.documents.batchUpdate).toHaveBeenCalledOnce();
  });
  it('uses literal replacement scoped to one tab and preserves unrelated content', async () => {
    const preview = await call('docs_replace_text', {
      documentId: 'doc',
      searchText: '.*[a]',
      replacementText: '$1',
      dryRun: true,
    });
    expect(preview.requests).toEqual([
      {
        replaceAllText: {
          containsText: { text: '.*[a]', matchCase: true, searchByRegex: false },
          replaceText: '$1',
          tabsCriteria: { tabIds: ['first'] },
        },
      },
    ]);
    expect(docs.documents.batchUpdate).not.toHaveBeenCalled();
    await call('docs_replace_text', { documentId: 'doc', searchText: 'A', replacementText: '', matchCase: false });
    expect(docs.documents.batchUpdate).toHaveBeenCalledOnce();
  });
  it('rejects missing revisions and API conflicts without retrying', async () => {
    docs.documents.get.mockResolvedValueOnce({ data: { tabs: [tab('first')] } });
    expect(await failure('docs_append_text', { documentId: 'doc', text: 'Notes' })).toContain('no revision');
    docs.documents.batchUpdate.mockRejectedValue({ response: { status: 400 } });
    expect(
      await failure('docs_append_text', { documentId: 'doc', text: 'Notes', expectedRevisionId: 'rev1' }),
    ).toContain('conflict');
    expect(docs.documents.batchUpdate).toHaveBeenCalledOnce();
  });
  it('creates an empty document and never retries create or append failures', async () => {
    docs.documents.create
      .mockResolvedValueOnce({ data: { documentId: 'new' } })
      .mockRejectedValue({ response: { status: 503 } });
    expect(await call('docs_create', { title: 'Report' })).toHaveProperty(
      'webViewLink',
      'https://docs.google.com/document/d/new/edit',
    );
    await failure('docs_create', { title: 'Report' });
    expect(docs.documents.create).toHaveBeenCalledTimes(2);
    docs.documents.batchUpdate.mockRejectedValue({ response: { status: 503 } });
    await failure('docs_append_text', { documentId: 'doc', text: 'Notes' });
    expect(docs.documents.batchUpdate).toHaveBeenCalledOnce();
  });
});

describe('Meet transcripts', () => {
  it('preserves conference and transcript-entry pagination, speakers and timestamps', async () => {
    meet.conferenceRecords.list.mockResolvedValue({
      data: { conferenceRecords: [{ name: 'conferenceRecords/record' }], nextPageToken: 'next' },
    });
    expect(
      await call('meet_list_conferences', {
        pageSize: 5,
        pageToken: 'previous',
        filter: 'start_time > "2026-10-01T00:00:00Z"',
      }),
    ).toHaveProperty('nextPageToken', 'next');
    expect(meet.conferenceRecords.list).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 5, pageToken: 'previous' }),
    );
    const data = {
      transcriptEntries: [
        {
          participant: 'conferenceRecords/record/participants/person',
          text: 'Hello',
          startTime: '2026-10-10T09:00:00Z',
          endTime: '2026-10-10T09:00:01Z',
        },
      ],
      nextPageToken: 'next',
    };
    meet.conferenceRecords.transcripts.entries.list.mockResolvedValue({ data });
    expect(
      await call('meet_list_transcript_entries', {
        parent: 'conferenceRecords/record/transcripts/transcript',
        pageSize: 10,
        pageToken: 'previous',
      }),
    ).toEqual(data);
    expect(meet.conferenceRecords.transcripts.entries.list).toHaveBeenCalledWith({
      parent: 'conferenceRecords/record/transcripts/transcript',
      pageSize: 10,
      pageToken: 'previous',
    });
  });
  it('reports unavailable transcripts and preserves continuation for empty pages', async () => {
    meet.conferenceRecords.transcripts.list
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { nextPageToken: 'next' } });
    expect(await call('meet_list_transcripts', { parent: 'conferenceRecords/record' })).toMatchObject({
      unavailable: true,
      message: expect.stringContaining('No existing accessible transcripts'),
    });
    expect(
      await call('meet_list_transcripts', { parent: 'conferenceRecords/record', pageToken: 'previous' }),
    ).toMatchObject({ unavailable: false, nextPageToken: 'next' });
  });
  it('rejects malformed resource names before API access', async () => {
    for (const parent of [
      'record',
      'conferenceRecords/record/transcripts/transcript',
      'https://meet.google.com/abc',
      'conferenceRecords/../record',
    ])
      await failure('meet_list_transcripts', { parent });
    await failure('meet_list_transcript_entries', { parent: 'conferenceRecords/record' });
    expect(meet.conferenceRecords.transcripts.list).not.toHaveBeenCalled();
    expect(meet.conferenceRecords.transcripts.entries.list).not.toHaveBeenCalled();
  });
});
