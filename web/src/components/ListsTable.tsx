import { Link } from "react-router-dom";
import type { List } from "../lib/types";

export interface ListRow extends List {
  total: number;
  sourced: number;
  enriched: number;
  filtered: number;
  in_instantly: number;
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
            rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/lists/${l.id}`} style={{ fontWeight: 600 }}>
                    {l.name}
                  </Link>
                </td>
                <td>
                  <span className="pill pill-new">{l.kind}</span>
                </td>
                <td>{l.total.toLocaleString("en-GB")}</td>
                <td>{l.sourced}</td>
                <td style={{ color: "#16794a" }}>{l.enriched}</td>
                <td style={{ color: "#b83636" }}>{l.filtered}</td>
                <td>{l.in_instantly.toLocaleString("en-GB")}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
