import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validState } from '../scripts/setup-auth.js';
import { readConfig } from '../src/config.js';
import { loadAuth, persistRefresh, readTokens, saveTokens } from '../src/google/auth.js';
import { apiCall, safeError } from '../src/google/client.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'google-mcp-test-'));
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify({ installed: { client_id: 'desktop-client', client_secret: 'never-log-me' } }),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const saved = {
  clientId: 'desktop-client',
  scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
  tokens: { refresh_token: 'refresh-secret', access_token: 'expired', expiry_date: 1 },
};
function config() {
  return readConfig({ GOOGLE_MCP_AUTH_DIR: directory, GOOGLE_MCP_SERVICES: 'forms' });
}
it('stores shared OAuth tokens privately and reuses them', async () => {
  const cfg = config();
  await saveTokens(cfg.tokenPath, saved);
  const { client } = await loadAuth(cfg);
  expect(client.credentials.refresh_token).toBe('refresh-secret');
  if (process.platform !== 'win32') {
    expect((await stat(cfg.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  }
});
it('automatically refreshes expired access tokens using the official library and persists them', async () => {
  const cfg = config();
  await saveTokens(cfg.tokenPath, saved);
  const { client, flush } = await loadAuth(cfg);
  const request = vi
    .spyOn(client.transporter, 'request')
    .mockResolvedValue({ data: { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' } } as never);
  const result = await client.getAccessToken();
  await flush();
  expect(result.token).toBe('fresh');
  expect(request).toHaveBeenCalledOnce();
  expect((await readTokens(cfg)).tokens).toMatchObject({ refresh_token: 'refresh-secret', access_token: 'fresh' });
});
it('serializes refreshed-token persistence and keeps the refresh token when omitted', async () => {
  const cfg = config();
  const client = new OAuth2Client();
  const flush = persistRefresh(client, cfg, saved);
  client.emit('tokens', { access_token: 'one' });
  client.emit('tokens', { access_token: 'two' });
  await flush();
  expect(JSON.parse(await readFile(cfg.tokenPath, 'utf8')).tokens).toMatchObject({
    access_token: 'two',
    refresh_token: 'refresh-secret',
  });
});
it('does not silently accept token persistence failures', async () => {
  const cfg = config();
  await writeFile(join(directory, 'block'), 'not a directory');
  cfg.tokenPath = join(directory, 'block', 'tokens.json');
  const client = new OAuth2Client();
  const flush = persistRefresh(client, cfg, saved);
  client.emit('tokens', { access_token: 'fresh' });
  await expect(flush()).rejects.toThrow('Cannot securely persist');
});
it('rejects missing, malformed, differently scoped and different-client authorization with recovery instructions', async () => {
  const cfg = config();
  await expect(loadAuth(cfg)).rejects.toThrow('npm run auth');
  await writeFile(cfg.tokenPath, '{}');
  await expect(loadAuth(cfg)).rejects.toThrow('npm run auth');
  await saveTokens(cfg.tokenPath, { ...saved, scopes: [] });
  await expect(loadAuth(cfg)).rejects.toThrow('additional authorization');
  await saveTokens(cfg.tokenPath, { ...saved, clientId: 'other' });
  await expect(loadAuth(cfg)).rejects.toThrow('client changed');
});
it('checks OAuth state and rejects tampering', () => {
  expect(validState('state', 'state')).toBe(true);
  expect(validState(null, 'state')).toBe(false);
  expect(validState('bad', 'state')).toBe(false);
  expect(validState('STATE', 'state')).toBe(false);
});
it('configures service scopes independently and requires explicit attachment opt-in', () => {
  const forms = readConfig({ GOOGLE_MCP_SERVICES: 'forms' });
  expect(forms.scopes.every((s) => s.includes('/forms.'))).toBe(true);
  expect(readConfig({ GOOGLE_MCP_SERVICES: 'drive' }).scopes).toEqual([
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ]);
  expect(readConfig({ GOOGLE_MCP_SERVICES: 'drive', GOOGLE_MCP_DRIVE_ATTACHMENTS: 'true' }).scopes).toEqual([
    'https://www.googleapis.com/auth/drive.readonly',
  ]);
  expect(() => readConfig({ GOOGLE_MCP_SERVICES: 'gmail' })).toThrow();
  expect(() => readConfig({ GOOGLE_MCP_SERVICES: 'forms', GOOGLE_MCP_DRIVE_ATTACHMENTS: 'true' })).toThrow();
  expect(() => readConfig({ GOOGLE_MCP_AUTH_DIR: './local' })).toThrow('absolute');
});
it.each([429, 500, 503])('retries transient read failure %s with bounded backoff', async (status) => {
  const operation = vi.fn().mockRejectedValueOnce({ response: { status } }).mockResolvedValue({ data: 'ok' });
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await apiCall(operation, true, sleep)).toBe('ok');
  expect(operation).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledOnce();
});
it('retries rate-limit 403 but not permission 403, and caps retries', async () => {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const rate = vi
    .fn()
    .mockRejectedValue({ response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } });
  await expect(apiCall(rate, true, sleep)).rejects.toBeDefined();
  expect(rate).toHaveBeenCalledTimes(4);
  const permission = vi.fn().mockRejectedValue({ response: { status: 403 } });
  await expect(apiCall(permission, true, sleep)).rejects.toBeDefined();
  expect(permission).toHaveBeenCalledOnce();
});
it('never retries ambiguous writes and sanitizes revoked authorization', async () => {
  const write = vi.fn().mockRejectedValue({ response: { status: 503 } });
  await expect(apiCall(write, false, vi.fn())).rejects.toBeDefined();
  expect(write).toHaveBeenCalledOnce();
  expect(safeError({ response: { status: 400, data: { error: 'invalid_grant' } } })).toContain('npm run auth');
  expect(safeError(new Error('token-secret'))).not.toContain('token-secret');
  expect(safeError({ response: { status: 503, data: { error: null } } })).toContain('Google request failed');
});
