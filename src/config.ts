import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const services = z.array(z.enum(['forms', 'drive'])).min(1).parse(
    (env.GOOGLE_MCP_SERVICES ?? 'forms,drive').split(',').map(s => s.trim()),
  );
  const attachments = z.enum(['true', 'false']).parse(env.GOOGLE_MCP_DRIVE_ATTACHMENTS ?? 'false') === 'true';
  if (attachments && !services.includes('drive')) throw new Error('Enable drive before opting into attachment access.');
  const authDir = env.GOOGLE_MCP_AUTH_DIR ?? (process.platform === 'win32'
    ? join(env.LOCALAPPDATA ?? homedir(), 'google-mcp') : join(homedir(), '.google-mcp'));
  if (!isAbsolute(authDir)) throw new Error('GOOGLE_MCP_AUTH_DIR must be an absolute path.');
  const credentialsPath = env.GOOGLE_MCP_CREDENTIALS ?? join(authDir, 'credentials.json');
  if (!isAbsolute(credentialsPath)) throw new Error('GOOGLE_MCP_CREDENTIALS must be an absolute path.');
  const scopes = [
    ...(services.includes('forms') ? ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'] : []),
    ...(services.includes('drive') ? [attachments ? 'https://www.googleapis.com/auth/drive.readonly' : 'https://www.googleapis.com/auth/drive.metadata.readonly'] : []),
  ];
  return { services, attachments, authDir, credentialsPath, tokenPath: join(authDir, 'tokens.json'), scopes,
    port: z.coerce.number().int().min(0).max(65535).parse(env.GOOGLE_MCP_AUTH_PORT ?? 0) };
}
export type Config = ReturnType<typeof readConfig>;
