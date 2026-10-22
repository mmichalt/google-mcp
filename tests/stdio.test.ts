import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { saveTokens } from '../src/google/auth.js';

it.each([
  { services: 'forms,drive', attachments: 'false', gmailSend: 'false', count: 14 },
  { services: 'tasks', attachments: 'false', gmailSend: 'false', count: 4 },
  { services: 'forms,drive,tasks,sheets,docs,meet,calendar,gmail', attachments: 'true', gmailSend: 'true', count: 42 },
])(
  'discovers $count tools from compiled stdio with $services without live credentials',
  async ({ services, attachments, gmailSend, count }) => {
    const directory = await mkdtemp(join(tmpdir(), 'google-mcp-stdio-'));
    const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
    try {
      await writeFile(
        join(directory, 'credentials.json'),
        JSON.stringify({ installed: { client_id: 'fake-client', client_secret: 'fake-secret' } }),
      );
      const env = {
        GOOGLE_MCP_AUTH_DIR: directory,
        GOOGLE_MCP_SERVICES: services,
        GOOGLE_MCP_DRIVE_ATTACHMENTS: attachments,
        GOOGLE_MCP_GMAIL_SEND: gmailSend,
      };
      const config = readConfig(env);
      await saveTokens(config.tokenPath, {
        clientId: 'fake-client',
        scopes: config.scopes,
        tokens: { refresh_token: 'fake-refresh', access_token: 'fake-access', expiry_date: Date.now() + 3600000 },
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/src/server.js')],
        env,
        stderr: 'pipe',
      });
      let diagnostics = '';
      transport.stderr?.on('data', (chunk) => {
        diagnostics += String(chunk);
      });
      await client.connect(transport).catch((error) => {
        throw new Error(`Stdio connection failed: ${diagnostics}`, { cause: error });
      });
      expect((await client.listTools()).tools).toHaveLength(count);
      const result =
        services === 'tasks'
          ? await client.callTool({ name: 'tasks_list_tasks', arguments: { tasklist: 'https://invalid-url' } })
          : await client.callTool({ name: 'forms_get', arguments: { formId: 'https://invalid-url' } });
      expect(result.isError).toBe(true);
      expect(diagnostics).not.toContain('fake-secret');
      expect(diagnostics).not.toContain('fake-refresh');
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
