export interface LeadPoint {
  day: string; // YYYY-MM-DD
  n: number;
}

// Round up to a "nice" axis maximum (1 / 2 / 5 × 10^k).
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * pow;
}

function fmtDay(day: string): string {
  return new Date(day + "T00:00:00").toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

// Lightweight dependency-free SVG bar chart: leads loaded per day.
export default function LeadsBarChart({ data }: { data: LeadPoint[] }) {
  if (data.length === 0) {
    return <p className="muted">No leads loaded yet.</p>;
  }

  const W = 760;
  const H = 260;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 40;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const max = niceCeil(Math.max(...data.map((d) => d.n)));
  const slot = iw / data.length;
  const barW = Math.min(slot * 0.62, 54);
  const y = (v: number) => padT + ih - (v / max) * ih;

  // Sparse x labels when there are many days.
  const labelEvery = Math.ceil(data.length / 12);
  const ticks = [0, max / 2, max];

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: "100%", display: "block", minWidth: 320 }}
        role="img"
        aria-label="Leads loaded per day"
      >
        <defs>
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#4f46e5" />
          </linearGradient>
        </defs>

        {/* y grid + labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              stroke="#e7e9f0"
              strokeWidth={1}
            />
            <text
              x={padL - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="#6b7280"
            >
              {Math.round(t).toLocaleString("en-GB")}
            </text>
          </g>
        ))}

        {/* bars */}
        {data.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          const h = ih - (y(d.n) - padT);
          return (
            <g key={d.day}>
              <rect
                x={cx - barW / 2}
                y={y(d.n)}
                width={barW}
                height={Math.max(h, 2)}
                rx={4}
                fill="url(#barGrad)"
              >
                <title>{`${fmtDay(d.day)}: ${d.n.toLocaleString("en-GB")} leads`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text
                  x={cx}
                  y={H - padB + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#6b7280"
                >
                  {fmtDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
