import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { loadAuth } from '../src/google/auth.js';
import { apiCall, createClients } from '../src/google/client.js';

// Explicitly enabled, read-only; no live credentials are needed for ordinary tests.
it.skipIf(process.env.GOOGLE_MCP_INTEGRATION !== 'true')(
  'reads explicitly selected live Workspace resources with configured OAuth',
  async () => {
    const formId = process.env.GOOGLE_MCP_TEST_FORM_ID;
    const config = readConfig();
    const { client, flush } = await loadAuth(config);
    const apis = createClients(client);
    if (config.services.includes('forms')) {
      if (!formId) throw new Error('Set GOOGLE_MCP_TEST_FORM_ID for the optional live Forms test.');
      const form = await apiCall(() => apis.forms.forms.get({ formId }));
      expect(form.formId).toBe(formId);
      await apiCall(() => apis.forms.forms.responses.list({ formId, pageSize: 1 }));
    }
    if (config.services.includes('drive')) {
      if (formId) {
        const file = await apiCall(() => apis.drive.files.get({ fileId: formId, fields: 'id,mimeType' }));
        expect(file.mimeType).toBe('application/vnd.google-apps.form');
      }
      await apiCall(() =>
        apis.drive.files.list({ q: "mimeType = 'application/vnd.google-apps.form' and trashed = false", pageSize: 1 }),
      );
    }
    if (config.services.includes('tasks')) {
      await apiCall(() => apis.tasks.tasklists.list({ maxResults: 1 }));
      await apiCall(() =>
        apis.tasks.tasks.list({
          tasklist: process.env.GOOGLE_MCP_TEST_TASKLIST_ID ?? '@default',
          maxResults: 1,
          showCompleted: false,
          showHidden: false,
          showAssigned: false,
        }),
      );
    }
    if (config.services.includes('sheets')) {
      const spreadsheetId = process.env.GOOGLE_MCP_TEST_SPREADSHEET_ID;
      if (!spreadsheetId) throw new Error('Set GOOGLE_MCP_TEST_SPREADSHEET_ID for the optional live Sheets test.');
      expect(
        (
          await apiCall(() =>
            apis.sheets.spreadsheets.get({ spreadsheetId, includeGridData: false, fields: 'spreadsheetId' }),
          )
        ).spreadsheetId,
      ).toBe(spreadsheetId);
    }
    if (config.services.includes('docs')) {
      const documentId = process.env.GOOGLE_MCP_TEST_DOCUMENT_ID;
      if (!documentId) throw new Error('Set GOOGLE_MCP_TEST_DOCUMENT_ID for the optional live Docs test.');
      expect((await apiCall(() => apis.docs.documents.get({ documentId, includeTabsContent: true }))).documentId).toBe(
        documentId,
      );
    }
    if (config.services.includes('meet')) {
      await apiCall(() => apis.meet.conferenceRecords.list({ pageSize: 1 }));
      const parent = process.env.GOOGLE_MCP_TEST_CONFERENCE_NAME;
      if (parent) await apiCall(() => apis.meet.conferenceRecords.transcripts.list({ parent, pageSize: 1 }));
      const transcript = process.env.GOOGLE_MCP_TEST_TRANSCRIPT_NAME;
      if (transcript)
        await apiCall(() => apis.meet.conferenceRecords.transcripts.entries.list({ parent: transcript, pageSize: 1 }));
    }
    if (config.services.includes('calendar')) {
      await apiCall(() => apis.calendar.calendarList.list({ maxResults: 1 }));
      await apiCall(() => apis.calendar.events.list({ calendarId: 'primary', maxResults: 1 }));
    }
    if (config.services.includes('gmail')) {
      await apiCall(() => apis.gmail.users.getProfile({ userId: 'me' }));
      await apiCall(() => apis.gmail.users.messages.list({ userId: 'me', maxResults: 1 }));
    }
    await flush();
  },
  60000,
);
