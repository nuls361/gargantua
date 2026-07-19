import { Link } from "react-router-dom";
import type { List } from "../lib/types";

export interface ListRow extends List {
  total: number;
  sourced: number;
  enriched: number;
  filtered: number;
  in_instantly: number;
  href?: string;   // override link target (used by the idle/recycle segments)
}

interface Props {
  rows: ListRow[];
  loading: boolean;
}

// Reusable overview table of lists with per-status counts.
export default function ListsTable({ rows, loading }: Props) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>List</th>
            <th>Kind</th>
            <th>Total</th>
            <th>Sourced</th>
            <th>Enriched</th>
            <th>Filtered</th>
            <th>In Instantly</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={7} className="center-loading">Loading…</td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="center-loading">No lists yet.</td>
            </tr>
          ) : (
            rows.map((l) => {
              const recycle = l.kind === "recycle";
              return (
                <tr key={l.id}>
                  <td>
                    <Link to={l.href ?? `/lists/${l.id}`} style={{ fontWeight: 600 }}>
                      {l.name}
                    </Link>
                  </td>
                  <td>
                    <span className={`pill ${recycle ? "pill-neutral" : "pill-new"}`}>{l.kind}</span>
                  </td>
                  <td>{l.total.toLocaleString("en-GB")}</td>
                  <td>{recycle ? "—" : l.sourced}</td>
                  <td style={{ color: "#16794a" }}>{recycle ? "—" : l.enriched}</td>
                  <td style={{ color: "#b83636" }}>{recycle ? "—" : l.filtered}</td>
                  <td>{recycle ? "—" : l.in_instantly.toLocaleString("en-GB")}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
