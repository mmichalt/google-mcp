# google-mcp

A standalone Google Workspace MCP server for local developer tools. Node.js + strict TypeScript, the official MCP v2 server SDK, Google's official API/OAuth libraries, Zod, and stdio. No application-specific workflows, database, web app, or deployment infrastructure.

## Requirements and installation

Use Node.js 22.13+ (or Node.js 24 LTS), npm, and a Google account. Install this independent repository in a permanent location; clients launch its compiled JavaScript by absolute path.

```sh
npm ci
npm run check
```

`check` runs Biome (lint and import sorting), Prettier formatting checks, TypeScript, mocked Vitest tests, and builds `dist/`. Use `npm run lint:fix` to apply import sorting and safe lint fixes, and `npm run format` to format code and configuration. Both tools respect `.gitignore` and exclude the npm lockfile; Prettier also excludes Markdown. GitHub Actions runs these checks on pushes and pull requests using Node 24. Runtime dependencies are `@modelcontextprotocol/server`, `googleapis`, `google-auth-library`, and `zod`. The lockfile records the tested versions. Official documentation and npm versions were checked on October 8, 2026; this implementation uses MCP server 2.3.1 and googleapis 184.0.0. Tests do not need Google credentials.

## Google Cloud setup

1. Create or select a dedicated project in [Google Cloud Console](https://console.cloud.google.com/).
2. In **APIs & Services → Library**, enable **Google Forms API** for Forms and **Google Drive API** for Drive. Enable only the services you use.
3. In **Google Auth Platform**, configure branding, audience, and data access (OAuth consent). Choose Internal if your Workspace organization supports it; otherwise External. For an External app in Testing, add your Google account as a test user. Workspace administrators may need to allow the app/scopes. External Testing refresh tokens commonly expire after seven days; use an appropriate production consent configuration for longer-lived usage. Broader scopes can require verification when distributing an app to others.
4. Create an OAuth client of type **Desktop app**, and download its JSON credentials. A Web application OAuth client is not supported by this server. Keep the JSON outside repositories, preferably in the private auth directory below, named `credentials.json`. Do not share it.
5. Choose your enabled services and authorize them using the commands below. No manually generated refresh token is needed.

See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Forms authorization guide](https://developers.google.com/workspace/forms/api/guides/authorizing).

## Shared configuration and first-time authorization

The default auth directory is `~/.google-mcp` on Linux, macOS and WSL; on Windows it is `%LOCALAPPDATA%\google-mcp` (falling back to the user profile). It stores `tokens.json`; the default credentials path is `credentials.json` in that directory. This shared location works across projects without project-local authentication.

Configuration uses environment variables. `.env.example` is a template; the program **does not automatically load `.env` files**. Use the same service selection and auth directory for setup and the MCP client.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_MCP_SERVICES` | `forms,drive` | Comma-separated enabled services: `forms`, `drive`, or both |
| `GOOGLE_MCP_CREDENTIALS` | `<auth-dir>/credentials.json` | Absolute path to Desktop client JSON |
| `GOOGLE_MCP_AUTH_DIR` | Platform location above | Absolute path to a dedicated, private directory shared across projects |
| `GOOGLE_MCP_DRIVE_ATTACHMENTS` | `false` | Explicit opt-in to broader read-only Drive content access |
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

Scope names above have the prefix `https://www.googleapis.com/auth/`. Arbitrary existing forms need Forms access; `drive.file` would restrict discovery to app-authorized files. Drive tools never modify files. Default Drive access reads attachment **metadata**; response tools return uploaded-file references. There is no content-download tool in v1, even with the broader scope.

Desktop OAuth does not support Google's incremental-authorization flow. When enabling another service, rerun auth to request exactly the current service scopes. Disabling a service stops registration of its tools, but does not revoke Google's previous grant; revoke the app under your Google account's connected apps if you also need to remove previously granted permissions, then authorize again. The server checks saved scope coverage before starting.

`npm run doctor` checks access-token availability and Drive connectivity when enabled. A supplied form ID also checks Forms connectivity. Without an ID, it explicitly reports Forms as untested; there is no Forms list endpoint. Diagnostics go to stderr.

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

Tool results contain JSON in MCP text content. Validation and API errors return `isError: true` with safe recovery messages. Google IDs are accepted, not URLs. Read operations use bounded retries for rate limits and server failures; writes are never automatically retried, because an ambiguous response might otherwise cause duplicates. API calls time out after 30 seconds.

| Tool | Purpose |
| --- | --- |
| `forms_get` | Full form metadata, settings and items |
| `forms_create` | Create an empty form; unpublished by default |
| `forms_update` | Change responder title/description |
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

Example arguments:

```json
{"tool":"drive_list_files","arguments":{"formsOnly":true,"q":"name contains 'Survey'","pageSize":20}}
{"tool":"forms_create","arguments":{"title":"Feedback","documentTitle":"Feedback survey"}}
{"tool":"forms_get","arguments":{"formId":"FORM_ID"}}
{"tool":"forms_add_question","arguments":{"formId":"FORM_ID","itemId":"contact-name","question":{"type":"short_text","title":"Your name","required":true},"dryRun":true}}
{"tool":"forms_update","arguments":{"formId":"FORM_ID","description":"Please share your feedback","dryRun":true}}
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

Question updates supply the complete supported question configuration; omitted `required` defaults to false. They preserve item/question IDs, descriptions, images, grading and unrelated items using narrow field masks. When replacing choice options, review any manually configured images or section routing: simple string options replace that question's choice configuration. Edits that remove an existing correct answer, or change the type of a graded question, are rejected; update the grading manually in Google Forms first. Grouped/grid/rating questions are not editable in v1. A change between API question types requires `allowTypeChange=true` because it can affect how old answers are interpreted.

Edits fetch the current form and submit `requiredRevisionId`; simultaneous content changes cause rejection instead of overwriting a stale index. For a reviewed preview, apply the same arguments with `dryRun=false` **and `expectedRevisionId` set to the preview's `writeControl.requiredRevisionId`**. Previews are not durable plans, and a series of separate tool calls is not an atomic transaction. Re-fetch and review each step; there is no generic raw batch-update tool. Publication has no revision control in Google's API and uses last-writer-wins semantics; inspect its status before changing it.

Deletion requires `confirmDelete=true`, supports previews, and does nothing if that item is already absent. The server has no form-delete or response-delete tool and never deletes responses deliberately; deleting or changing a question may affect answer visibility in Google's UI. Review destructive edits first. Existing file-upload questions cannot be edited or deleted through these tools.

For responses/files/permissions, pass Google's `nextPageToken` back as `pageToken` with the same query/filter. Response `filter` is Google's expression (for example `timestamp > 2026-01-01T00:00:00Z`). Drive `q` follows the [official Drive query syntax](https://developers.google.com/workspace/drive/api/guides/search-files). `drive_list_files` excludes trash unless `includeTrashed=true` and returns `incompleteSearch` when provided by Google. Permission visibility depends on the requesting account and Workspace policy.

## Google API limitations

- Forms has no general list endpoint; use Drive metadata search with `formsOnly=true`.
- Google's API cannot create file-upload questions. Create/configure them manually in the Forms UI. `forms_get` reads their supported metadata (folder, file types and size/count limits); response tools read uploaded-file IDs and names. Editing other questions leaves uploads untouched. No undocumented upload workaround is used.
- `forms_create` accepts title/document title; description/items/settings need later updates. `forms_update` changes responder title, not the Drive document name. Drive renaming is outside this read-only v1 integration.
- The API exposes only certain settings, such as quiz settings and email collection. This v1 server reads settings but does not provide settings-writing tools. UI-only options such as presentation theme and many responder restrictions cannot be controlled here. Unsupported settings require manual changes.
- Legacy forms may lack `publishSettings`; the server reports that capability and directs you to the UI. An unpublished form cannot accept responses. Publishing does not grant additional Drive sharing permissions or bypass organization responder restrictions.

See the [Form resource reference](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms), [revision/write controls](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate), and [publication API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/setPublishSettings).

## Troubleshooting and security

**WSL2:** Run setup and the server in the same environment, using the same Linux auth path. If `xdg-open` is unavailable, copy the authorization URL into a Windows browser. Modern WSL localhost forwarding usually makes the loopback callback reachable. If not, enable localhost forwarding in WSL's configuration and restart WSL, or run both setup and the MCP server natively on Windows. A fixed `GOOGLE_MCP_AUTH_PORT` can help diagnose forwarding/firewall problems. Do not change the callback to a remote address or paste authorization codes into chat. Avoid placing tokens on `/mnt/c` where Linux modes may not provide the expected protection. A Windows-hosted client can launch the WSL server using `wsl.exe --exec env GOOGLE_MCP_SERVICES=forms,drive GOOGLE_MCP_CREDENTIALS=/linux/path/credentials.json node /linux/path/google-mcp/dist/src/server.js`; use your Linux Node executable's absolute path if it is managed by nvm. Native Windows Node cannot directly use a WSL Linux entry-point path.

**Revoked/expired authorization:** Run `npm run auth`, select the correct account, then run `npm run doctor -- FORM_ID`. If Google returns no refresh token, revoke this app's existing grant in your Google account and authorize again. If additional scopes are needed, authorize with matching enabled services and grant the requested permissions. If a resource is missing or forbidden, check the account, sharing, enabled APIs and admin policy. Rate limits use short bounded read retries; after exhaustion, wait before trying again. A rejected revision requires a new read/preview.

**Secrets:** Token files are plaintext protected by OS access controls, not encryption. On POSIX, the server creates the dedicated auth directory with mode `0700` and token files with `0600`. On Windows, use a private user-profile directory with restrictive inherited NTFS ACLs; Node's Unix mode flags do not enforce Windows ACLs. For a custom location, ensure only your user can access it. Protect downloaded credentials the same way. Anyone with your local OS account's access can use these grants. Use separate auth directories for distinct accounts, and do not run multiple auth setup flows for the same directory at once. Excluded credential/token files must remain outside version control and synced public folders. If accidentally exposed, revoke the Google app grant and replace affected credentials.

**Data and logs:** Google error payloads, request objects, OAuth credentials and tokens are never included in diagnostics or MCP error responses. Auth setup prints only the public authorization URL (which contains a short-lived state/PKCE challenge). Tool results intentionally contain requested form content, respondent data, uploaded-file references, owner metadata and permissions; treat your MCP client and its conversation history as trusted recipients. Tokens/scopes may remain granted after disabling tools until revoked at Google.

## Testing and adding services

```sh
npm run check
# Optional live read-only integration test (explicit opt-in):
GOOGLE_MCP_INTEGRATION=true GOOGLE_MCP_TEST_FORM_ID=YOUR_FORM_ID npm test
```

For PowerShell, set the two integration variables with `$env:NAME = 'value'` before `npm test`, and remove them afterward. The live test reads the supplied form, one response page and Drive metadata/discovery for enabled services; it creates or modifies nothing. It is skipped by default. No live Google integration has been verified as part of the initial implementation. The compiled stdio smoke test uses fake local credentials and performs discovery plus a validated tool invocation without network access; the unit tests exercise tools through an actual MCP client with mocked Google APIs.

To add Sheets, Docs, Gmail or Calendar later, implement its tools in `src/tools/`, add the official API client in `src/google/client.ts`, add its opt-in service/scopes in `src/config.ts`, and register its tools conditionally in `src/server.ts`. Reuse OAuth and the small registration/error helpers. Do not enable new services by default. None of these additional integrations is implemented in v1.
