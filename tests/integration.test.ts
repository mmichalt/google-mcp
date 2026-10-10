import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { loadAuth } from '../src/google/auth.js';
import { apiCall, createClients } from '../src/google/client.js';

// Explicitly enabled, read-only; no live credentials are needed for ordinary tests.
it.skipIf(process.env.GOOGLE_MCP_INTEGRATION !== 'true')(
  'reads a live form and Drive discovery with configured OAuth',
  async () => {
    const formId = process.env.GOOGLE_MCP_TEST_FORM_ID;
    if (!formId) throw new Error('Set GOOGLE_MCP_TEST_FORM_ID for the optional live test.');
    const config = readConfig();
    const { client, flush } = await loadAuth(config);
    const apis = createClients(client);
    if (config.services.includes('forms')) {
      const form = await apiCall(() => apis.forms.forms.get({ formId }));
      expect(form.formId).toBe(formId);
      await apiCall(() => apis.forms.forms.responses.list({ formId, pageSize: 1 }));
    }
    if (config.services.includes('drive')) {
      const file = await apiCall(() => apis.drive.files.get({ fileId: formId, fields: 'id,mimeType' }));
      expect(file.mimeType).toBe('application/vnd.google-apps.form');
      await apiCall(() =>
        apis.drive.files.list({ q: "mimeType = 'application/vnd.google-apps.form' and trashed = false", pageSize: 1 }),
      );
    }
    await flush();
  },
  60000,
);
