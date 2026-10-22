import { setTimeout as delay } from 'node:timers/promises';
import type { OAuth2Client } from 'google-auth-library';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/v3.js';
import { docs_v1 } from 'googleapis/build/src/apis/docs/v1.js';
import { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import { forms_v1 } from 'googleapis/build/src/apis/forms/v1.js';
import { gmail_v1 } from 'googleapis/build/src/apis/gmail/v1.js';
import { meet_v2 } from 'googleapis/build/src/apis/meet/v2.js';
import { sheets_v4 } from 'googleapis/build/src/apis/sheets/v4.js';
import { tasks_v1 } from 'googleapis/build/src/apis/tasks/v1.js';

export function createClients(auth: OAuth2Client) {
  const options = { auth, retry: false, timeout: 30000 };
  return {
    forms: new forms_v1.Forms(options),
    drive: new drive_v3.Drive(options),
    tasks: new tasks_v1.Tasks(options),
    sheets: new sheets_v4.Sheets(options),
    docs: new docs_v1.Docs(options),
    meet: new meet_v2.Meet(options),
    calendar: new calendar_v3.Calendar(options),
    gmail: new gmail_v1.Gmail(options),
  };
}
export type Clients = ReturnType<typeof createClients>;
export class UserError extends Error {}
function details(error: unknown) {
  if (!error || typeof error !== 'object') return { status: undefined, reasons: [] as string[], oauth: undefined };
  const e = error as {
    response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[] } } };
    code?: number;
  };
  const payload = e.response?.data?.error;
  return {
    status: e.response?.status ?? e.code,
    oauth: typeof payload === 'string' ? payload : undefined,
    reasons: payload && typeof payload === 'object' ? (payload.errors?.map((x) => x.reason ?? '') ?? []) : [],
  };
}
export function safeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const { status, oauth, reasons } = details(error);
  if (status === 401 || oauth === 'invalid_grant')
    return 'Google authorization expired or was revoked. Run npm run auth and select the correct account.';
  if (status === 429 || reasons.some((r) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r)))
    return 'Google rate limit reached. Wait and retry.';
  if (status === 403)
    return 'Google denied access. Check account sharing, enabled APIs, consent scopes, and Workspace policy; rerun npm run auth if scopes changed.';
  if (status === 404) return 'Google resource not found or inaccessible. Check the ID and account.';
  if (status === 400 || status === 409 || status === 412)
    return 'Google rejected the request or detected a conflict. Read the latest resource and review the input or revision before retrying.';
  return 'Google request failed. Check connectivity and run npm run doctor. A write may have succeeded; inspect the resource before retrying.';
}
// Retry reads only: a lost write response must never duplicate a change.
export async function apiCall<T>(
  operation: () => Promise<{ data: T }>,
  readOnly = true,
  sleep: (ms: number) => Promise<unknown> = delay,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await operation()).data;
    } catch (error) {
      const { status, reasons } = details(error);
      const transient =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        (status === 403 && reasons.some((r) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r)));
      if (!readOnly || !transient || attempt >= 3) throw error;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
}
