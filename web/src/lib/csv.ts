// Minimal, correct CSV parser.
// - Handles quoted fields with embedded commas, quotes ("" escape) and newlines
// - Handles CRLF and LF line endings
// - Strips a leading UTF-8 BOM
// Returns an array of string-arrays (rows of fields).

export function parseCsv(input: string): string[][] {
  // Strip BOM
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // swallow CR; the following LF (if any) ends the line
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // flush trailing field/row (unless file ended exactly on a newline)
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ---- Importer: detect email / handle columns and produce clean rows --------

export interface ImportRow {
  email: string | null;
  handle: string | null;
  platform: string | null;
}

export interface ImportParseResult {
  rows: ImportRow[];
  emailColumn: string | null;
  handleColumn: string | null;
  total: number;
  withEmail: number;
  handleOnly: number;
  error?: string;
}

const EMAIL_LIKE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Parses an uploaded/pasted CSV for the importer: detects the email and handle
// columns (with or without a header row) and returns rows the import-leads
// edge function understands. The batch label/region/sample-creator are set
// separately in the import form, so the CSV only needs email and/or handle.
export function parseImportCsv(input: string): ImportParseResult {
  const empty: ImportParseResult = {
    rows: [], emailColumn: null, handleColumn: null, total: 0, withEmail: 0, handleOnly: 0,
  };
  const grid = parseCsv(input).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (grid.length === 0) return { ...empty, error: "The file is empty." };

  const headerRaw = grid[0].map((h) => h.trim());
  const header = headerRaw.map((h) => h.toLowerCase());
  const hasHeader = header.some(
    (h) => /e-?mail|mail/.test(h) || /handle|username|tiktok|account|profile|user/.test(h),
  );

  let emailIdx = -1;
  let handleIdx = -1;
  let platformIdx = -1;
  let emailColumn: string | null = null;
  let handleColumn: string | null = null;
  let dataRows = grid;

  if (hasHeader) {
    header.forEach((h, i) => {
      if (emailIdx === -1 && /e-?mail|mail/.test(h)) { emailIdx = i; emailColumn = headerRaw[i]; }
      if (handleIdx === -1 && /handle|username|tiktok|account|profile|user/.test(h)) {
        handleIdx = i; handleColumn = headerRaw[i];
      }
      if (platformIdx === -1 && /platform|network|channel/.test(h)) platformIdx = i;
    });
    dataRows = grid.slice(1);
  } else {
    // Headerless: infer columns from the first row's shape.
    grid[0].forEach((c, i) => {
      if (emailIdx === -1 && EMAIL_LIKE.test(c.trim())) emailIdx = i;
      else if (handleIdx === -1) handleIdx = i;
    });
  }

  const rows: ImportRow[] = [];
  let withEmail = 0;
  let handleOnly = 0;
  for (const cells of dataRows) {
    let email = emailIdx >= 0 ? (cells[emailIdx] ?? "").trim() : "";
    const handle = handleIdx >= 0 ? (cells[handleIdx] ?? "").trim() : "";
    const platform = platformIdx >= 0 ? (cells[platformIdx] ?? "").trim() : "";
    if (!email) {
      const found = cells.find((c) => EMAIL_LIKE.test(c.trim()));
      if (found) email = found.trim();
    }
    if (!email && !handle) continue;
    if (email) withEmail++; else handleOnly++;
    rows.push({ email: email || null, handle: handle || null, platform: platform || null });
  }

  return { rows, emailColumn, handleColumn, total: rows.length, withEmail, handleOnly };
}

// Builds a CSV string (username,email) from lead rows, quoting when needed.
export function toCsv(rows: { username: string; email: string }[]): string {
  const esc = (v: string) =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = ["username,email"];
  for (const r of rows) {
    lines.push(`${esc(r.username)},${esc(r.email)}`);
  }
  return lines.join("\r\n");
}
