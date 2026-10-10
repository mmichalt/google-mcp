import { readConfig } from '../src/config.js';
import { loadAuth } from '../src/google/auth.js';
import { createClients, apiCall, safeError } from '../src/google/client.js';
async function doctor() {
  const config = readConfig();
  const { client, flush } = await loadAuth(config);
  await client.getAccessToken();
  await flush();
  const apis = createClients(client);
  console.error('OAuth access token and local persistence: OK');
  if (config.services.includes('drive')) {
    await apiCall(() => apis.drive.files.list({ pageSize: 1, fields: 'files(id)' }));
    console.error('Drive metadata connectivity: OK');
  }
  if (config.services.includes('forms')) {
    const formId = process.argv[2];
    if (formId) {
      await apiCall(() => apis.forms.forms.get({ formId }));
      console.error('Forms read connectivity: OK');
    } else console.error('Forms connectivity untested: pass a known form ID: npm run doctor -- FORM_ID');
  }
}
void doctor().catch(error => {
  console.error(error instanceof Error && /^(Authorization|Enabled services|OAuth client|Cannot read Desktop|Cannot securely)/.test(error.message) ? error.message : safeError(error));
  process.exitCode = 1;
});
