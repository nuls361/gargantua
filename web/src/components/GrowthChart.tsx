export interface LeadPoint {
  day: string; // YYYY-MM-DD
  n: number;
}

function fmtDay(day: string): string {
  return new Date(day + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

// Cumulative lead-growth curve — dependency-free SVG line + area fill.
export default function GrowthChart({ data }: { data: LeadPoint[] }) {
  if (data.length === 0) return <p className="muted">No leads loaded yet.</p>;

  // running total => the growth curve
  let acc = 0;
  const pts = data.map((d) => ({ day: d.day, v: (acc += d.n) }));

  const W = 760, H = 260, padL = 52, padR = 16, padT = 16, padB = 40;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = niceCeil(pts[pts.length - 1].v);
  const x = (i: number) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => padT + ih - (v / max) * ih;

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(pts.length / 8);
  const last = pts[pts.length - 1];

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: "100%", display: "block", minWidth: 320 }}
        role="img" aria-label="Cumulative lead growth">
        <defs>
          <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {Math.round(t).toLocaleString("en-GB")}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#growthFill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(pts.length - 1)} cy={y(last.v)} r={4} fill="var(--accent)" />
        {pts.map((p, i) =>
          i % labelEvery === 0 || i === pts.length - 1 ? (
            <text key={p.day} x={x(i)} y={H - padB + 18} textAnchor="middle" fontSize={11} fill="var(--muted)">
              {fmtDay(p.day)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}
