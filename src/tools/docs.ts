import type { McpServer } from '@modelcontextprotocol/server';
import type { docs_v1 } from 'googleapis/build/src/apis/docs/v1.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { bounded, id, register, requireValue } from './register.js';

function allTabs(tabs: docs_v1.Schema$Tab[] = []): docs_v1.Schema$Tab[] {
  return tabs.flatMap((tab) => [tab, ...allTabs(tab.childTabs)]);
}
function* textRuns(content: docs_v1.Schema$StructuralElement[] = []): Generator<string> {
  for (const element of content) {
    for (const part of element.paragraph?.elements ?? []) if (part.textRun?.content) yield part.textRun.content;
    for (const row of element.table?.tableRows ?? [])
      for (const cell of row.tableCells ?? []) yield* textRuns(cell.content);
    if (element.tableOfContents) yield* textRuns(element.tableOfContents.content);
  }
}
const tabId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Use a Docs tab ID, not a URL.');
const edit = {
  documentId: id,
  tabId: tabId.optional(),
  expectedRevisionId: z.string().min(1).max(1024).optional(),
  dryRun: z.boolean().default(false),
};
const text = z.string().max(100000);

export function registerDocs(server: McpServer, api: docs_v1.Docs) {
  const get = (documentId: string) => apiCall(() => api.documents.get({ documentId, includeTabsContent: true }));
  async function update(input: z.infer<z.ZodObject<typeof edit>>, request: (tabId: string) => docs_v1.Schema$Request) {
    const document = await get(input.documentId);
    const tabs = allTabs(document.tabs);
    if (!input.tabId && tabs.length !== 1) throw new UserError('Select a tabId for this document using docs_get.');
    const tab = input.tabId ? tabs.find((t) => t.tabProperties?.tabId === input.tabId) : tabs[0];
    if (!tab?.documentTab) throw new UserError('The selected document tab was not found. Read docs_get again.');
    const tabId = requireValue(tab.tabProperties?.tabId, 'Google returned no tab ID. Cannot safely edit.');
    const revisionId = requireValue(document.revisionId, 'Google returned no revision ID. Cannot safely edit.');
    if (input.expectedRevisionId && input.expectedRevisionId !== revisionId)
      throw new UserError('Document revision changed. Read docs_get and preview the edit again.');
    const requestBody = bounded({ requests: [request(tabId)], writeControl: { requiredRevisionId: revisionId } });
    if (input.dryRun) return { dryRun: true, documentId: input.documentId, tabId, ...requestBody };
    return apiCall(() => api.documents.batchUpdate({ documentId: input.documentId, requestBody }), false);
  }
  register(
    server,
    'docs_get',
    'Read nested tab metadata and bounded plain body text: paragraphs, table cells and table of contents. Excludes headers, footers, footnotes, images and formatting.',
    { documentId: id, tabId: tabId.optional(), maxCharacters: z.number().int().min(1).max(200000).default(100000) },
    async ({ documentId, tabId, maxCharacters }) => {
      const document = await get(documentId);
      const tabs = allTabs(document.tabs);
      if (tabId && !tabs.some((tab) => tab.tabProperties?.tabId === tabId))
        throw new UserError('Document tab not found.');
      let remaining = maxCharacters;
      return bounded({
        documentId: document.documentId,
        title: document.title,
        revisionId: document.revisionId,
        textIncludes:
          'Body paragraphs, table cells and table of contents, in document order; formatting and non-text elements omitted.',
        tabs: tabs
          .filter((tab) => !tabId || tab.tabProperties?.tabId === tabId)
          .map((tab) => {
            let text = '';
            let truncated = false;
            for (const run of textRuns(tab.documentTab?.body?.content)) {
              const part = run.slice(0, remaining);
              text += part;
              remaining -= part.length;
              if (part.length < run.length) {
                truncated = true;
                break;
              }
            }
            return { ...tab.tabProperties, text, truncated };
          }),
      });
    },
  );
  register(
    server,
    'docs_create',
    'Create an empty document without writable Drive permission. Not idempotent; save its returned ID/link.',
    { title: z.string().min(1).max(1000) },
    async ({ title }) => {
      const document = await apiCall(() => api.documents.create({ requestBody: { title } }), false);
      return { ...document, webViewLink: `https://docs.google.com/document/d/${document.documentId}/edit` };
    },
    { readOnly: false, idempotent: false },
  );
  register(
    server,
    'docs_append_text',
    'Append plain text to the selected tab body with a required revision guard. Preview with dryRun, then apply with its expectedRevisionId. Never automatically retried.',
    { ...edit, text: text.min(1) },
    (input) => update(input, (tabId) => ({ insertText: { text: input.text, endOfSegmentLocation: { tabId } } })),
    { readOnly: false, idempotent: false },
  );
  register(
    server,
    'docs_replace_text',
    'Replace literal matching text only in a selected tab with revision protection. Matches can include headers/footers/footnotes not shown in plain body text. Preview before applying.',
    { ...edit, searchText: text.min(1), replacementText: text, matchCase: z.boolean().default(true) },
    (input) =>
      update(input, (tabId) => ({
        replaceAllText: {
          containsText: { text: input.searchText, matchCase: input.matchCase, searchByRegex: false },
          replaceText: input.replacementText,
          tabsCriteria: { tabIds: [tabId] },
        },
      })),
    { readOnly: false, destructive: true, idempotent: false },
  );
}
