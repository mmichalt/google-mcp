import { pathToFileURL } from 'node:url';
import { type Config, readConfig } from '../src/config.js';
import { loadAuth } from '../src/google/auth.js';
import { apiCall, type Clients, createClients, safeError } from '../src/google/client.js';

export async function checkServices(
  config: Config,
  apis: Clients,
  env: NodeJS.ProcessEnv = process.env,
  report = console.error,
) {
  if (config.services.includes('drive')) {
    await apiCall(() => apis.drive.files.list({ pageSize: 1, fields: 'files(id)' }));
    report('Drive metadata connectivity: OK');
    if (config.attachments) report('Drive content download untested: use drive_read_text on a known test file.');
  }
  if (config.services.includes('forms')) {
    const formId = env.GOOGLE_MCP_TEST_FORM_ID;
    if (formId) {
      await apiCall(() => apis.forms.forms.get({ formId }));
      report('Forms read connectivity: OK');
    } else report('Forms connectivity untested: pass a known form ID: npm run doctor -- FORM_ID');
  }
  if (config.services.includes('tasks')) {
    await apiCall(() => apis.tasks.tasklists.list({ maxResults: 1 }));
    report('Tasks read connectivity: OK');
  }
  if (config.services.includes('sheets')) {
    const spreadsheetId = env.GOOGLE_MCP_TEST_SPREADSHEET_ID;
    if (spreadsheetId) {
      await apiCall(() =>
        apis.sheets.spreadsheets.get({ spreadsheetId, includeGridData: false, fields: 'spreadsheetId' }),
      );
      report('Sheets read connectivity: OK');
    } else report('Sheets connectivity untested: set GOOGLE_MCP_TEST_SPREADSHEET_ID to a known spreadsheet.');
  }
  if (config.services.includes('docs')) {
    const documentId = env.GOOGLE_MCP_TEST_DOCUMENT_ID;
    if (documentId) {
      await apiCall(() =>
        apis.docs.documents.get({
          documentId,
          includeTabsContent: true,
          fields: 'documentId,tabs(tabProperties,childTabs)',
        }),
      );
      report('Docs read connectivity: OK');
    } else report('Docs connectivity untested: set GOOGLE_MCP_TEST_DOCUMENT_ID to a known document.');
  }
  if (config.services.includes('meet')) {
    await apiCall(() => apis.meet.conferenceRecords.list({ pageSize: 1 }));
    report('Meet read connectivity: OK');
  }
}

async function doctor() {
  const config = readConfig();
  const { client, flush } = await loadAuth(config);
  await client.getAccessToken();
  await flush();
  const apis = createClients(client);
  console.error('OAuth access token and local persistence: OK');
  await checkServices(config, apis, {
    ...process.env,
    GOOGLE_MCP_TEST_FORM_ID: process.argv[2] ?? process.env.GOOGLE_MCP_TEST_FORM_ID,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void doctor().catch((error) => {
    console.error(
      error instanceof Error &&
        /^(Authorization|Enabled services|OAuth client|Cannot read Desktop|Cannot securely)/.test(error.message)
        ? error.message
        : safeError(error),
    );
    process.exitCode = 1;
  });
