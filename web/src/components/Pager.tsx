// Reusable server-side pagination control. Shows "from–to of total" + page nav.
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
  const n = (x: number) => x.toLocaleString("de-DE");
  return (
    <div className="pager">
      <span className="muted">
        {n(from)}–{n(to)} von {n(total)}
      </span>
      <div className="grow" />
      <button onClick={() => onPage(0)} disabled={page === 0} title="Erste Seite">«</button>
      <button onClick={() => onPage(page - 1)} disabled={page === 0}>‹ Zurück</button>
      <span className="muted" style={{ fontSize: 12 }}>Seite {n(page + 1)} / {n(last + 1)}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= last}>Weiter ›</button>
      <button onClick={() => onPage(last)} disabled={page >= last} title="Letzte Seite">»</button>
    </div>
  );
}
