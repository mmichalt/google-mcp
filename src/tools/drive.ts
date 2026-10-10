import type { Readable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/server';
import type { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { bounded, id, MAX_TEXT_BYTES, page, register } from './register.js';

const fields =
  'id,name,mimeType,description,parents,webViewLink,createdTime,modifiedTime,size,trashed,capabilities,owners,driveId';
export function registerDrive(server: McpServer, api: drive_v3.Drive, contentEnabled = false) {
  register(
    server,
    'drive_list_files',
    'Search Drive metadata. Use formsOnly=true to discover Google Forms; returns one page.',
    {
      ...page,
      q: z.string().optional(),
      formsOnly: z.boolean().default(false),
      includeTrashed: z.boolean().default(false),
    },
    ({ formsOnly, includeTrashed, q, ...pagination }) => {
      const clauses = [
        q ? `(${q})` : '',
        formsOnly ? "mimeType = 'application/vnd.google-apps.form'" : '',
        includeTrashed ? '' : 'trashed = false',
      ].filter(Boolean);
      return apiCall(() =>
        api.files.list({
          ...pagination,
          q: clauses.join(' and ') || undefined,
          fields: `nextPageToken,incompleteSearch,files(${fields})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      );
    },
  );
  register(
    server,
    'drive_get_file',
    'Read file metadata, including uploaded attachment metadata; never downloads content.',
    { fileId: id },
    (input) => apiCall(() => api.files.get({ ...input, fields, supportsAllDrives: true })),
  );
  register(
    server,
    'drive_get_folder',
    'Read folder metadata and verify its MIME type.',
    { folderId: id },
    async ({ folderId }) => {
      const file = await apiCall(() => api.files.get({ fileId: folderId, fields, supportsAllDrives: true }));
      if (file.mimeType !== 'application/vnd.google-apps.folder')
        throw new UserError('The supplied ID is not a Drive folder.');
      return file;
    },
  );
  register(
    server,
    'drive_get_file_permissions',
    'Read one page of sharing permissions. Metadata scope may be insufficient under Workspace policy.',
    {
      fileId: id,
      ...page,
    },
    (input) =>
      apiCall(() =>
        api.permissions.list({
          ...input,
          fields:
            'nextPageToken,permissions(id,type,role,emailAddress,domain,allowFileDiscovery,expirationTime,permissionDetails)',
          supportsAllDrives: true,
        }),
      ),
  );
  if (contentEnabled)
    register(
      server,
      'drive_read_text',
      'Read supported UTF-8 text blobs or export native Docs/Slides as text/plain. Download and JSON output are bounded to 1 MiB. Sheets, PDF, Office and binary extraction are unsupported.',
      { fileId: id },
      async ({ fileId }) => {
        const file = await apiCall(() =>
          api.files.get({ fileId, fields: 'id,name,mimeType,size,capabilities(canDownload)', supportsAllDrives: true }),
        );
        if (!file.capabilities?.canDownload)
          throw new UserError('Google does not allow downloading this file. Check its download permissions.');
        const mimeType = file.mimeType ?? '';
        const native = ['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation'].includes(
          mimeType,
        );
        const blob =
          mimeType.startsWith('text/') ||
          ['application/json', 'application/xml', 'application/x-ndjson', 'application/javascript'].includes(mimeType);
        if (!native && !blob)
          return {
            supported: false,
            fileId,
            mimeType,
            message:
              'Unsupported text format. Use the Sheets API for tab-specific ranges; binary/PDF/Office extraction is unavailable.',
          };
        if (!native && file.size && BigInt(file.size) > BigInt(MAX_TEXT_BYTES))
          throw new UserError('File exceeds the 1 MiB download limit.');
        const text = await apiCall(async () => {
          const options = { responseType: 'stream' as const, signal: AbortSignal.timeout(30000) };
          const response = native
            ? await api.files.export({ fileId, mimeType: 'text/plain' }, options)
            : await api.files.get({ fileId, alt: 'media', supportsAllDrives: true }, options);
          const stream: Readable = response.data;
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            for await (const chunk of stream) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > MAX_TEXT_BYTES) throw new UserError('Download exceeds the 1 MiB limit.');
              chunks.push(buffer);
            }
            try {
              return { data: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
            } catch {
              throw new UserError('The file is not valid UTF-8 text.');
            }
          } finally {
            stream.destroy();
          }
        });
        return bounded({
          supported: true,
          fileId,
          name: file.name,
          sourceMimeType: mimeType,
          format: native ? 'text/plain' : mimeType,
          encoding: 'UTF-8',
          bytes: Buffer.byteLength(text),
          text,
        });
      },
    );
}
