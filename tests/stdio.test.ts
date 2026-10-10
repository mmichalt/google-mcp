import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { saveTokens } from '../src/google/auth.js';

it('discovers and invokes tools from the compiled stdio entry point without live credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'google-mcp-stdio-'));
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
  try {
    await writeFile(join(directory, 'credentials.json'), JSON.stringify({ installed: { client_id: 'fake-client', client_secret: 'fake-secret' } }));
    const config = readConfig({ GOOGLE_MCP_AUTH_DIR: directory });
    await saveTokens(config.tokenPath, { clientId: 'fake-client', scopes: config.scopes, tokens: { refresh_token: 'fake-refresh', access_token: 'fake-access', expiry_date: Date.now() + 3600000 } });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/server.js')], env: { GOOGLE_MCP_AUTH_DIR: directory }, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    await client.connect(transport).catch(error => { throw new Error(`Stdio connection failed: ${diagnostics}`, { cause: error }); });
    expect((await client.listTools()).tools).toHaveLength(14);
    const result = await client.callTool({ name: 'forms_get', arguments: { formId: 'https://invalid-url' } });
    expect(result.isError).toBe(true);
    expect(diagnostics).not.toContain('fake-secret');
    expect(diagnostics).not.toContain('fake-refresh');
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);
