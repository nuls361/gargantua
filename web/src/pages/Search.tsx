import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { List } from "../lib/types";
import {
  ACTIVITY_OPTIONS,
  AGE_OPTIONS,
  COUNTRY_OPTIONS,
  COUNT_STEPS,
  DEFAULT_FILTERS,
  ENGAGEMENT_OPTIONS,
  GENDER_OPTIONS,
  NICHES,
  type Option,
  POSTS_OPTIONS,
  type SearchFilters,
  type SearchGender,
  type SearchPlatform,
  type SearchResult,
} from "../lib/search";

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function compact(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return String(n);
}

export default function Search() {
  const [f, setF] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);

  // selection + add-to-list
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lists, setLists] = useState<List[]>([]);
  const [targetList, setTargetList] = useState("");
  const [newListName, setNewListName] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadLists = () =>
    supabase
      .from("lists")
      .select("*")
      .eq("kind", "working")
      .order("name")
      .then(({ data }) => setLists((data ?? []) as List[]));

  useEffect(() => {
    void loadLists();
  }, []);

  function set<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSelected(new Set());
    const { data, error: err } = await supabase.functions.invoke(
      "clickanalytic-search",
      { body: f }
    );
    if (err) {
      setLoading(false);
      setError(`Search failed: ${err.message}`);
      setResults(null);
      return;
    }
    setIsMock(!!data?.mock);
    const raw = (data?.results ?? []) as SearchResult[];

    // Dedupe: hide any creator whose handle is already anywhere in our DB.
    const handles = raw.map((r) => r.handle);
    const { data: existing } = await supabase
      .from("creators")
      .select("handle")
      .in("handle", handles);
    const known = new Set((existing ?? []).map((e) => (e.handle as string)));
    const fresh = raw.filter((r) => !known.has(r.handle));
    setHiddenCount(raw.length - fresh.length);
    setResults(fresh);
    setLoading(false);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  const allSelected =
    !!results && results.length > 0 && results.every((r) => selected.has(r.id));
  function toggleAll() {
    if (!results) return;
    setSelected(allSelected ? new Set() : new Set(results.map((r) => r.id)));
  }

  async function addToList() {
    if (!results || selected.size === 0) return;
    setAdding(true);
    setError(null);

    // Resolve target list id: existing selection or a new list by name.
    let listId = targetList;
    if (!listId) {
      const name = newListName.trim();
      if (!name) {
        setError("Pick a list or enter a new list name.");
        setAdding(false);
        return;
      }
      const { data: created, error: cErr } = await supabase
        .from("lists")
        .insert({ name, kind: "working" })
        .select("id")
        .single();
      if (cErr) {
        setError(`Could not create list: ${cErr.message}`);
        setAdding(false);
        return;
      }
      listId = created!.id;
    }

    const chosen = results.filter((r) => selected.has(r.id));
    const rows = chosen.map((r) => ({
      handle: r.handle,
      tiktok_username: r.handle,
      platform: r.platform,
      status: "sourced" as const,
      list_id: listId,
    }));
    const { error: insErr } = await supabase.from("creators").insert(rows);
    setAdding(false);
    if (insErr) {
      setError(`Could not add to list: ${insErr.message}`);
      return;
    }
    // Remove added rows from view (they're now "known" and would be deduped).
    setResults(results.filter((r) => !selected.has(r.id)));
    setSelected(new Set());
    setNewListName("");
    await loadLists();
    setNotice(`Added ${chosen.length} creators to the list.`);
    setTimeout(() => setNotice(null), 6000);
  }

  return (
    <div>
      <h2>Search</h2>

      {error && <div className="error">{error}</div>}

      <form onSubmit={runSearch}>
        <h3 style={{ marginBottom: 8 }}>Main Filters</h3>
        <div style={gridStyle}>
          <FilterCard label="Platform">
            <select
              value={f.platform}
              onChange={(e) => set("platform", e.target.value as SearchPlatform)}
              style={selectStyle}
            >
              {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </FilterCard>

          <FilterCard label="Creator Location">
            <select
              value={f.location}
              onChange={(e) => set("location", e.target.value)}
              style={selectStyle}
            >
              <option value="">Any</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </FilterCard>

          <FilterCard label="Creator Gender">
            <select
              value={f.gender}
              onChange={(e) => set("gender", e.target.value as SearchGender)}
              style={selectStyle}
            >
              {GENDER_OPTIONS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </FilterCard>

          <FilterCard label="Followers">
            <FromTo
              options={COUNT_STEPS}
              min={f.followersMin}
              max={f.followersMax}
              onMin={(v) => set("followersMin", v)}
              onMax={(v) => set("followersMax", v)}
            />
          </FilterCard>

          <FilterCard label="Avg. Views">
            <FromTo
              options={COUNT_STEPS}
              min={f.avgViewsMin}
              max={f.avgViewsMax}
              onMin={(v) => set("avgViewsMin", v)}
              onMax={(v) => set("avgViewsMax", v)}
            />
          </FilterCard>

          <FilterCard label="Creator Lookalike">
            <input
              type="text"
              value={f.lookalikeHandle}
              onChange={(e) => set("lookalikeHandle", e.target.value)}
              placeholder="@handle of a similar profile"
              style={selectStyle}
            />
          </FilterCard>
        </div>

        <h3 style={{ marginBottom: 8, marginTop: 22 }}>Creator Advanced Filters</h3>
        <div style={gridStyle}>
          <FilterCard label="Engagement Rate">
            <NumSelect
              options={ENGAGEMENT_OPTIONS}
              value={f.engagementMin}
              onChange={(v) => set("engagementMin", v)}
            />
          </FilterCard>

          <FilterCard label="Creator Age">
            <FromTo
              options={AGE_OPTIONS}
              min={f.ageMin}
              max={f.ageMax}
              onMin={(v) => set("ageMin", v)}
              onMax={(v) => set("ageMax", v)}
            />
          </FilterCard>

          <FilterCard label="Topics / Niche">
            <input
              type="text"
              list="niche-list"
              value={f.niche}
              onChange={(e) => set("niche", e.target.value)}
              placeholder="Search by niche…"
              style={selectStyle}
            />
            <datalist id="niche-list">
              {NICHES.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </FilterCard>

          <FilterCard label="Creator Activity Level">
            <NumSelect
              options={ACTIVITY_OPTIONS}
              value={f.activityDays}
              onChange={(v) => set("activityDays", v)}
            />
          </FilterCard>

          <FilterCard label="Total Number Of Posts" badge="New">
            <NumSelect
              options={POSTS_OPTIONS}
              value={f.postsMin}
              onChange={(v) => set("postsMin", v)}
            />
          </FilterCard>

          <FilterCard label="Contact Details">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: 0,
                color: "var(--text)",
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                checked={f.emailValidOnly}
                onChange={(e) => set("emailValidOnly", e.target.checked)}
                style={{ width: "auto" }}
              />
              ✉︎ Email Address
            </label>
          </FilterCard>
        </div>

        <div className="toolbar" style={{ marginTop: 18 }}>
          <button
            type="button"
            onClick={() => {
              setF(DEFAULT_FILTERS);
              setResults(null);
            }}
            disabled={loading}
          >
            Reset
          </button>
          <div className="grow" />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {notice && <div className="success" style={{ marginTop: 16 }}>{notice}</div>}

      {results && (
        <>
          <div className="toolbar" style={{ marginTop: 22 }}>
            <strong>Results: {results.length} creators</strong>
            {isMock && (
              <span
                className="pill pill-queued"
                title="ClickAnalytic API not connected yet — showing sample data"
              >
                Mock data
              </span>
            )}
            {hiddenCount > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                {hiddenCount} hidden — already in your lists
              </span>
            )}
          </div>

          {results.length > 0 && (
            <div className="toolbar">
              <strong>{selected.size} selected</strong>
              <select
                value={targetList}
                onChange={(e) => setTargetList(e.target.value)}
              >
                <option value="">New list…</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              {!targetList && (
                <input
                  type="text"
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="New list name"
                  style={{ minWidth: 180 }}
                />
              )}
              <button
                className="primary"
                onClick={addToList}
                disabled={adding || selected.size === 0}
              >
                {adding ? "Adding…" : "Add to list"}
              </button>
            </div>
          )}

          {results.length === 0 ? (
            <p className="muted">No new creators matched those filters.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th>Creator</th>
                    <th>Followers</th>
                    <th>Eng. Rate</th>
                    <th>Engaged Followers</th>
                    <th>Avg. Views</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <ResultRow
                      key={r.id}
                      r={r}
                      checked={selected.has(r.id)}
                      onCheck={() => toggle(r.id)}
                      expanded={expanded === r.id}
                      onToggle={() =>
                        setExpanded(expanded === r.id ? null : r.id)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ResultRow({
  r,
  checked,
  onCheck,
  expanded,
  onToggle,
}: {
  r: SearchResult;
  checked: boolean;
  onCheck: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={checked} onChange={onCheck} />
        </td>
        <td>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img
              src={r.profileImage ?? ""}
              alt=""
              width={40}
              height={40}
              style={{
                borderRadius: "50%",
                objectFit: "cover",
                background: "#e6e9ee",
                flexShrink: 0,
              }}
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
            <div style={{ lineHeight: 1.3 }}>
              <a
                href={r.profileUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontWeight: 600 }}
              >
                @{r.handle}
              </a>
              {r.verified && (
                <span title="Verified" style={{ color: "#2f6df6" }}>
                  {" "}
                  ✔
                </span>
              )}
              <div className="muted" style={{ fontSize: 12 }}>
                {r.displayName}
              </div>
            </div>
          </div>
        </td>
        <td>{compact(r.followers)}</td>
        <td>{r.engagementPct == null ? "—" : `${r.engagementPct}%`}</td>
        <td>{compact(r.engagedFollowers)}</td>
        <td>{compact(r.avgViews)}</td>
        <td>
          <div style={{ display: "flex", gap: 6 }}>
            <a
              className="primary"
              href={r.profileUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                padding: "6px 11px",
                borderRadius: 6,
                background: "var(--accent)",
                color: "#fff",
                fontWeight: 500,
                fontSize: 13,
                whiteSpace: "nowrap",
              }}
            >
              Open {PLATFORM_LABEL[r.platform] ?? "profile"}
            </a>
            <button type="button" onClick={onToggle}>
              {expanded ? "Hide" : "JSON"}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ background: "#fafbfc" }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Market: {r.primaryMarket ?? "—"} · Email:{" "}
              {r.emailAvailable ? "yes" : "no"} · Quality: {r.qualityScore ?? "—"}{" "}
              · Interests: {r.interests.join(", ") || "—"}
            </div>
            <pre
              style={{
                fontSize: 11,
                overflowX: "auto",
                background: "#fff",
                border: "1px solid var(--border)",
                padding: 10,
                borderRadius: 6,
                margin: 0,
              }}
            >
              {JSON.stringify(r.raw, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ---- small building blocks ----

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 14,
};

const selectStyle: React.CSSProperties = { width: "100%" };

function FilterCard({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#eafaf1",
        border: "1px solid #cdeede",
        borderRadius: 8,
        padding: 14,
      }}
    >
      <div style={{ marginBottom: 6, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
          {label}
        </span>
        {badge && (
          <span
            style={{
              fontSize: 10,
              background: "#ff2d78",
              color: "#fff",
              borderRadius: 999,
              padding: "1px 6px",
              fontWeight: 700,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function NumSelect({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <select
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      style={selectStyle}
    >
      {options.map((o) => (
        <option key={o.label} value={o.value == null ? "" : String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FromTo({
  options,
  min,
  max,
  onMin,
  onMax,
}: {
  options: Option[];
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
}) {
  const withAny: Option[] = [{ value: null, label: "Any" }, ...options];
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select
        value={min == null ? "" : String(min)}
        onChange={(e) => onMin(e.target.value === "" ? null : Number(e.target.value))}
        style={{ width: "50%" }}
      >
        <option value="">From</option>
        {withAny.slice(1).map((o) => (
          <option key={o.label} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        value={max == null ? "" : String(max)}
        onChange={(e) => onMax(e.target.value === "" ? null : Number(e.target.value))}
        style={{ width: "50%" }}
      >
        <option value="">To</option>
        {withAny.slice(1).map((o) => (
          <option key={o.label} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
