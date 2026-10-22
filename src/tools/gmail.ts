import type { McpServer } from '@modelcontextprotocol/server';
import type { gmail_v1 } from 'googleapis/build/src/apis/gmail/v1.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { bounded, id, MAX_TEXT_BYTES, page, register } from './register.js';

const address = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/, 'Use a bare ASCII email address.');
const compose = {
  to: z.array(address).min(1).max(100),
  subject: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, 'Subject must be a single line.'),
  body: z.string().max(200000),
  dryRun: z.boolean().default(false),
};
function partText(part: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart & { text?: string } {
  let text: string | undefined;
  if (!part.filename && /^text\/(plain|html)$/i.test(part.mimeType ?? '') && part.body?.data) {
    const contentType = part.headers?.find((header) => header.name?.toLowerCase() === 'content-type')?.value ?? '';
    const charset = /charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    try {
      if (!/^[\w-]*={0,2}$/.test(part.body.data)) throw new Error('Invalid base64url');
      text = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true }).decode(
        Buffer.from(part.body.data, 'base64url'),
      );
    } catch {
      throw new UserError('Message text uses an unsupported charset or invalid encoding. Read it in Gmail.');
    }
  }
  return {
    ...part,
    body: part.body ? { size: part.body.size, attachmentId: part.body.attachmentId } : undefined,
    text,
    parts: part.parts?.map(partText),
  };
}
function messageText(message: gmail_v1.Schema$Message) {
  return { ...message, payload: message.payload ? partText(message.payload) : undefined };
}

export function registerGmail(server: McpServer, api: gmail_v1.Gmail, send: boolean) {
  register(
    server,
    'gmail_list_messages',
    'Search one page of message IDs using Gmail query syntax. Read message bodies with gmail_get_message. Spam and trash are excluded by default.',
    { q: z.string().min(1).max(2000).optional(), includeSpamTrash: z.boolean().default(false), ...page },
    async ({ pageSize, ...input }) =>
      bounded(await apiCall(() => api.users.messages.list({ userId: 'me', ...input, maxResults: pageSize }))),
  );
  register(
    server,
    'gmail_get_message',
    'Read headers and decoded plain-text/HTML MIME parts. HTML is returned as text, never rendered. Attachments remain metadata only; externally stored body parts are not downloaded.',
    { messageId: id },
    async ({ messageId }) =>
      bounded(
        messageText(
          await apiCall(() =>
            api.users.messages.get(
              { userId: 'me', id: messageId, format: 'full' },
              { maxContentLength: MAX_TEXT_BYTES },
            ),
          ),
        ),
      ),
  );
  register(
    server,
    'gmail_get_thread',
    'Read a bounded thread with decoded text parts and attachment metadata. If too large, use gmail_list_messages and read individual messages.',
    { threadId: id },
    async ({ threadId }) => {
      const thread = await apiCall(() =>
        api.users.threads.get({ userId: 'me', id: threadId, format: 'full' }, { maxContentLength: MAX_TEXT_BYTES }),
      );
      return bounded({ ...thread, messages: thread.messages?.map(messageText) });
    },
  );
  async function prepare(input: z.infer<z.ZodObject<typeof compose>>) {
    bounded(input);
    const profile = await apiCall(() => api.users.getProfile({ userId: 'me' }));
    const from = address.safeParse(profile.emailAddress);
    if (!from.success) throw new UserError('Google returned no supported sender address. Cannot compose mail.');
    // Fold encoded words and base64 body lines to stay within MIME line limits.
    const subject = (input.subject.match(/.{1,10}/gu) ?? [])
      .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`)
      .join('\r\n ');
    const body =
      Buffer.from(input.body.replace(/\r\n|\r|\n/g, '\r\n'))
        .toString('base64')
        .match(/.{1,76}/g)
        ?.join('\r\n') ?? '';
    const raw = Buffer.from(
      [
        `From: ${from.data}`,
        `To: ${input.to.join(',\r\n ')}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
      ].join('\r\n'),
    ).toString('base64url');
    return { from: from.data, raw: bounded({ raw }).raw };
  }
  register(
    server,
    'gmail_create_draft',
    'Create a new plain-text draft from the authenticated account. Preview with dryRun. No attachments or reply threading; never automatically retried.',
    compose,
    async (input) => {
      const { from, raw } = await prepare(input);
      if (input.dryRun) return { ...input, from };
      return bounded(
        await apiCall(() => api.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } }), false),
      );
    },
    { readOnly: false, idempotent: false },
  );
  if (send)
    register(
      server,
      'gmail_send_message',
      'Send a new plain-text email from the authenticated account. Requires explicit confirmSend=true. Preview with dryRun, review recipients and content, then apply. An ambiguous failure may already have sent mail; check Sent before retrying.',
      { ...compose, confirmSend: z.literal(true) },
      async (input) => {
        const { from, raw } = await prepare(input);
        if (input.dryRun) return { ...input, from };
        return bounded(await apiCall(() => api.users.messages.send({ userId: 'me', requestBody: { raw } }), false));
      },
      { readOnly: false, idempotent: false },
    );
}
