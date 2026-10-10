import type { McpServer } from '@modelcontextprotocol/server';
import type { tasks_v1 } from 'googleapis/build/src/apis/tasks/v1.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { page, register } from './register.js';

const taskId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_=-]+$/, 'Use a Tasks ID, not a URL.');
const tasklist = z.union([z.literal('@default'), taskId]);
const title = z.string().min(1).max(1024);
const notes = z.string().max(8192);
const scheduledDate = z.iso.date().describe('Scheduled day (YYYY-MM-DD); Google discards time.');

export function registerTasks(server: McpServer, api: tasks_v1.Tasks) {
  register(
    server,
    'tasks_list_tasklists',
    'Read one page of your task lists. Pass nextPageToken as pageToken to continue.',
    page,
    ({ pageSize, pageToken }) => apiCall(() => api.tasklists.list({ maxResults: pageSize, pageToken })),
  );
  register(
    server,
    'tasks_list_tasks',
    'Read one task page, including assignmentInfo when requested. Completed and hidden tasks have explicit filters.',
    {
      tasklist,
      ...page,
      showCompleted: z.boolean().default(false),
      showHidden: z.boolean().default(false),
      showAssigned: z.boolean().default(false),
    },
    ({ pageSize, ...input }) => apiCall(() => api.tasks.list({ ...input, maxResults: pageSize, showDeleted: false })),
  );
  register(
    server,
    'tasks_create_task',
    'Create a personal task with an optional scheduled date, not a timed deadline or reminder. Save the returned ID before retrying.',
    { tasklist, title, notes: notes.optional(), scheduledDate: scheduledDate.optional() },
    ({ tasklist, title, notes, scheduledDate }) =>
      apiCall(
        () =>
          api.tasks.insert({
            tasklist,
            requestBody: { title, notes, due: scheduledDate ? `${scheduledDate}T00:00:00.000Z` : undefined },
          }),
        false,
      ),
    { readOnly: false, idempotent: false },
  );
  register(
    server,
    'tasks_update_task',
    'Patch only supplied fields; status completes or reopens a task. null clears the scheduled date. Docs-assigned tasks cannot have notes.',
    {
      tasklist,
      task: taskId,
      title: title.optional(),
      notes: notes.optional(),
      scheduledDate: scheduledDate.nullable().optional(),
      status: z.enum(['needsAction', 'completed']).optional(),
    },
    async ({ tasklist, task, scheduledDate, ...fields }) => {
      const requestBody: tasks_v1.Schema$Task = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      if (fields.status === 'needsAction') requestBody.completed = null;
      if (scheduledDate !== undefined)
        requestBody.due = scheduledDate === null ? null : `${scheduledDate}T00:00:00.000Z`;
      if (!Object.keys(requestBody).length) throw new UserError('Supply at least one task field to update.');
      if (fields.notes !== undefined) {
        const current = await apiCall(() => api.tasks.get({ tasklist, task }));
        if (current.assignmentInfo?.surfaceType === 'DOCUMENT')
          throw new UserError('Tasks assigned from Google Docs cannot have notes. Edit the source document instead.');
      }
      return apiCall(() => api.tasks.patch({ tasklist, task, requestBody }), false);
    },
    { readOnly: false, idempotent: true },
  );
}
