import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import type { Clients } from '../src/google/client.js';
import { createServer } from '../src/server.js';

let client: Client;
const forms = {
  get: vi.fn(),
  create: vi.fn(),
  batchUpdate: vi.fn(),
  setPublishSettings: vi.fn(),
  responses: { list: vi.fn(), get: vi.fn() },
};
const drive = { files: { list: vi.fn(), get: vi.fn() }, permissions: { list: vi.fn() } };
const upload = {
  itemId: 'upload',
  title: 'Attachment',
  questionItem: { question: { questionId: 'upload-q', fileUploadQuestion: { folderId: 'folder', maxFiles: 3 } } },
};
const question = {
  itemId: 'name',
  title: 'Name',
  description: 'Keep me',
  questionItem: {
    image: { altText: 'Keep image' },
    question: { questionId: 'name-q', textQuestion: {}, grading: { pointValue: 2 } },
  },
};
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content?.[0];
  if (content?.type !== 'text') throw new Error('Expected text result');
  return { error: result.isError, data: JSON.parse(content.text) as Record<string, unknown> };
}
async function failure(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}
beforeEach(async () => {
  vi.resetAllMocks();
  forms.get.mockResolvedValue({
    data: {
      formId: 'form',
      revisionId: 'rev1',
      items: [upload, question],
      publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
    },
  });
  forms.batchUpdate.mockResolvedValue({ data: { replies: [] } });
  const server = createServer(readConfig({}), { forms: { forms }, drive } as unknown as Clients);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'tests', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
});

describe('MCP Google tools', () => {
  it('discovers all 14 tools with appropriate annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    expect(tools.find((t) => t.name === 'forms_create')?.annotations?.idempotentHint).toBe(false);
    expect(tools.find((t) => t.name === 'forms_delete_question')?.annotations?.destructiveHint).toBe(true);
  });
  it('creates unpublished forms using only supported initial metadata', async () => {
    forms.create.mockResolvedValue({ data: { formId: 'new' } });
    expect((await call('forms_create', { title: 'Survey' })).data.formId).toBe('new');
    expect(forms.create).toHaveBeenCalledWith({
      unpublished: true,
      requestBody: { info: { title: 'Survey', documentTitle: undefined } },
    });
  });
  it('updates only supplied metadata with a revision guard', async () => {
    await call('forms_update', { formId: 'form', description: 'New' });
    expect(forms.batchUpdate).toHaveBeenCalledWith({
      formId: 'form',
      requestBody: {
        requests: [{ updateFormInfo: { info: { title: undefined, description: 'New' }, updateMask: 'description' } }],
        writeControl: { requiredRevisionId: 'rev1' },
      },
    });
  });
  it('rejects stale revisions and empty metadata changes', async () => {
    expect(await failure('forms_update', { formId: 'form', title: 'New', expectedRevisionId: 'old' })).toContain(
      'revision changed',
    );
    expect(await failure('forms_update', { formId: 'form' })).toContain('Provide title');
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it('previews without writing and returns the revision needed to apply', async () => {
    const result = await call('forms_add_question', {
      formId: 'form',
      itemId: 'stable',
      question: { type: 'short_text', title: 'Name' },
      dryRun: true,
    });
    expect(result.data.dryRun).toBe(true);
    expect(result.data.writeControl).toEqual({ requiredRevisionId: 'rev1' });
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'short_text', title: 'Q' },
    { type: 'paragraph', title: 'Q' },
    { type: 'multiple_choice', title: 'Q', options: ['A', 'B'] },
    { type: 'checkboxes', title: 'Q', options: ['A', 'B'] },
    { type: 'dropdown', title: 'Q', options: ['A', 'B'] },
    { type: 'linear_scale', title: 'Q', high: 5 },
    { type: 'date', title: 'Q' },
    { type: 'time', title: 'Q' },
  ])('adds a supported $type question at a resolved index', async (input) => {
    await call('forms_add_question', { formId: 'form', itemId: 'stable', question: input });
    const request = forms.batchUpdate.mock.calls[0]?.[0];
    expect(request.requestBody.requests[0].createItem.location.index).toBe(2);
    expect(request.requestBody.requests[0].createItem.item.itemId).toBe('stable');
  });
  it('repeated adds do not duplicate existing items', async () => {
    const result = await call('forms_add_question', {
      formId: 'form',
      itemId: 'name',
      question: { type: 'short_text', title: 'Name' },
    });
    expect(result.data.unchanged).toBe(true);
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it('updates a question preserving its IDs, grading, image, description and unrelated uploads', async () => {
    await call('forms_update_question', {
      formId: 'form',
      itemId: 'name',
      question: { type: 'paragraph', title: 'Full name', required: true },
    });
    const request = forms.batchUpdate.mock.calls[0]?.[0].requestBody.requests[0].updateItem;
    expect(request.item.description).toBe('Keep me');
    expect(request.item.questionItem.image).toEqual(question.questionItem.image);
    expect(request.item.questionItem.question).toMatchObject({
      questionId: 'name-q',
      grading: { pointValue: 2 },
      textQuestion: { paragraph: true },
    });
    expect(request.location.index).toBe(1);
    expect(request.updateMask).not.toContain('grading');
    expect(request.item.itemId).toBe('name');
    expect(upload.questionItem.question.fileUploadQuestion.maxFiles).toBe(3);
  });
  it('requires explicit type-change consent', async () => {
    forms.get.mockResolvedValue({
      data: {
        revisionId: 'rev1',
        items: [{ ...question, questionItem: { question: { textQuestion: {} } } }],
      },
    });
    expect(
      await failure('forms_update_question', {
        formId: 'form',
        itemId: 'name',
        question: { type: 'time', title: 'Q' },
      }),
    ).toContain('allowTypeChange');
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it('preserves existing upload questions and returns manual instructions', async () => {
    const result = await call('forms_get', { formId: 'form' });
    expect(result.data.items).toContainEqual(upload);
    expect(
      await failure('forms_update_question', {
        formId: 'form',
        itemId: 'upload',
        question: { type: 'short_text', title: 'Q' },
      }),
    ).toContain('manually');
    expect(await failure('forms_delete_question', { formId: 'form', itemId: 'upload', confirmDelete: true })).toContain(
      'file uploads',
    );
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it('deletes only the resolved item and repeated deletion is a no-op', async () => {
    await call('forms_delete_question', { formId: 'form', itemId: 'name', confirmDelete: true });
    expect(forms.batchUpdate.mock.calls[0]?.[0].requestBody.requests).toEqual([
      { deleteItem: { location: { index: 1 } } },
    ]);
    forms.batchUpdate.mockClear();
    expect(
      (await call('forms_delete_question', { formId: 'form', itemId: 'missing', confirmDelete: true })).data.unchanged,
    ).toBe(true);
    expect(forms.batchUpdate).not.toHaveBeenCalled();
  });
  it('paginates responses without dropping uploaded-file references', async () => {
    const responses = [
      { responseId: 'r1', answers: { q: { fileUploadAnswers: { answers: [{ fileId: 'attachment' }] } } } },
    ];
    forms.responses.list.mockResolvedValue({ data: { responses, nextPageToken: 'next' } });
    const result = await call('forms_list_responses', {
      formId: 'form',
      pageToken: 'prior',
      pageSize: 20,
      filter: 'timestamp > 2026-01-01T00:00:00Z',
    });
    expect(result.data).toEqual({ responses, nextPageToken: 'next' });
    expect(forms.responses.list).toHaveBeenCalledWith({
      formId: 'form',
      pageToken: 'prior',
      pageSize: 20,
      filter: 'timestamp > 2026-01-01T00:00:00Z',
    });
    forms.responses.get.mockResolvedValue({ data: responses[0] });
    expect((await call('forms_get_response', { formId: 'form', responseId: 'r1' })).data.responseId).toBe('r1');
  });
  it('reads and sets publication status through the supported API', async () => {
    expect((await call('forms_get_publish_status', { formId: 'form' })).data.supported).toBe(true);
    forms.setPublishSettings.mockResolvedValue({ data: { formId: 'form' } });
    await call('forms_publish', { formId: 'form', isPublished: false, isAcceptingResponses: false });
    expect(forms.setPublishSettings).toHaveBeenCalledWith({
      formId: 'form',
      requestBody: {
        publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } },
        updateMask: 'publishState',
      },
    });
    expect(
      await failure('forms_publish', { formId: 'form', isPublished: false, isAcceptingResponses: true }),
    ).toContain('cannot accept');
  });
  it('reports unsupported legacy publication and supports a publish preview', async () => {
    await call('forms_publish', { formId: 'form', isPublished: true, isAcceptingResponses: true, dryRun: true });
    expect(forms.setPublishSettings).not.toHaveBeenCalled();
    forms.get.mockResolvedValue({ data: { formId: 'legacy' } });
    expect((await call('forms_get_publish_status', { formId: 'legacy' })).data.supported).toBe(false);
    expect(
      await failure('forms_publish', { formId: 'legacy', isPublished: true, isAcceptingResponses: true }),
    ).toContain('legacy');
  });
  it('discovers forms through Drive search and preserves pagination', async () => {
    drive.files.list.mockResolvedValue({ data: { files: [{ id: 'form' }], nextPageToken: 'next' } });
    const result = await call('drive_list_files', {
      formsOnly: true,
      q: "name contains 'Survey'",
      pageToken: 'previous',
    });
    expect(result.data.nextPageToken).toBe('next');
    expect(drive.files.list.mock.calls[0]?.[0]).toMatchObject({
      q: "(name contains 'Survey') and mimeType = 'application/vnd.google-apps.form' and trashed = false",
      pageToken: 'previous',
    });
  });
  it('retrieves file and folder metadata and paginated sharing permissions', async () => {
    drive.files.get.mockResolvedValue({ data: { id: 'file', mimeType: 'application/pdf' } });
    expect((await call('drive_get_file', { fileId: 'file' })).data.id).toBe('file');
    expect(await failure('drive_get_folder', { folderId: 'file' })).toContain('not a Drive folder');
    drive.files.get.mockResolvedValue({ data: { id: 'folder', mimeType: 'application/vnd.google-apps.folder' } });
    expect((await call('drive_get_folder', { folderId: 'folder' })).data.id).toBe('folder');
    drive.permissions.list.mockResolvedValue({ data: { permissions: [{ role: 'reader' }], nextPageToken: 'p2' } });
    expect((await call('drive_get_file_permissions', { fileId: 'file', pageToken: 'p1' })).data.nextPageToken).toBe(
      'p2',
    );
  });
  it.each([400, 401, 403, 404, 409])('sanitizes API failure %s without leaking secrets', async (status) => {
    forms.get.mockRejectedValue({
      response: { status, data: { secret: 'access-token-secret' } },
      message: 'refresh-token-secret',
    });
    const message = await failure('forms_get', { formId: 'form' });
    expect(message).not.toContain('secret');
    expect(message).toMatch(/Google/);
  });
  it('validates unsupported uploads, invalid scales, duplicate choices and delete consent before API calls', async () => {
    for (const q of [
      { type: 'file_upload', title: 'Q' },
      { type: 'linear_scale', title: 'Q', high: 100 },
      { type: 'dropdown', title: 'Q', options: ['A', 'A'] },
    ]) {
      const result = await client.callTool({
        name: 'forms_add_question',
        arguments: { formId: 'form', itemId: 'new', question: q },
      });
      expect(result.isError).toBe(true);
    }
    expect(
      (await client.callTool({ name: 'forms_delete_question', arguments: { formId: 'form', itemId: 'name' } })).isError,
    ).toBe(true);
    expect(forms.get).not.toHaveBeenCalled();
  });
});
