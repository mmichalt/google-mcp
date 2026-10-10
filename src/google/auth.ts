import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Credentials, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Config } from '../config.js';

const desktop = z.object({ installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }) });
const stored = z.object({
  clientId: z.string(),
  scopes: z.array(z.string()),
  tokens: z.object({
    access_token: z.string().nullable().optional(),
    refresh_token: z.string().min(1),
    expiry_date: z.number().nullable().optional(),
    token_type: z.string().nullable().optional(),
    scope: z.string().optional(),
  }),
});
export type StoredAuth = z.infer<typeof stored>;
export async function saveTokens(path: string, value: StoredAuth) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(stored.parse(value)), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function createOAuth(config: Config, redirectUri?: string) {
  let data: z.infer<typeof desktop>;
  try {
    data = desktop.parse(JSON.parse(await readFile(config.credentialsPath, 'utf8')));
  } catch {
    throw new Error('Cannot read Desktop OAuth credentials. Set GOOGLE_MCP_CREDENTIALS to the downloaded JSON file.');
  }
  return new OAuth2Client({
    clientId: data.installed.client_id,
    clientSecret: data.installed.client_secret,
    redirectUri,
    forceRefreshOnFailure: true,
  });
}
export async function readTokens(config: Config): Promise<StoredAuth> {
  try {
    if (process.platform !== 'win32') await chmod(config.tokenPath, 0o600);
    return stored.parse(JSON.parse(await readFile(config.tokenPath, 'utf8')));
  } catch {
    throw new Error('Authorization is missing or invalid. Run npm run auth in google-mcp.');
  }
}
export function persistRefresh(client: OAuth2Client, config: Config, saved: StoredAuth) {
  let pending = Promise.resolve();
  let failure = false;
  client.on('tokens', (tokens: Credentials) => {
    saved = {
      ...saved,
      tokens: { ...saved.tokens, ...tokens, refresh_token: tokens.refresh_token ?? saved.tokens.refresh_token },
    };
    const snapshot = saved;
    pending = pending
      .then(() => saveTokens(config.tokenPath, snapshot))
      .catch(() => {
        failure = true;
      });
  });
  return async () => {
    await pending;
    if (failure)
      throw new Error('Cannot securely persist refreshed authorization. Check the auth directory permissions.');
  };
}
export async function loadAuth(config: Config) {
  const client = await createOAuth(config);
  const saved = await readTokens(config);
  if (saved.clientId !== client._clientId) throw new Error('OAuth client changed. Run npm run auth again.');
  if (config.scopes.some((scope) => !saved.scopes.includes(scope)))
    throw new Error('Enabled services need additional authorization. Run npm run auth.');
  client.setCredentials(saved.tokens);
  const flush = persistRefresh(client, config, saved);
  return { client, flush };
}
