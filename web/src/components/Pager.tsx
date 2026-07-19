// Reusable server-side pagination control: "from–to of total", prev/next, and a page
// number you can type to jump straight to it.
export default function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (total <= pageSize) return null;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  const n = (x: number) => x.toLocaleString("en-GB");
  return (
    <div className="pager">
      <span className="muted">{n(from)}–{n(to)} of {n(total)}</span>
      <div className="grow" />
      <button onClick={() => onPage(0)} disabled={page === 0} title="First page">«</button>
      <button onClick={() => onPage(page - 1)} disabled={page === 0}>‹ Prev</button>
      <span className="muted" style={{ fontSize: 12 }}>Page</span>
      <input
        type="number"
        min={1}
        max={last + 1}
        value={page + 1}
        onChange={(e) => {
          const p = Number(e.target.value) - 1;
          if (Number.isFinite(p) && p >= 0 && p <= last) onPage(p);
        }}
        style={{ width: 64, textAlign: "center" }}
        aria-label="Jump to page"
      />
      <span className="muted" style={{ fontSize: 12 }}>/ {n(last + 1)}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= last}>Next ›</button>
      <button onClick={() => onPage(last)} disabled={page >= last} title="Last page">»</button>
    </div>
  );
}
