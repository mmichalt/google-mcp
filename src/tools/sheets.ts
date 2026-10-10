import type { McpServer } from '@modelcontextprotocol/server';
import type { sheets_v4 } from 'googleapis/build/src/apis/sheets/v4.js';
import { z } from 'zod';
import { apiCall, UserError } from '../google/client.js';
import { bounded, id, register } from './register.js';

const MAX_CELLS = 10000;
const range = z
  .string()
  .min(1)
  .max(512)
  .describe("Explicit tab and bounded A1 cells, e.g. 'Responses'!A1:D100; no whole columns or named ranges.");
function dimensions(range: string) {
  const match =
    /^(?:'(?:[^']|'')+'|[^'!]+)!\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7})(?::\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7}))?$/.exec(
      range,
    );
  if (!match) throw new UserError("Use an explicit tab and bounded A1 range, e.g. 'Responses'!A1:D100.");
  const column = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const firstColumn = column(match[1]!);
  const lastColumn = column(match[3] ?? match[1]!);
  const firstRow = Number(match[2]);
  const lastRow = Number(match[4] ?? match[2]);
  const rows = lastRow - firstRow + 1;
  const columns = lastColumn - firstColumn + 1;
  if (rows < 1 || columns < 1 || lastColumn > 18278 || lastRow > 10000000 || rows * columns > MAX_CELLS)
    throw new UserError('Use an ordered range within Sheets limits containing at most 10,000 cells.');
  return { rows, columns };
}
const values = z
  .array(
    z
      .array(z.union([z.string(), z.number().finite(), z.boolean()]))
      .min(1)
      .max(MAX_CELLS),
  )
  .min(1)
  .max(MAX_CELLS);
const write = {
  spreadsheetId: id,
  range,
  values,
  valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('RAW'),
  dryRun: z.boolean().default(false),
};
function validateValues(values: z.infer<typeof write.values>) {
  const columns = values[0]!.length;
  if (values.some((row) => row.length !== columns)) throw new UserError('Values must be a rectangular matrix.');
  if (values.length * columns > MAX_CELLS) throw new UserError('Write at most 10,000 cells per request.');
  bounded(values);
  return { rows: values.length, columns };
}

export function registerSheets(server: McpServer, api: sheets_v4.Sheets) {
  register(
    server,
    'sheets_get_spreadsheet',
    'Read spreadsheet and all tab metadata, without grid data. Use sheets_read_range for cell content.',
    { spreadsheetId: id },
    async (input) =>
      bounded(
        await apiCall(() =>
          api.spreadsheets.get({
            ...input,
            includeGridData: false,
            fields: 'spreadsheetId,spreadsheetUrl,properties,sheets(properties)',
          }),
        ),
      ),
  );
  register(
    server,
    'sheets_read_range',
    'Read an explicit tab/range of at most 10,000 cells with a 1 MiB JSON result limit. Dates are serial numbers in UNFORMATTED_VALUE mode.',
    {
      spreadsheetId: id,
      range,
      valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).default('UNFORMATTED_VALUE'),
    },
    async (input) => {
      const { rows, columns } = dimensions(input.range);
      const data = await apiCall(() =>
        api.spreadsheets.values.get({ ...input, majorDimension: 'ROWS', dateTimeRenderOption: 'SERIAL_NUMBER' }),
      );
      if ((data.values?.length ?? 0) > rows || data.values?.some((row) => row.length > columns))
        throw new UserError('Google returned cells outside the requested range. Request a smaller explicit range.');
      return bounded(data);
    },
  );
  register(
    server,
    'sheets_create',
    'Create an empty spreadsheet and return its ID/link. Not idempotent; save the returned ID before retrying.',
    { title: z.string().min(1).max(1000) },
    (input) =>
      apiCall(
        () =>
          api.spreadsheets.create({
            requestBody: { properties: input },
            fields: 'spreadsheetId,spreadsheetUrl,properties,sheets(properties)',
          }),
        false,
      ),
    { readOnly: false, idempotent: false },
  );
  register(
    server,
    'sheets_write_range',
    'Write a bounded rectangular matrix matching an explicit target range. RAW keeps formula-like strings as data; USER_ENTERED enables formula parsing. dryRun previews without writing; no revision guarantee.',
    write,
    ({ spreadsheetId, range, values, valueInputOption, dryRun }) => {
      const target = dimensions(range);
      const matrix = validateValues(values);
      if (matrix.rows !== target.rows || matrix.columns !== target.columns)
        throw new UserError('Values must exactly match the target range dimensions.');
      const request = { spreadsheetId, range, valueInputOption, requestBody: { majorDimension: 'ROWS', values } };
      if (dryRun) return Promise.resolve(bounded({ dryRun: true, ...request }));
      return apiCall(() => api.spreadsheets.values.update(request), false);
    },
    { readOnly: false, destructive: true, idempotent: false },
  );
  register(
    server,
    'sheets_append_rows',
    'Append to the logical table found in an explicit range. Returns Google’s actual updatedRange. Preview cannot reserve a row; never automatically retried after ambiguous failure.',
    write,
    ({ spreadsheetId, range, values, valueInputOption, dryRun }) => {
      const target = dimensions(range);
      const matrix = validateValues(values);
      if (matrix.columns !== target.columns) throw new UserError('Row width must match the append range columns.');
      const request = {
        spreadsheetId,
        range,
        valueInputOption,
        insertDataOption: 'INSERT_ROWS',
        requestBody: { majorDimension: 'ROWS', values },
      };
      if (dryRun)
        return Promise.resolve(
          bounded({
            dryRun: true,
            placement: 'Google locates the logical table at apply time; updatedRange is not reserved.',
            ...request,
          }),
        );
      return apiCall(() => api.spreadsheets.values.append(request), false);
    },
    { readOnly: false, idempotent: false },
  );
}
