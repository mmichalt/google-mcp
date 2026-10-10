import { forms_v1 } from 'googleapis/build/src/apis/forms/v1.js';
import { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import type { OAuth2Client } from 'google-auth-library';
import { setTimeout as delay } from 'node:timers/promises';

export function createClients(auth: OAuth2Client) {
  const options = { auth, retry: false, timeout: 30000 };
  return { forms: new forms_v1.Forms(options), drive: new drive_v3.Drive(options) };
}
export type Clients = ReturnType<typeof createClients>;
export class UserError extends Error {}
function details(error: unknown) {
  if (!error || typeof error !== 'object') return { status: undefined, reasons: [] as string[], oauth: undefined };
  const e = error as { response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[] } } }; code?: number };
  const payload = e.response?.data?.error;
  return { status: e.response?.status ?? e.code, oauth: typeof payload === 'string' ? payload : undefined,
    reasons: payload && typeof payload === 'object' ? payload.errors?.map(x => x.reason ?? '') ?? [] : [] };
}
export function safeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const { status, oauth, reasons } = details(error);
  if (status === 401 || oauth === 'invalid_grant') return 'Google authorization expired or was revoked. Run npm run auth and select the correct account.';
  if (status === 429 || reasons.some(r => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r))) return 'Google rate limit reached. Wait and retry.';
  if (status === 403) return 'Google denied access. Check account sharing, enabled APIs, consent scopes, and Workspace policy; rerun npm run auth if scopes changed.';
  if (status === 404) return 'Google resource not found or inaccessible. Check the ID and account.';
  if (status === 400 || status === 409 || status === 412) return 'Google rejected the input or form revision. Retrieve the latest form and review the change before retrying.';
  return 'Google request failed. Check connectivity and run npm run doctor. A write may have succeeded; inspect the resource before retrying.';
}
// Retry reads only: a lost write response must never create a duplicate form or question.
export async function apiCall<T>(operation: () => Promise<{ data: T }>, readOnly = true,
  sleep: (ms: number) => Promise<unknown> = delay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return (await operation()).data; }
    catch (error) {
      const { status, reasons } = details(error);
      const transient = status === 429 || (typeof status === 'number' && status >= 500) ||
        (status === 403 && reasons.some(r => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r)));
      if (!readOnly || !transient || attempt >= 3) throw error;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
}
