import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeError, UserError } from '../google/client.js';

export function register<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  {
    readOnly = true,
    destructive = false,
    idempotent = readOnly,
  }: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  } = {},
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.strictObject(shape),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: idempotent,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(input)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] };
      }
    },
  );
}
export const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Use a Google resource ID, not a URL.');
export const page = {
  pageSize: z.number().int().min(1).max(100).default(100),
  pageToken: z.string().min(1).optional(),
};
export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new UserError(message);
  return value;
}
export const MAX_TEXT_BYTES = 1024 * 1024;
export function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_TEXT_BYTES)
    throw new UserError('Result or input exceeds the 1 MiB payload limit. Request a smaller range or page.');
  return value;
}
