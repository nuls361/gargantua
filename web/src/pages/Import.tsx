import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { parseImportCsv, type ImportParseResult } from "../lib/csv";
import type { ImportBatch, List, Region } from "../lib/types";

interface ImportResult {
  list_id: string;
  total_rows: number;
  inserted: number;
  enriched: number;
  sourced: number;
  filtered: number;
  updated: number;
  duplicates: number;
  reasons: Record<string, number>;
  errors: string[];
}

const REASON_LABELS: Record<string, string> = {
  not_freemail: "Not freemail",
  blocked_domain: "Blocked domain",
  invalid_email: "Invalid email",
  no_email: "No email",
  duplicate: "Duplicate",
  duplicate_in_file: "Duplicate in file",
};

export default function Import() {
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [listMode, setListMode] = useState<"new" | "existing">("new");
  const [newListName, setNewListName] = useState("");
  const [existingListId, setExistingListId] = useState("");
  const [region, setRegion] = useState<Region | "">("");
  const [label, setLabel] = useState("");
  const [sampleCreator, setSampleCreator] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from("imports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    setHistory((data ?? []) as ImportBatch[]);
  }, []);

  const loadLists = useCallback(async () => {
    const { data } = await supabase
      .from("lists")
      .select("*")
      .eq("kind", "working")
      .order("name");
    setLists((data ?? []) as List[]);
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadLists();
  }, [loadHistory, loadLists]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setResult(null);
    setError(null);
    setParsed(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const text = await file.text();
    setParsed(parseImportCsv(text));
  }

  async function doImport() {
    if (!parsed || parsed.rows.length === 0) return;
    if (listMode === "new" && !newListName.trim()) {
      setError("Enter a name for the new list.");
      return;
    }
    if (listMode === "existing" && !existingListId) {
      setError("Choose an existing list.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error: err } = await supabase.functions.invoke("import-leads", {
      body: {
        rows: parsed.rows,
        ...(listMode === "new"
          ? { new_list_name: newListName.trim() }
          : { list_id: existingListId }),
        region: region || null,
        label: label.trim() || null,
        sample_creator: sampleCreator.trim() || null,
        file_name: fileName || null,
      },
    });
    setBusy(false);
    if (err) {
      setError(`Import failed: ${err.message}`);
      return;
    }
    setResult(data as ImportResult);
    setParsed(null);
    void loadHistory();
    void loadLists();
  }

  function reset() {
    setParsed(null);
    setFileName("");
    setResult(null);
    setError(null);
  }

  return (
    <div>
      <h2>Import</h2>
      <p className="muted">
        Upload a CSV of leads into a list. Rows with an email are cleaned
        (freemail-only + blocklist + dedupe) and go in as <b>enriched</b>
        (send-ready); rows with only a handle go in as <b>sourced</b> (to enrich
        later). The whole batch shares a label, region and sample creator.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <div className="field">
          <label>CSV file</label>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
        </div>
        {fileName && <div className="muted">Source: {fileName}</div>}
      </div>

      {parsed && parsed.error && <div className="error">{parsed.error}</div>}

      {parsed && !parsed.error && (
        <>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Preview</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              Detected columns: email →{" "}
              <code>{parsed.emailColumn ?? "—"}</code>, handle →{" "}
              <code>{parsed.handleColumn ?? "—"}</code>
            </div>
            <div className="stat-grid">
              <div className="stat">
                <div className="num">{parsed.total}</div>
                <div className="lbl">Usable rows</div>
              </div>
              <div className="stat">
                <div className="num" style={{ color: "#16794a" }}>
                  {parsed.withEmail}
                </div>
                <div className="lbl">With email → enriched</div>
              </div>
              <div className="stat">
                <div className="num" style={{ color: "#2f6df6" }}>
                  {parsed.handleOnly}
                </div>
                <div className="lbl">Handle only → sourced</div>
              </div>
            </div>
            {parsed.total === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                No email or handle column detected. Add a header row like{" "}
                <code>handle,email</code>.
              </div>
            )}
          </div>

          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Batch properties</h3>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <label>Target list</label>
                <div className="segmented">
                  <button
                    type="button"
                    className={`seg${listMode === "new" ? " active" : ""}`}
                    onClick={() => setListMode("new")}
                  >
                    ➕ New list
                  </button>
                  <button
                    type="button"
                    className={`seg${listMode === "existing" ? " active" : ""}`}
                    onClick={() => setListMode("existing")}
                  >
                    Existing list
                  </button>
                </div>
              </div>
              {listMode === "new" ? (
                <div>
                  <label>New list name</label>
                  <input
                    type="text"
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="e.g. UK Food March"
                    style={{ minWidth: 180 }}
                  />
                </div>
              ) : (
                <div>
                  <label>Choose list</label>
                  <select
                    value={existingListId}
                    onChange={(e) => setExistingListId(e.target.value)}
                  >
                    <option value="">Select a list…</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label>Region</label>
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value as Region | "")}
                >
                  <option value="">—</option>
                  <option value="uk">UK</option>
                  <option value="dach">DACH</option>
                </select>
              </div>
              <div>
                <label>Label</label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. food, beauty"
                  style={{ minWidth: 140 }}
                />
              </div>
              <div>
                <label>Sample creator</label>
                <input
                  type="text"
                  value={sampleCreator}
                  onChange={(e) => setSampleCreator(e.target.value)}
                  placeholder="e.g. @charlidamelio"
                  style={{ minWidth: 160 }}
                />
              </div>
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <div className="grow" />
              <button onClick={reset} disabled={busy}>
                Reset
              </button>
              <button
                className="primary"
                onClick={doImport}
                disabled={busy || parsed.total === 0}
              >
                {busy ? "Importing…" : `Import ${parsed.total} rows`}
              </button>
            </div>
          </div>
        </>
      )}

      {result && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Import complete</h3>
          {result.errors.length > 0 && (
            <div className="error">
              {result.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
          <div className="stat-grid">
            <div className="stat">
              <div className="num" style={{ color: "#16794a" }}>{result.enriched}</div>
              <div className="lbl">Enriched (send-ready)</div>
            </div>
            <div className="stat">
              <div className="num" style={{ color: "#2f6df6" }}>{result.sourced}</div>
              <div className="lbl">Sourced (to enrich)</div>
            </div>
            <div className="stat">
              <div className="num" style={{ color: "#b83636" }}>{result.filtered}</div>
              <div className="lbl">Filtered out</div>
            </div>
            <div className="stat">
              <div className="num">{result.updated}</div>
              <div className="lbl">Updated (existing)</div>
            </div>
            <div className="stat">
              <div className="num">{result.duplicates}</div>
              <div className="lbl">Duplicates skipped</div>
            </div>
          </div>
          {Object.keys(result.reasons).length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Filter reasons:{" "}
              {Object.entries(result.reasons)
                .map(([k, v]) => `${v} ${REASON_LABELS[k] ?? k}`)
                .join(", ")}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <button onClick={reset}>Start a new import</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 28 }}>
        Upload history{history.length > 0 && ` (${history.length})`}
      </h3>
      {history.length === 0 ? (
        <p className="muted">No uploads yet.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Region</th>
                  <th>Label</th>
                  <th>Sample creator</th>
                  <th>Rows</th>
                  <th>Kept</th>
                  <th>Updated</th>
                  <th>Uploaded by</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {(showAllHistory ? history : history.slice(0, 5)).map((h) => (
                  <tr key={h.id}>
                    <td>{h.file_name || <span className="muted">—</span>}</td>
                    <td>{h.region_label?.toUpperCase() ?? "—"}</td>
                    <td>{h.label || <span className="muted">—</span>}</td>
                    <td>{h.sample_creator || <span className="muted">—</span>}</td>
                    <td>{h.total_rows}</td>
                    <td style={{ color: "#16794a" }}>{h.kept}</td>
                    <td style={{ color: "#2f6df6" }}>{h.updated}</td>
                    <td className="muted">{h.uploaded_by ?? "—"}</td>
                    <td>{fmtDateTime(h.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.length > 5 && (
            <button
              onClick={() => setShowAllHistory((v) => !v)}
              style={{ marginTop: 8 }}
            >
              {showAllHistory
                ? "Show less"
                : `Show more (${history.length - 5} more)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
