import type { McpServer } from '@modelcontextprotocol/server';
import type { forms_v1 } from 'googleapis/build/src/apis/forms/v1.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { register, id, page, requireValue } from './register.js';

const common = { title: z.string().min(1).max(1000), required: z.boolean().default(false) };
const options = z.array(z.string().min(1)).min(1).max(200).refine(v => new Set(v).size === v.length, 'Options must be unique.');
export const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('short_text') }),
  z.strictObject({ ...common, type: z.literal('paragraph') }),
  ...(['multiple_choice', 'checkboxes', 'dropdown'] as const).map(type => z.strictObject({ ...common, type: z.literal(type), options, shuffle: z.boolean().default(false) })),
  z.strictObject({ ...common, type: z.literal('linear_scale'), low: z.union([z.literal(0), z.literal(1)]).default(1), high: z.number().int().min(2).max(10), lowLabel: z.string().optional(), highLabel: z.string().optional() }),
  z.strictObject({ ...common, type: z.literal('date'), includeYear: z.boolean().default(true), includeTime: z.boolean().default(false) }),
  z.strictObject({ ...common, type: z.literal('time'), duration: z.boolean().default(false) }),
]);
export function questionItem(input: z.infer<typeof questionSchema>, itemId: string, questionId?: string): forms_v1.Schema$Item {
  const question: forms_v1.Schema$Question = { required: input.required, ...(questionId ? { questionId } : {}) };
  switch (input.type) {
    case 'short_text': case 'paragraph': question.textQuestion = { paragraph: input.type === 'paragraph' }; break;
    case 'multiple_choice': case 'checkboxes': case 'dropdown':
      question.choiceQuestion = { type: { multiple_choice: 'RADIO', checkboxes: 'CHECKBOX', dropdown: 'DROP_DOWN' }[input.type], options: input.options.map(value => ({ value })), shuffle: input.shuffle }; break;
    case 'linear_scale': question.scaleQuestion = { low: input.low, high: input.high, lowLabel: input.lowLabel, highLabel: input.highLabel }; break;
    case 'date': question.dateQuestion = { includeYear: input.includeYear, includeTime: input.includeTime }; break;
    case 'time': question.timeQuestion = { duration: input.duration }; break;
  }
  return { itemId, title: input.title, questionItem: { question } };
}
const edit = { formId: id, expectedRevisionId: z.string().min(1).optional(), dryRun: z.boolean().default(false) };
export function registerForms(server: McpServer, api: forms_v1.Forms) {
  const get = (formId: string) => apiCall(() => api.forms.get({ formId }));
  async function update(formId: string, form: forms_v1.Schema$Form, requests: forms_v1.Schema$Request[], dryRun: boolean, expected?: string) {
    const revisionId = requireValue(form.revisionId, 'Google returned no revision. Cannot safely edit this form.');
    if (expected && expected !== revisionId) throw new UserError('Form revision changed. Retrieve the latest form and preview again.');
    const requestBody = { requests, writeControl: { requiredRevisionId: revisionId } };
    if (dryRun) return { dryRun: true, formId, ...requestBody };
    return apiCall(() => api.forms.batchUpdate({ formId, requestBody }), false);
  }
  register(server, 'forms_get', 'Read form metadata, settings and all items, including existing file-upload configuration.', { formId: id }, ({ formId }) => get(formId));
  register(server, 'forms_create', 'Create an empty form. Defaults to unpublished. Not idempotent: save its returned formId.', {
    title: common.title, documentTitle: z.string().min(1).optional(), unpublished: z.boolean().default(true),
  }, input => apiCall(() => api.forms.create({ unpublished: input.unpublished, requestBody: { info: { title: input.title, documentTitle: input.documentTitle } } }), false), false);
  register(server, 'forms_update', 'Update responder title/description using a revision guard. Does not rename the Drive document.', {
    ...edit, title: common.title.optional(), description: z.string().max(10000).optional(),
  }, async input => {
    const fields = ['title', 'description'].filter(k => input[k as 'title' | 'description'] !== undefined);
    if (!fields.length) throw new UserError('Provide title or description.');
    const form = await get(input.formId);
    return update(input.formId, form, [{ updateFormInfo: { info: { title: input.title, description: input.description }, updateMask: fields.join(',') } }], input.dryRun, input.expectedRevisionId);
  }, false);
  register(server, 'forms_add_question', 'Add a question with a caller-chosen stable itemId. Reusing an existing itemId is a no-op; inspect it or use forms_update_question to edit.', {
    ...edit, itemId: id, question: questionSchema, index: z.number().int().min(0).optional(),
  }, async input => {
    const form = await get(input.formId);
    if (input.expectedRevisionId && input.expectedRevisionId !== form.revisionId) throw new UserError('Form revision changed. Retrieve the latest form.');
    const existing = form.items?.find(item => item.itemId === input.itemId);
    if (existing) return { unchanged: true, item: existing };
    const index = input.index ?? form.items?.length ?? 0;
    if (index > (form.items?.length ?? 0)) throw new UserError('Index exceeds the form item count.');
    return update(input.formId, form, [{ createItem: { item: questionItem(input.question, input.itemId), location: { index } } }], input.dryRun, input.expectedRevisionId);
  }, false);
  register(server, 'forms_update_question', 'Edit a supported single question identified by itemId. Keeps question IDs, grading, images, description and unrelated items. Changing question type requires explicit consent.', {
    ...edit, itemId: id, question: questionSchema, allowTypeChange: z.boolean().default(false),
  }, async input => {
    const form = await get(input.formId);
    const index = form.items?.findIndex(item => item.itemId === input.itemId) ?? -1;
    const item = requireValue(form.items?.[index], 'Question item not found. Use forms_get to find its itemId.');
    const old = requireValue(item.questionItem?.question, 'Only single question items can be edited.');
    if (old.fileUploadQuestion) throw new UserError('File-upload questions must be edited manually in Google Forms. Their configuration is preserved.');
    if (old.rowQuestion || old.ratingQuestion) throw new UserError('This question type is not supported for edits in v1. Edit it manually in Google Forms.');
    const next = questionItem(input.question, input.itemId, old.questionId ?? undefined);
    const newQuestion = requireValue(next.questionItem?.question, 'Missing question.');
    const kinds = ['textQuestion', 'choiceQuestion', 'scaleQuestion', 'dateQuestion', 'timeQuestion'] as const;
    const kind = kinds.find(k => newQuestion[k] != null)!;
    const typeChanged = old[kind] == null || (kind === 'choiceQuestion' && old.choiceQuestion?.type !== newQuestion.choiceQuestion?.type);
    if (typeChanged && old.grading) throw new UserError('Questions with grading cannot change type. Update their grading manually in Google Forms first.');
    if (kind === 'choiceQuestion' && old.grading?.correctAnswers) {
      const options = newQuestion.choiceQuestion?.options ?? [];
      if (old.grading.correctAnswers.answers?.some(answer => !answer.value || !options.some(option => option.value === answer.value))) {
        throw new UserError('Choice options must retain every existing correct answer. Update the grading manually in Google Forms before removing or renaming one.');
      }
    }
    if (typeChanged) {
      if (!input.allowTypeChange) throw new UserError('Changing question type can affect existing answers. Set allowTypeChange=true after reviewing the form.');
    }
    // Narrow masks preserve grading, images, descriptions and all other question metadata.
    const merged = { ...item, title: next.title, questionItem: { ...item.questionItem, question: { ...old, required: newQuestion.required } } };
    for (const k of kinds) delete merged.questionItem.question[k];
    Object.assign(merged.questionItem.question, { [kind]: newQuestion[kind] });
    const mask = ['title', 'questionItem.question.required', ...kinds.map(k => `questionItem.question.${k}`)].join(',');
    return update(input.formId, form, [{ updateItem: { item: merged, location: { index }, updateMask: mask } }], input.dryRun, input.expectedRevisionId);
  }, false, true);
  register(server, 'forms_delete_question', 'Delete a single question by itemId. Destructive; confirmDelete=true is required, including for previews. File-upload questions cannot be deleted by this tool.', {
    ...edit, itemId: id, confirmDelete: z.literal(true),
  }, async input => {
    const form = await get(input.formId);
    const index = form.items?.findIndex(item => item.itemId === input.itemId) ?? -1;
    if (input.expectedRevisionId && input.expectedRevisionId !== form.revisionId) throw new UserError('Form revision changed. Retrieve the latest form.');
    if (index < 0) return { unchanged: true, deleted: false };
    const q = form.items?.[index]?.questionItem?.question;
    if (!q || q.fileUploadQuestion) throw new UserError('Only supported single questions can be deleted. Manage file uploads and grouped questions manually.');
    return update(input.formId, form, [{ deleteItem: { location: { index } } }], input.dryRun, input.expectedRevisionId);
  }, false, true);
  register(server, 'forms_list_responses', 'Read one response page, including uploaded-file references. Pass nextPageToken as pageToken to continue.', {
    formId: id, ...page, filter: z.string().min(1).optional(),
  }, input => apiCall(() => api.forms.responses.list(input)));
  register(server, 'forms_get_response', 'Read a response by its ID, including uploaded-file references.', { formId: id, responseId: id }, input => apiCall(() => api.forms.responses.get(input)));
  register(server, 'forms_get_publish_status', 'Read publication and response-acceptance state. Legacy forms may not support publication.', { formId: id }, async ({ formId }) => {
    const form = await get(formId);
    return { formId, supported: form.publishSettings != null, publishSettings: form.publishSettings ?? null, responderUri: form.responderUri };
  });
  register(server, 'forms_publish', 'Set published and accepting-responses state explicitly. Publication API has no revision guard; last writer wins.', {
    formId: id, isPublished: z.boolean(), isAcceptingResponses: z.boolean(), dryRun: z.boolean().default(false),
  }, async input => {
    if (!input.isPublished && input.isAcceptingResponses) throw new UserError('An unpublished form cannot accept responses.');
    const form = await get(input.formId);
    if (!form.publishSettings) throw new UserError('This legacy form does not support publication through the API. Use Google Forms manually.');
    const publishState = { isPublished: input.isPublished, isAcceptingResponses: input.isAcceptingResponses };
    const requestBody = { publishSettings: { publishState }, updateMask: 'publishState' };
    if (input.dryRun) return { dryRun: true, formId: input.formId, requestBody };
    return apiCall(() => api.forms.setPublishSettings({ formId: input.formId, requestBody }), false);
  }, false, true);
}
