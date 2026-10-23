# google-mcp

A standalone Google Workspace MCP server for local developer tools. Node.js + strict TypeScript, the official MCP v2 server SDK, Google's official API/OAuth libraries, Zod, and stdio. No application-specific workflows, database, web app, or deployment infrastructure.

Forms and Drive metadata are enabled by default (15 tools). Tasks, Sheets, Docs, Meet, Calendar and Gmail are independent opt-ins; Drive text access and Gmail sending have separate flags. Enabling all services and Drive text access exposes 42 tools; enabling Gmail sending adds one more (43 total). All writes avoid automatic retries.

## Requirements and installation

Use Node.js 22.13+ (or Node.js 24 LTS), npm, and a Google account. Install this independent repository in a permanent location; clients launch its compiled JavaScript by absolute path.

```sh
npm ci
npm run check
```

`check` runs Biome (lint and import sorting), Prettier formatting checks, TypeScript, mocked Vitest tests, and builds `dist/`. Use `npm run lint:fix` to apply import sorting and safe lint fixes, and `npm run format` to format code and configuration. Both tools respect `.gitignore` and exclude the npm lockfile; Prettier also excludes Markdown. GitHub Actions runs these checks on pushes and pull requests using Node 24. Runtime dependencies are `@modelcontextprotocol/server`, `googleapis`, `google-auth-library`, and `zod`. The lockfile records the tested versions. Official documentation and npm versions were checked on October 8, 2026; this implementation uses MCP server 2.3.1 and googleapis 184.0.0. Tests do not need Google credentials.

## Google Cloud setup

1. Create or select a dedicated project in [Google Cloud Console](https://console.cloud.google.com/).
2. In **APIs & Services → Library**, enable the corresponding **Google Forms API**, **Google Drive API**, **Google Tasks API**, **Google Sheets API**, **Google Docs API**, **Google Meet API**, **Google Calendar API**, or **Gmail API**. Enable only the services you use.
3. In **Google Auth Platform**, configure branding, audience, and data access (OAuth consent). Choose Internal if your Workspace organization supports it; otherwise External. For an External app in Testing, add your Google account as a test user. Workspace administrators may need to allow the app/scopes. External Testing refresh tokens commonly expire after seven days; use an appropriate production consent configuration for longer-lived usage. Broader scopes can require verification when distributing an app to others.
4. Create an OAuth client of type **Desktop app**, and download its JSON credentials. A Web application OAuth client is not supported by this server. Keep the JSON outside repositories, preferably in the private auth directory below, named `credentials.json`. Do not share it.
5. Choose your enabled services and authorize them using the commands below. No manually generated refresh token is needed.

See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Forms authorization guide](https://developers.google.com/workspace/forms/api/guides/authorizing).

## Shared configuration and first-time authorization

The default auth directory is `~/.google-mcp` on Linux, macOS and WSL; on Windows it is `%LOCALAPPDATA%\google-mcp` (falling back to the user profile). It stores `tokens.json`; the default credentials path is `credentials.json` in that directory. This shared location works across projects without project-local authentication.

Configuration uses environment variables. `.env.example` is a template; the program **does not automatically load `.env` files**. Use the same service selection and auth directory for setup and the MCP client.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_MCP_SERVICES` | `forms,drive` | Comma-separated enabled services: `forms`, `drive`, `tasks`, `sheets`, `docs`, `meet`, `calendar`, `gmail` |
| `GOOGLE_MCP_CREDENTIALS` | `<auth-dir>/credentials.json` | Absolute path to Desktop client JSON |
| `GOOGLE_MCP_AUTH_DIR` | Platform location above | Absolute path to a dedicated, private directory shared across projects |
| `GOOGLE_MCP_DRIVE_ATTACHMENTS` | `false` | Enables `drive_read_text` and broader read-only Drive content access, including files unrelated to attachments; requires `drive` |
| `GOOGLE_MCP_GMAIL_SEND` | `false` | Exposes `gmail_send_message`; requires `gmail`. Tool-level gate only: Gmail's draft scope already permits sending |
| `GOOGLE_MCP_AUTH_PORT` | `0` | Loopback callback port; `0` chooses a free port |

Linux/macOS/WSL example:

```sh
export GOOGLE_MCP_CREDENTIALS='/absolute/path/to/credentials.json'
export GOOGLE_MCP_SERVICES='forms,drive'
npm run auth
npm run doctor -- YOUR_FORM_ID
```

Windows PowerShell example:

```powershell
$env:GOOGLE_MCP_CREDENTIALS = 'C:\Users\you\private\credentials.json'
$env:GOOGLE_MCP_SERVICES = 'forms,drive'
npm run auth
npm run doctor -- YOUR_FORM_ID
```

Setup opens a browser (or prints a URL you can open manually), asks you to select an account, and requests offline consent. It uses a loopback callback bound to `127.0.0.1`, random OAuth state, and PKCE. The callback expires after five minutes. Authorization codes and tokens are never printed. Access tokens refresh automatically using the official Google library, and refreshed credentials are saved atomically. Switching accounts requires rerunning `npm run auth`; a previous account's refresh token is never reused for a new account.

Scopes are selected from enabled services:

| Service/opt-in | Scopes |
| --- | --- |
| Forms | `forms.body`, `forms.responses.readonly` |
| Drive default | `drive.metadata.readonly` |
| Drive attachment opt-in | `drive.readonly` replaces `drive.metadata.readonly` |
| Tasks | `tasks` |
| Sheets | `spreadsheets` |
| Docs | `documents` |
| Meet | `meetings.space.readonly` |
| Calendar | `calendar.calendarlist.readonly`, `calendar.events`, `calendar.events.freebusy` |
| Gmail | `gmail.readonly`, `gmail.compose` |

Scope names above have the prefix `https://www.googleapis.com/auth/`. Arbitrary existing forms need Forms access; `drive.file` would restrict discovery to app-authorized files. Drive tools never modify files. Default Drive access reads attachment **metadata**; response tools return uploaded-file references. The content flag retains its attachment-oriented name for compatibility, but enables text access to any accessible supported Drive file. Sheets and Docs writes use their own service scopes and require no writable Drive permission. Meet transcript entries require no Drive permission.

Calendar requests event access, calendar-list reads and free/busy access without calendar or sharing management. Gmail's [read and compose scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) are restricted scopes; public distribution can require verification. `gmail.compose` authorizes both drafts and sending at Google. `GOOGLE_MCP_GMAIL_SEND=false` hides the sending tool; it does not remove that OAuth capability. Enabling the sending tool after Gmail authorization needs no additional scope.

Desktop OAuth does not support Google's incremental-authorization flow. When enabling another service, rerun auth to request exactly the current service scopes. Disabling a service stops registration of its tools, but does not revoke Google's previous grant; revoke the app under your Google account's connected apps if you also need to remove previously granted permissions, then authorize again. The server checks saved scope coverage before starting.

`npm run doctor` checks access-token availability and cheap read connectivity for enabled Drive, Tasks, Meet, Calendar (calendar list) and Gmail (profile) services. A supplied form ID (or `GOOGLE_MCP_TEST_FORM_ID`) checks Forms. Set `GOOGLE_MCP_TEST_SPREADSHEET_ID` and `GOOGLE_MCP_TEST_DOCUMENT_ID` for Sheets and Docs checks. It explicitly reports resource-dependent services without IDs, Drive content downloads, Calendar writes/free-busy, and Gmail bodies/drafts/sending as untested. Diagnostics go to stderr; doctor never writes to Google.

To opt into additional services, enable their Cloud APIs, select the same services for auth and client registration, and rerun authorization:

```sh
export GOOGLE_MCP_SERVICES='forms,drive,tasks,sheets,docs,meet,calendar,gmail'
export GOOGLE_MCP_DRIVE_ATTACHMENTS='true'
npm run auth
npm run doctor
```

Include matching `--env GOOGLE_MCP_SERVICES=...` and `--env GOOGLE_MCP_DRIVE_ATTACHMENTS=true` settings in the registration command below. To expose Gmail sending, also set `GOOGLE_MCP_GMAIL_SEND=true` in the MCP client's environment.

## Register globally in Codex

Build once and register the compiled entry point with the **same environment settings used for auth**:

```sh
npm run build
codex mcp add google-workspace \
  --env GOOGLE_MCP_SERVICES=forms,drive \
  --env GOOGLE_MCP_CREDENTIALS=/absolute/path/to/credentials.json \
  -- node /absolute/path/to/google-mcp/dist/src/server.js
codex mcp list
```

If needed, use an absolute `node` executable path, and include `--env GOOGLE_MCP_AUTH_DIR=/absolute/private/path` for a custom auth directory. Include `--env GOOGLE_MCP_DRIVE_ATTACHMENTS=true` only after authorizing that opt-in. On PowerShell, enter the registration command on one line and quote paths containing spaces.

Codex CLI and its VS Code extension can use the user-level configuration at `~/.codex/config.toml`. An equivalent global entry is:

```toml
[mcp_servers.google-workspace]
command = "node"
args = ["/absolute/path/to/google-mcp/dist/src/server.js"]

[mcp_servers.google-workspace.env]
GOOGLE_MCP_SERVICES = "forms,drive"
GOOGLE_MCP_CREDENTIALS = "/absolute/path/to/credentials.json"
```

For native Windows TOML paths, use forward slashes or TOML literal strings to avoid backslash escaping. Restart the client/extension after configuration changes; use `/mcp` in Codex CLI to inspect tools. Other MCP clients can launch the same command, args and environment using their stdio configuration. Launch **Node directly**, since npm emits script banners to stdout. The server reserves stdout for protocol messages and sends diagnostics to stderr. This local server's Google authorization is performed by `npm run auth`, not `codex mcp login`.

See [official Codex MCP setup](https://developers.openai.com/codex/mcp) and [official MCP v2 stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio).

## Tools and examples

Tool results contain JSON in MCP text content. Validation and API errors return `isError: true` with safe recovery messages. Google IDs are accepted, not URLs; Tasks also accepts `@default` for its task list, and Meet requires structured resource names. Read operations use bounded retries for rate limits and server failures; writes are never automatically retried, because an ambiguous response might otherwise cause duplicates. API calls time out after 30 seconds.

| Tool | Purpose |
| --- | --- |
| `forms_get` | Full form metadata, settings and items |
| `forms_create` | Create an empty form; unpublished by default |
| `forms_update` | Change responder title/description |
| `forms_batch_update` | Apply native item, metadata and settings requests in one revision-guarded batch |
| `forms_add_question` | Add a question with a stable caller-chosen `itemId` |
| `forms_update_question` | Edit a supported single question by `itemId` |
| `forms_delete_question` | Explicitly delete a single question |
| `forms_list_responses` | Read one response page and its continuation token |
| `forms_get_response` | Read a particular response |
| `forms_publish` | Set publication and response acceptance |
| `forms_get_publish_status` | Read publication capability/state |
| `drive_list_files` | Search metadata; `formsOnly` discovers Forms |
| `drive_get_file` | Read file metadata |
| `drive_get_folder` | Read and validate folder metadata |
| `drive_get_file_permissions` | Read paginated sharing permissions |
| `drive_read_text` | Bounded UTF-8 text access; only with the Drive content opt-in |
| `tasks_list_tasklists` | Read one task-list page |
| `tasks_list_tasks` | Read one task page with completed/hidden/assigned filters |
| `tasks_create_task` | Create a personal task with an optional scheduled date |
| `tasks_update_task` | Patch supplied task fields, complete or reopen |
| `sheets_get_spreadsheet` | Read spreadsheet and tab metadata without grid data |
| `sheets_read_range` | Read a bounded range from an explicit tab |
| `sheets_create` | Create a spreadsheet and return its ID/link |
| `sheets_write_range` | Preview or write a bounded rectangular range |
| `sheets_append_rows` | Preview or append to a logical table; return the actual updated range |
| `docs_get` | Read nested tab metadata and bounded plain body text |
| `docs_create` | Create an empty document and return its ID/link |
| `docs_append_text` | Preview or append text to a selected tab with revision protection |
| `docs_replace_text` | Preview or replace literal text in a selected tab with revision protection |
| `meet_list_conferences` | Read one accessible conference page |
| `meet_list_transcripts` | Read one page of existing transcript metadata |
| `meet_list_transcript_entries` | Read one structured transcript-entry page |
| `calendar_list_calendars` | Read one page of calendars with IDs, time zones and access roles |
| `calendar_list_events` | Read one page of events/recurring instances in an explicit time window |
| `calendar_get_event` | Read an event and its etag |
| `calendar_freebusy` | Read busy intervals and per-calendar errors for up to 50 calendars |
| `calendar_create_event` | Preview or create a single timed/all-day event, optionally with guests |
| `calendar_update_event` | Preview or patch event text/times with etag protection |
| `gmail_list_messages` | Search one page of message IDs with Gmail query syntax |
| `gmail_get_message` | Read headers, decoded text/HTML parts and attachment metadata |
| `gmail_get_thread` | Read a bounded thread with decoded text parts |
| `gmail_create_draft` | Preview or create a new plain-text draft |
| `gmail_send_message` | Preview or send a new plain-text message; sending opt-in and `confirmSend: true` required |

Example arguments:

```json
{"tool":"drive_list_files","arguments":{"formsOnly":true,"q":"name contains 'Survey'","pageSize":20}}
{"tool":"forms_create","arguments":{"title":"Feedback","documentTitle":"Feedback survey"}}
{"tool":"forms_get","arguments":{"formId":"FORM_ID"}}
{"tool":"forms_add_question","arguments":{"formId":"FORM_ID","itemId":"contact-name","question":{"type":"short_text","title":"Your name","required":true},"dryRun":true}}
{"tool":"forms_update","arguments":{"formId":"FORM_ID","description":"Please share your feedback","dryRun":true}}
{"tool":"forms_batch_update","arguments":{"formId":"FORM_ID","expectedRevisionId":"REVISION_ID","requests":[{"updateSettings":{"settings":{"quizSettings":{"isQuiz":true}},"updateMask":"quizSettings.isQuiz"}}],"includeFormInResponse":true,"dryRun":true}}
{"tool":"forms_update_question","arguments":{"formId":"FORM_ID","itemId":"contact-name","question":{"type":"short_text","title":"Full name","required":true},"expectedRevisionId":"REVISION_ID","dryRun":true}}
{"tool":"forms_delete_question","arguments":{"formId":"FORM_ID","itemId":"contact-name","confirmDelete":true,"dryRun":true}}
{"tool":"forms_list_responses","arguments":{"formId":"FORM_ID","pageSize":20,"pageToken":"NEXT_PAGE_TOKEN"}}
{"tool":"forms_publish","arguments":{"formId":"FORM_ID","isPublished":true,"isAcceptingResponses":true,"dryRun":true}}
```

Use the `formId` returned by creation; a new form initially contains no questions or description. Add questions and set the description through their tools, then publish explicitly. Creation is not idempotent: retain the returned ID; if a request fails ambiguously, discover the form in Drive before creating again. Reusing an existing `itemId` in `forms_add_question` returns that item unchanged even if the supplied question differs. Use `forms_update_question` to change it. Never use a fresh ID on each retry.

Question objects use a `type`, `title`, and optional `required` (default false):

| `type` | Additional input |
| --- | --- |
| `short_text`, `paragraph` | None |
| `multiple_choice`, `checkboxes`, `dropdown` | Unique, nonempty `options` strings; optional `shuffle` |
| `linear_scale` | `high` (2–10), optional `low` (0 or 1), `lowLabel`, `highLabel` |
| `date` | Optional `includeYear` (default true), `includeTime` (default false) |
| `time` | Optional `duration` (default false) |

Question updates supply the complete supported question configuration; omitted `required` defaults to false. They preserve item/question IDs, descriptions, images, grading and unrelated items using narrow field masks. When replacing choice options, review any manually configured images or section routing: simple string options replace that question's choice configuration. Edits that remove an existing correct answer, or change the type of a graded question, are rejected by `forms_update_question`; update grading manually in Google Forms or explicitly through `forms_batch_update` first. Grouped/grid/rating questions require native batch requests for API-supported edits. A change between API question types through `forms_update_question` requires `allowTypeChange=true` because it can affect how old answers are interpreted.

Edits fetch the current form and submit `requiredRevisionId`; simultaneous content changes cause rejection instead of overwriting a stale index. For a reviewed preview, apply the same arguments with `dryRun=false` **and `expectedRevisionId` set to the preview's `writeControl.requiredRevisionId`**. Previews are not durable plans, and a series of separate tool calls is not an atomic transaction. Re-fetch and review each step. Publication has no revision control in Google's API and uses last-writer-wins semantics; inspect its status before changing it.

`forms_batch_update` accepts a nonempty native `requests` array containing `updateFormInfo`, `updateSettings`, `createItem`, `moveItem`, `deleteItem`, or `updateItem`, with exactly one operation per request. Read the form first and supply its revision as required `expectedRevisionId`; indexes refer to the form as modified by preceding requests in the batch. `dryRun` returns the guarded payload without submitting it to Google, so previews do not validate API-specific item/settings fields. `includeFormInResponse` defaults to false; when true, Google returns the updated form along with replies. Requests are limited to 1 MiB of JSON. Deletions require `confirmDelete: true`, including previews. Native item/settings objects pass through to Google for validation and can change grading, question types and other fields beyond the convenience tools. Review field masks carefully: broad masks can clear existing metadata. Batches are not idempotent and are never automatically retried; inspect the form after an ambiguous error before trying again. See the [native batch request reference](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate).

`forms_delete_question` requires `confirmDelete=true`, supports previews, and does nothing if that item is already absent. The server has no form-delete or response-delete tool and never deletes responses deliberately; deleting or changing a question may affect answer visibility in Google's UI. Review destructive edits first. The convenience question tools reject edits and deletions of file-upload questions; native batch requests follow Google's API restrictions.

For responses/files/permissions, pass Google's `nextPageToken` back as `pageToken` with the same query/filter. Response `filter` is Google's expression (for example `timestamp > 2026-01-01T00:00:00Z`). Drive `q` follows the [official Drive query syntax](https://developers.google.com/workspace/drive/api/guides/search-files). `drive_list_files` excludes trash unless `includeTrashed=true` and returns `incompleteSearch` when provided by Google. Permission visibility depends on the requesting account and Workspace policy.

## Opt-in service arguments and limitations

Tasks list tools accept `pageSize` (1–100) and `pageToken`. Task tools require `tasklist` (a returned list ID or `@default`); updates also require `task`. `tasks_list_tasks` defaults `showCompleted`, `showHidden`, and `showAssigned` to false and excludes deleted tasks. Set both completed/hidden filters to include completed tasks cleared from the UI. Create accepts `title`, optional `notes`, and `scheduledDate` as a valid `YYYY-MM-DD`. Update accepts those optional fields plus `status: "completed" | "needsAction"`; it rejects empty patches, preserves unspecified fields, and accepts `scheduledDate: null` to clear the date or `notes: ""` to clear notes. Docs-assigned tasks reject notes. Assignment metadata is returned when Google provides it; assignment, deletion, clearing and reordering are unavailable. Google's [Tasks resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) stores only the scheduled day, not a timed deadline or reminder.

`drive_read_text` accepts `fileId`, checks download capability, and reads `text/*`, JSON, XML, NDJSON and JavaScript UTF-8 blobs. Native Docs and Slides export as `text/plain` through [Google's download/export APIs](https://developers.google.com/workspace/drive/api/guides/manage-downloads). Results include `sourceMimeType`, `format`, `encoding`, `bytes` and `text`. Invalid UTF-8 and downloads or JSON results over 1 MiB fail; streaming stops at the download bound. Unsupported files return `supported: false` with a format explanation. PDF/OCR, Office and binary extraction, filesystem downloads and Sheets exports are unavailable. Read individual spreadsheet tabs with Sheets; Google's [CSV export covers only the first sheet](https://developers.google.com/workspace/drive/api/guides/ref-export-formats).

Sheets range tools require `spreadsheetId` and an explicit bounded A1 range including the tab, such as `'Form Responses 1'!A1:D100`. Whole columns, named ranges and implicit tabs are unsupported. Reads and writes allow up to 10,000 cells; read results and input values are limited to 1 MiB of JSON. Read uses rows and defaults `valueRenderOption` to `UNFORMATTED_VALUE` (dates are serial numbers); `FORMATTED_VALUE` and `FORMULA` are available. `sheets_get_spreadsheet` returns every tab's properties without grid data; `sheets_create` accepts `title`.

Writes accept rectangular `values` containing strings, finite numbers and booleans, with dimensions exactly matching the target range. Append row width must match its range columns. `valueInputOption` defaults to `RAW` to keep response strings such as `=1+1` as data; explicitly set `USER_ENTERED` for formulas and Google UI-style parsing. `dryRun: true` previews the target and values without writing. Sheets previews have no revision guarantee. [Google's append API](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append) locates the logical table at execution time; a preview cannot reserve an appended row. Apply returns Google's `updates.updatedRange`. All Sheets writes are attempted once; inspect the target after an ambiguous failure before retrying, especially for create and append.

Docs reads accept `documentId`, optional `tabId`, and `maxCharacters` (default 100,000; maximum 200,000 shared across returned tabs). Reads use `includeTabsContent=true` and flatten [nested tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs), retaining their IDs, titles and hierarchy properties. Plain text includes body paragraphs, table cells and table of contents in order; formatting, images, headers, footers and footnotes are omitted. Each tab reports `truncated`; selecting a tab lets you read it with a separate character budget. Results have a 1 MiB JSON limit. Create accepts `title` and creates an empty document.

Docs edits accept `documentId`, optional `tabId`, `dryRun`, and optional `expectedRevisionId`. A tab selection is required when the document has multiple tabs, including nested tabs. Append accepts `text`; replace accepts nonempty `searchText`, `replacementText` (empty is allowed), and `matchCase` (default true). Replacement is literal, never regex, and applies only to the selected tab; Google's replacement can also match headers, footers or footnotes omitted from the plain body read. Each edit fetches the current revision and submits [requiredRevisionId](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate). A preview exposes `writeControl.requiredRevisionId`: pass it as `expectedRevisionId` on apply with identical inputs. A stale preview or concurrent edit rejects the write. Text inputs are limited to 100,000 characters. Create, append and arbitrary replacement are not idempotent and are never automatically retried.

Meet tools accept `pageSize` (1–100) and `pageToken`. Conferences accept an optional [Meet filter expression](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list). Transcripts require `parent: "conferenceRecords/ID"`; entries require `parent: "conferenceRecords/ID/transcripts/ID"`. Both names come from the preceding list results. Empty transcript results without a continuation report `unavailable: true`; these tools retrieve existing accessible artifacts and never enable transcription. Entries retain speaker references, text and timestamps; generated Docs transcripts may differ after manual edits. [Structured entry reads](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list) use the Meet scope alone. Meet results have a 1 MiB JSON limit; use a smaller page if needed. Meeting creation, recording downloads and live media are unavailable.

Calendar tools accept a returned `calendarId` or `primary`. Calendar/event lists use `pageSize` (1–100) and `pageToken`. Event lists require `timeMin` and `timeMax` as timestamps with explicit offsets, expand recurring instances and sort by start time. `calendar_freebusy` takes `calendarIds` (1–50) and the same time window. Returned per-calendar/group errors mean availability is unknown; never interpret an error as a free calendar. Results have a 1 MiB JSON limit.

Calendar create requires `summary`, `start`, `end`, and an explicit `sendUpdates` policy (`all`, `externalOnly`, or `none`); `description`, `location`, and `attendees` (up to 100 email addresses) are optional. Times are either `{ "date": "2026-10-22" }` or `{ "dateTime": "2026-10-22T10:00:00+02:00", "timeZone": "Europe/Warsaw" }`, where `timeZone` is optional. Both endpoints must use the same representation and end after start. All-day end dates are exclusive. `dryRun: true` previews without writing. Google cautions that [`sendUpdates: "none"`](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) can affect external calendar synchronization and some emails may still be sent.

Calendar update accepts `eventId` and patches only supplied `summary`, `description`, `location`, or both `start` and `end`. Empty descriptions/locations clear those fields. It preserves attendees and unrelated properties, rejects recurring series masters and special/cancelled events, and allows ordinary recurring instances returned by event listing. Edits use [If-Match etag protection](https://developers.google.com/workspace/calendar/api/guides/version-resources); apply a reviewed preview with identical arguments and its `expectedEtag`. Creation, deletion, or editing of recurrence rules, guest-list updates and Meet-link creation are outside this version. An ambiguous creation failure may already have created the event; inspect the calendar before retrying.

Gmail list accepts optional `q` using Gmail search syntax, `pageSize` (1–100), `pageToken`, and `includeSpamTrash` (default false). It returns message IDs and thread IDs, not bodies. Message/thread reads accept `messageId`/`threadId` and return native metadata and MIME part structure with decoded plain text or HTML in each part's `text` field. HTML stays a string; no external images or links are fetched. Attachment content is omitted; metadata and attachment IDs remain. Body parts stored separately by Gmail are also metadata-only. Unsupported text charsets/encoding fail explicitly. Read responses and resulting JSON are limited to 1 MiB; large threads must be read as individual messages, and oversized messages must be read in Gmail.

Gmail draft creation accepts `to` (1–100 bare ASCII email addresses), a one-line `subject` (1–200 characters), `body` (up to 200,000 characters), and `dryRun`. Messages use the authenticated account's sender address and UTF-8 plain-text MIME. No attachments, CC/BCC, aliases, reply threading, draft updates or deletion are supported. With `GOOGLE_MCP_GMAIL_SEND=true`, `gmail_send_message` accepts the same fields plus required `confirmSend: true`. Preview with `dryRun: true`, review recipients/content, then apply the same arguments with `dryRun: false`. Previews are not durable plans. Creation and sending are attempted once; check Drafts or Sent after an ambiguous failure before trying again.

```json
{"tool":"tasks_create_task","arguments":{"tasklist":"@default","title":"Review feedback","scheduledDate":"2026-10-12"}}
{"tool":"tasks_update_task","arguments":{"tasklist":"@default","task":"TASK_ID","status":"completed"}}
{"tool":"drive_read_text","arguments":{"fileId":"FILE_ID"}}
{"tool":"sheets_read_range","arguments":{"spreadsheetId":"SHEET_ID","range":"'Form Responses 1'!A1:D100"}}
{"tool":"sheets_write_range","arguments":{"spreadsheetId":"SHEET_ID","range":"Summary!A1:B2","values":[["Answer","Count"],["Yes",12]],"dryRun":true}}
{"tool":"sheets_append_rows","arguments":{"spreadsheetId":"SHEET_ID","range":"Summary!A1:B100","values":[["No",3]],"dryRun":true}}
{"tool":"docs_get","arguments":{"documentId":"DOC_ID"}}
{"tool":"docs_append_text","arguments":{"documentId":"DOC_ID","tabId":"TAB_ID","text":"Feedback summary\n","dryRun":true}}
{"tool":"docs_replace_text","arguments":{"documentId":"DOC_ID","tabId":"TAB_ID","searchText":"Draft","replacementText":"Final","expectedRevisionId":"PREVIEW_REVISION"}}
{"tool":"meet_list_transcripts","arguments":{"parent":"conferenceRecords/CONFERENCE_ID","pageSize":20}}
{"tool":"meet_list_transcript_entries","arguments":{"parent":"conferenceRecords/CONFERENCE_ID/transcripts/TRANSCRIPT_ID","pageSize":20}}
{"tool":"calendar_list_events","arguments":{"calendarId":"primary","timeMin":"2026-10-22T00:00:00Z","timeMax":"2026-10-23T00:00:00Z"}}
{"tool":"calendar_freebusy","arguments":{"calendarIds":["primary"],"timeMin":"2026-10-22T00:00:00Z","timeMax":"2026-10-23T00:00:00Z"}}
{"tool":"calendar_create_event","arguments":{"calendarId":"primary","summary":"Review","start":{"dateTime":"2026-10-22T10:00:00Z"},"end":{"dateTime":"2026-10-22T11:00:00Z"},"sendUpdates":"none","dryRun":true}}
{"tool":"gmail_list_messages","arguments":{"q":"is:unread newer_than:7d","pageSize":20}}
{"tool":"gmail_create_draft","arguments":{"to":["reader@example.com"],"subject":"Review notes","body":"Here are the notes.","dryRun":true}}
```

Workflow composition belongs in the MCP client: discover a Form, read its responses or `linkedSheetId` from `forms_get`, analyze the data, and write an explicit Sheets range or a Docs report. Likewise, read Meet transcript pages, draft notes in the client, then create a Doc and Tasks. No cross-service orchestration or proxy is needed.

## Google API limitations

- Forms has no general list endpoint; use Drive metadata search with `formsOnly=true`.
- Google's API cannot create file-upload questions. Create/configure them manually in the Forms UI. `forms_get` reads their supported metadata (folder, file types and size/count limits); response tools read uploaded-file IDs and names. Editing other questions leaves uploads untouched. No undocumented upload workaround is used.
- `forms_create` accepts title/document title; description/items/settings need later updates. `forms_update` changes responder title, not the Drive document name. Drive renaming is outside this read-only v1 integration.
- The API exposes only certain settings, such as quiz settings and email collection; use `forms_batch_update` with `updateSettings` to write supported fields. UI-only options such as presentation theme and many responder restrictions cannot be controlled here. Unsupported settings require manual changes.
- Legacy forms may lack `publishSettings`; the server reports that capability and directs you to the UI. An unpublished form cannot accept responses. Publishing does not grant additional Drive sharing permissions or bypass organization responder restrictions.

See the [Form resource reference](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms), [revision/write controls](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate), and [publication API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/setPublishSettings).

## Troubleshooting and security

**WSL2:** Run setup and the server in the same environment, using the same Linux auth path. If `xdg-open` is unavailable, copy the authorization URL into a Windows browser. Modern WSL localhost forwarding usually makes the loopback callback reachable. If not, enable localhost forwarding in WSL's configuration and restart WSL, or run both setup and the MCP server natively on Windows. A fixed `GOOGLE_MCP_AUTH_PORT` can help diagnose forwarding/firewall problems. Do not change the callback to a remote address or paste authorization codes into chat. Avoid placing tokens on `/mnt/c` where Linux modes may not provide the expected protection. A Windows-hosted client can launch the WSL server using `wsl.exe --exec env GOOGLE_MCP_SERVICES=forms,drive GOOGLE_MCP_CREDENTIALS=/linux/path/credentials.json node /linux/path/google-mcp/dist/src/server.js`; use your Linux Node executable's absolute path if it is managed by nvm. Native Windows Node cannot directly use a WSL Linux entry-point path.

**Revoked/expired authorization:** Run `npm run auth`, select the correct account, then run `npm run doctor -- FORM_ID`. If Google returns no refresh token, revoke this app's existing grant in your Google account and authorize again. If additional scopes are needed, authorize with matching enabled services and grant the requested permissions. If a resource is missing or forbidden, check the account, sharing, enabled APIs and admin policy. Rate limits use short bounded read retries; after exhaustion, wait before trying again. A rejected revision requires a new read/preview.

**Secrets:** Token files are plaintext protected by OS access controls, not encryption. On POSIX, the server creates the dedicated auth directory with mode `0700` and token files with `0600`. On Windows, use a private user-profile directory with restrictive inherited NTFS ACLs; Node's Unix mode flags do not enforce Windows ACLs. For a custom location, ensure only your user can access it. Protect downloaded credentials the same way. Anyone with your local OS account's access can use these grants. Use separate auth directories for distinct accounts, and do not run multiple auth setup flows for the same directory at once. Excluded credential/token files must remain outside version control and synced public folders. If accidentally exposed, revoke the Google app grant and replace affected credentials.

**Data and logs:** Google error payloads, request objects, OAuth credentials and tokens are never included in diagnostics or MCP error responses. Auth setup prints only the public authorization URL (which contains a short-lived state/PKCE challenge). Tool results intentionally contain requested form content, respondent data, uploaded-file references, owner metadata, permissions, file/document text, spreadsheet values, tasks, meeting transcripts, calendar events and email content; treat your MCP client and its conversation history as trusted recipients. Tokens/scopes may remain granted after disabling tools until revoked at Google.

## Testing and adding services

```sh
npm run check
# Optional live read-only integration test (explicit opt-in):
GOOGLE_MCP_INTEGRATION=true GOOGLE_MCP_TEST_FORM_ID=YOUR_FORM_ID npm test
```

For PowerShell, set the integration variables with `$env:NAME = 'value'` before `npm test`, and remove them afterward. The live test reads enabled services only and creates or modifies nothing. Forms requires `GOOGLE_MCP_TEST_FORM_ID`; Sheets requires `GOOGLE_MCP_TEST_SPREADSHEET_ID`; Docs requires `GOOGLE_MCP_TEST_DOCUMENT_ID`. Tasks reads one list and one task page from `GOOGLE_MCP_TEST_TASKLIST_ID` (default `@default`). Meet lists one conference page and optionally reads transcript metadata/entries from `GOOGLE_MCP_TEST_CONFERENCE_NAME` and `GOOGLE_MCP_TEST_TRANSCRIPT_NAME`. Drive reads discovery and, if a form ID is provided, its metadata. Live tests are skipped by default; no live reads or writes were verified for these new integrations. Validate writes manually on explicitly selected disposable resources before relying on them in production.

Calendar live tests read one calendar page and one primary-calendar event page. Gmail live tests read the profile and one message-ID page; they do not read email bodies, create drafts or send mail.

Compiled stdio smoke tests check default discovery (15 tools), Tasks alone (4), and all opt-ins (43), using fake credentials without network calls. Mocked API tests run through an actual MCP client and cover scope/sending gates, pagination, input/payload bounds, streaming failures, RAW/formula behavior, nested tabs, revision/etag conflicts, Forms native batches and delete consent, Calendar dates and notifications, MIME decoding/encoding, header injection, and writes attempted once after ambiguous failures.

To add another service, implement its tools in `src/tools/`, add the official typed API client in `src/google/client.ts`, add its opt-in service/scopes in `src/config.ts`, and register conditionally in `src/server.ts`. Reuse OAuth and the small registration/error helpers; keep new services disabled by default. Slides, Chat, People, Keep, cross-service search and event watchers remain outside this implementation. Google's [Workspace MCP catalog](https://developers.google.com/workspace/guides/configure-mcp-servers) provides remote options for several of those services; refresh its preview coverage before planning local equivalents.
