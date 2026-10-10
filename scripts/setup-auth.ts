import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodeChallengeMethod } from 'google-auth-library';
import { readConfig } from '../src/config.js';
import { createOAuth, readTokens, saveTokens } from '../src/google/auth.js';

export function validState(actual: string | null, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function openBrowser(url: string) {
  const child = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' })
    : process.platform === 'darwin' ? spawn('open', [url], { stdio: 'ignore' }) : spawn('xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => { console.error('Browser did not open automatically. Open the printed URL in your browser.'); });
  child.unref();
}
export async function setupAuth() {
  const config = readConfig();
  const state = randomBytes(32).toString('hex');
  // Desktop OAuth does not support incremental authorization: request exactly the enabled scopes again.
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(config.port, '127.0.0.1', resolve);
  });
  try {
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Cannot bind OAuth loopback callback.');
    const redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
    const client = await createOAuth(config, redirect);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    let previous;
    try { previous = await readTokens(config); } catch { /* First authorization has no saved tokens. */ }
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account',
      scope: config.scopes, state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
    const codePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Authorization timed out. Run npm run auth again.')), 5 * 60 * 1000);
      listener.on('request', (req, res) => {
        const callback = new URL(req.url ?? '/', redirect);
        if (callback.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (!validState(callback.searchParams.get('state'), state)) { res.writeHead(400).end('Invalid OAuth state.'); return; }
        if (callback.searchParams.has('error')) { clearTimeout(timeout); res.end('Authorization declined. Return to your terminal.'); reject(new Error('Authorization declined.')); return; }
        const code = callback.searchParams.get('code');
        if (!code) { res.writeHead(400).end('Missing authorization code.'); return; }
        clearTimeout(timeout);
        res.end('Authorization received. Return to your terminal to confirm completion.');
        resolve(code);
      });
    });
    console.error('Select the Google account to authorize. If needed, open this URL manually:\n' + url);
    openBrowser(url);
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirect });
    // A new account must never inherit a previous account's refresh token.
    if (!tokens.refresh_token) throw new Error('Google returned no refresh token. Revoke this app grant in your Google account and rerun npm run auth.');
    const granted = tokens.scope?.split(' ').filter(Boolean) ?? [];
    if (config.scopes.some(scope => !granted.includes(scope))) throw new Error('Required scopes were not granted. Rerun npm run auth and approve enabled services.');
    await saveTokens(config.tokenPath, { clientId: client._clientId!, scopes: granted, tokens: { ...tokens, refresh_token: tokens.refresh_token } });
    console.error('Authorization saved securely. Run npm run doctor.');
    if (previous && previous.scopes.some(s => !config.scopes.includes(s))) console.error('Services were reduced. Revoke previous grants in your Google account if you also want to remove previously granted permissions.');
  } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void setupAuth().catch(error => {
    const message = error instanceof Error && /^(Google returned no refresh|Required scopes|Authorization timed|Authorization declined|Cannot read Desktop)/.test(error.message) ? error.message
      : 'Authorization failed. Check Desktop OAuth credentials, consent configuration, and loopback connectivity, then retry.';
    console.error(message); process.exitCode = 1;
  });
}
