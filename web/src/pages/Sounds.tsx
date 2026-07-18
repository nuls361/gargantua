import SourceManager from "../components/SourceManager";

export default function Sounds() {
  return (
    <SourceManager
      title="Sounds"
      sourceType="sound"
      intro="Sounds we've harvested — each creator using a sound is a lead on that trend. DACH/UK yield tells you which sounds surface your market. Paste a TikTok sound URL or name to harvest a new one."
      addPlaceholder="TikTok sound URL or name…"
      formatValue={(v) => v.replace(/^sound:/, "🎵 ")}
      harvestOptions={{ pages: 10, enrich: true, dach_only: false, budget_usd: 1.5 }}
    />
  );
}
