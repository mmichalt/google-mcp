import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupAuth } from '../scripts/setup-auth.js';
import { readConfig } from '../src/config.js';

const flow = vi.hoisted(() => ({ url: '', mode: 'success' }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  const listener = new EventEmitter();
  Object.assign(listener, {
    listen: vi.fn((_port, _host, done) => {
      listener.removeAllListeners('request');
      done();
    }),
    address: () => ({ port: 54321 }),
    closeAllConnections: () => {},
    close: (done: () => void) => done(),
  });
  return { createServer: () => listener };
});
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { createServer } = await import('node:http');
  return {
    spawn: (_cmd: string, args: string[]) => {
      flow.url = args.at(-1)!;
      const url = new URL(flow.url);
      const state = url.searchParams.get('state');
      const listener = createServer();
      const response = () => ({ setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: vi.fn() });
      queueMicrotask(() => {
        // Reject an unrelated/forged callback, then accept the matching browser redirect.
        listener.emit('request', { url: '/oauth2callback?state=forged&code=stolen' }, response());
        const query = flow.mode === 'denied' ? 'error=access_denied' : 'code=authorized-code';
        listener.emit('request', { url: `/oauth2callback?state=${state}&${query}` }, response());
      });
      return Object.assign(new EventEmitter(), { unref: () => {} });
    },
  };
});
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'google-mcp-flow-'));
  vi.stubEnv('GOOGLE_MCP_AUTH_DIR', directory);
  vi.stubEnv('GOOGLE_MCP_SERVICES', 'forms');
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify({ installed: { client_id: 'desktop', client_secret: 'private' } }),
  );
  flow.mode = 'success';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it('completes browser account selection and PKCE exchange, rejecting forged state', async () => {
  const cfg = readConfig();
  const exchange = vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(async () => ({
    tokens: { refresh_token: 'new-account-refresh', access_token: 'new-access', scope: cfg.scopes.join(' ') },
    res: null,
  }));
  await setupAuth();
  const url = new URL(flow.url);
  expect(url.searchParams.get('prompt')).toBe('consent select_account');
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(exchange).toHaveBeenCalledOnce();
  expect(exchange.mock.calls[0]?.[0]).toMatchObject({
    code: 'authorized-code',
    redirect_uri: 'http://127.0.0.1:54321/oauth2callback',
  });
  expect(JSON.parse(await readFile(cfg.tokenPath, 'utf8')).tokens.refresh_token).toBe('new-account-refresh');
});
it('does not replace saved authorization when Google consent is denied', async () => {
  flow.mode = 'denied';
  const exchange = vi.spyOn(OAuth2Client.prototype, 'getToken');
  await expect(setupAuth()).rejects.toThrow('declined');
  expect(exchange).not.toHaveBeenCalled();
});
it('does not reuse a previous account refresh token when a new exchange omits it', async () => {
  const cfg = readConfig();
  await writeFile(
    cfg.tokenPath,
    JSON.stringify({ clientId: 'desktop', scopes: cfg.scopes, tokens: { refresh_token: 'previous-account' } }),
  );
  vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(async () => ({
    tokens: { access_token: 'new-account', scope: cfg.scopes.join(' ') },
    res: null,
  }));
  await expect(setupAuth()).rejects.toThrow('no refresh token');
  expect(JSON.parse(await readFile(cfg.tokenPath, 'utf8')).tokens.refresh_token).toBe('previous-account');
});
it('rejects partial scope consent before saving tokens', async () => {
  vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(async () => ({
    tokens: { access_token: 'new', refresh_token: 'new', scope: 'https://www.googleapis.com/auth/forms.body' },
    res: null,
  }));
  await expect(setupAuth()).rejects.toThrow('not granted');
});
