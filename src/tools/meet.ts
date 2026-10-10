import type { McpServer } from '@modelcontextprotocol/server';
import type { meet_v2 } from 'googleapis/build/src/apis/meet/v2.js';
import { z } from 'zod';
import { apiCall } from '../google/client.js';
import { bounded, page, register } from './register.js';

const conference = z
  .string()
  .max(512)
  .regex(/^conferenceRecords\/[a-zA-Z0-9_-]+$/, 'Use conferenceRecords/ID.');
const transcript = z
  .string()
  .max(1024)
  .regex(
    /^conferenceRecords\/[a-zA-Z0-9_-]+\/transcripts\/[a-zA-Z0-9_-]+$/,
    'Use conferenceRecords/ID/transcripts/ID.',
  );

export function registerMeet(server: McpServer, api: meet_v2.Meet) {
  register(
    server,
    'meet_list_conferences',
    'Read one page of accessible Meet conference records. filter uses Google Meet filter syntax; nextPageToken continues the same query.',
    { ...page, filter: z.string().min(1).max(4096).optional() },
    async (input) => bounded(await apiCall(() => api.conferenceRecords.list(input))),
  );
  register(
    server,
    'meet_list_transcripts',
    'Read existing, accessible transcript metadata for a conference. Reports unavailable when the result has no transcripts or continuation; does not start transcription.',
    { parent: conference, ...page },
    async (input) => {
      const data = await apiCall(() => api.conferenceRecords.transcripts.list(input));
      const unavailable = !data.transcripts?.length && !data.nextPageToken;
      return bounded({
        ...data,
        unavailable,
        message: unavailable
          ? 'No existing accessible transcripts on this page. Transcription may not have been enabled or retained.'
          : undefined,
      });
    },
  );
  register(
    server,
    'meet_list_transcript_entries',
    'Read one page of structured transcript entries, preserving speaker and timestamps. Entries can differ from a manually edited generated Doc; requires no Drive content permission.',
    { parent: transcript, ...page },
    async (input) => bounded(await apiCall(() => api.conferenceRecords.transcripts.entries.list(input))),
  );
}
