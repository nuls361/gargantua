import SourceManager from "../components/SourceManager";

export default function Seeds() {
  return (
    <SourceManager
      title="Creator seeds"
      sourceType="creator"
      intro="Seed creators we've harvested from — their @-mentioned collab partners (and public following) become new leads. Paste a creator handle to harvest their orbit."
      addPlaceholder="@seed-creator handle…"
      formatValue={(v) => v}
      harvestOptions={{ pages: 3, enrich: true, dach_only: true, budget_usd: 1 }}
    />
  );
}
