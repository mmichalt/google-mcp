import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { readConfig, type Config } from './config.js';
import { loadAuth } from './google/auth.js';
import { createClients, type Clients } from './google/client.js';
import { registerForms } from './tools/forms.js';
import { registerDrive } from './tools/drive.js';

export function createServer(config: Config, clients: Clients) {
  const server = new McpServer({ name: 'google-mcp', version: '0.1.0' });
  if (config.services.includes('forms')) registerForms(server, clients.forms);
  if (config.services.includes('drive')) registerDrive(server, clients.drive);
  return server;
}
async function main() {
  const config = readConfig();
  const { client, flush } = await loadAuth(config);
  serveStdio(() => createServer(config, createClients(client)), { onerror: () => { console.error('MCP transport error. Restart the client and check its stdio configuration.'); } });
  process.stdin.on('end', () => { void flush().catch(() => { console.error('Failed to persist authorization. Run npm run auth.'); process.exitCode = 1; }); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error('google-mcp could not start. Check configuration and credentials; run npm run auth, then npm run doctor.'); process.exitCode = 1; });
}
