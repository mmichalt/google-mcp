import type { McpServer } from '@modelcontextprotocol/server';
import type { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { register, id, page } from './register.js';
const fields = 'id,name,mimeType,description,parents,webViewLink,createdTime,modifiedTime,size,trashed,capabilities,owners,driveId';
export function registerDrive(server: McpServer, api: drive_v3.Drive) {
  register(server, 'drive_list_files', 'Search Drive metadata. Use formsOnly=true to discover Google Forms; returns one page.', {
    ...page, q: z.string().optional(), formsOnly: z.boolean().default(false), includeTrashed: z.boolean().default(false),
  }, ({ formsOnly, includeTrashed, q, ...pagination }) => {
    const clauses = [q ? `(${q})` : '', formsOnly ? "mimeType = 'application/vnd.google-apps.form'" : '', includeTrashed ? '' : 'trashed = false'].filter(Boolean);
    return apiCall(() => api.files.list({ ...pagination, q: clauses.join(' and ') || undefined,
      fields: `nextPageToken,incompleteSearch,files(${fields})`, supportsAllDrives: true, includeItemsFromAllDrives: true }));
  });
  register(server, 'drive_get_file', 'Read file metadata, including uploaded attachment metadata; never downloads content.', { fileId: id }, input => apiCall(() => api.files.get({ ...input, fields, supportsAllDrives: true })));
  register(server, 'drive_get_folder', 'Read folder metadata and verify its MIME type.', { folderId: id }, async ({ folderId }) => {
    const file = await apiCall(() => api.files.get({ fileId: folderId, fields, supportsAllDrives: true }));
    if (file.mimeType !== 'application/vnd.google-apps.folder') throw new UserError('The supplied ID is not a Drive folder.');
    return file;
  });
  register(server, 'drive_get_file_permissions', 'Read one page of sharing permissions. Metadata scope may be insufficient under Workspace policy.', {
    fileId: id, ...page,
  }, input => apiCall(() => api.permissions.list({ ...input, fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,allowFileDiscovery,expirationTime,permissionDetails)', supportsAllDrives: true })));
}
