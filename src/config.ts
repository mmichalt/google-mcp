import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const services = z
    .array(z.enum(['forms', 'drive', 'tasks', 'sheets', 'docs', 'meet', 'calendar', 'gmail']))
    .min(1)
    .parse((env.GOOGLE_MCP_SERVICES ?? 'forms,drive').split(',').map((s) => s.trim()));
  const attachments = z.enum(['true', 'false']).parse(env.GOOGLE_MCP_DRIVE_ATTACHMENTS ?? 'false') === 'true';
  if (attachments && !services.includes('drive')) throw new Error('Enable drive before opting into attachment access.');
  const gmailSend = z.enum(['true', 'false']).parse(env.GOOGLE_MCP_GMAIL_SEND ?? 'false') === 'true';
  if (gmailSend && !services.includes('gmail')) throw new Error('Enable gmail before opting into sending mail.');
  const authDir =
    env.GOOGLE_MCP_AUTH_DIR ??
    (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? homedir(), 'google-mcp') : join(homedir(), '.google-mcp'));
  if (!isAbsolute(authDir)) throw new Error('GOOGLE_MCP_AUTH_DIR must be an absolute path.');
  const credentialsPath = env.GOOGLE_MCP_CREDENTIALS ?? join(authDir, 'credentials.json');
  if (!isAbsolute(credentialsPath)) throw new Error('GOOGLE_MCP_CREDENTIALS must be an absolute path.');
  const scopes = [
    ...(services.includes('forms')
      ? ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly']
      : []),
    ...(services.includes('drive')
      ? [
          attachments
            ? 'https://www.googleapis.com/auth/drive.readonly'
            : 'https://www.googleapis.com/auth/drive.metadata.readonly',
        ]
      : []),
    ...(services.includes('tasks') ? ['https://www.googleapis.com/auth/tasks'] : []),
    ...(services.includes('sheets') ? ['https://www.googleapis.com/auth/spreadsheets'] : []),
    ...(services.includes('docs') ? ['https://www.googleapis.com/auth/documents'] : []),
    ...(services.includes('meet') ? ['https://www.googleapis.com/auth/meetings.space.readonly'] : []),
    ...(services.includes('calendar')
      ? [
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.events.freebusy',
        ]
      : []),
    ...(services.includes('gmail')
      ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']
      : []),
  ];
  return {
    services,
    attachments,
    gmailSend,
    authDir,
    credentialsPath,
    tokenPath: join(authDir, 'tokens.json'),
    scopes,
    port: z.coerce
      .number()
      .int()
      .min(0)
      .max(65535)
      .parse(env.GOOGLE_MCP_AUTH_PORT ?? 0),
  };
}
export type Config = ReturnType<typeof readConfig>;
