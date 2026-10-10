import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeError, UserError } from '../google/client.js';

export function register<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  readOnly = true,
  destructive = false,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.strictObject(shape),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: readOnly || name !== 'forms_create',
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
