// Shared creator detail panel — used by both Search (Creators) and Jobs so the
// "overview" is identical everywhere. Jobs passes an optional generated `email`.
export type Row = {
  sec_uid: string; handle: string; display_name: string | null; bio: string | null;
  follower_count: number | null; engagement_median: number | null; avg_views: number | null; avg_views_pinned: number | null;
  posting_per_week: number | null; video_count: number | null; sponsored_count: number | null; avatar_url: string | null;
  category: string | null; category_secondary: string | null; content_format: string[] | null;
  persona: string | null; audience_lang: string | null; original_sound_ratio: number | null;
  comment_substance_ratio: number | null; comment_lang_match: number | null; creator_reply_rate: number | null;
  top_hashtags: string[] | null; profile_summary: string | null;
  email: string | null; email_type: string | null; email_difficulty: string | null; market: string | null;
  source_type: string | null; source_value: string | null; source_brand: string | null;
  is_songpush_user: boolean | null; songpush_admin_url: string | null; platform: string | null;
};

export const COLS =
  "sec_uid,handle,display_name,bio,follower_count,engagement_median,avg_views,avg_views_pinned,posting_per_week,video_count,sponsored_count,avatar_url,category,category_secondary,content_format,persona,audience_lang,original_sound_ratio,comment_substance_ratio,comment_lang_match,creator_reply_rate,top_hashtags,profile_summary,email,email_type,email_difficulty,market,source_type,source_value,source_brand,is_songpush_user,songpush_admin_url,platform";

export const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
export const LANG: Record<string, string> = { de:"German", en:"English", mixed:"Mixed", un:"unclear" };
export const PERSONA: Record<string, string> = { solo:"Solo", couple:"Couple", family:"Family", group:"Group" };
export const DIFF_ORDER = ["very_easy","easy","easy_medium","medium","hard","very_hard","skip"];
export const DIFF: Record<string, { label: string; color: string }> = {
  very_easy:   { label: "Very easy",   color: "#12A150" },
  easy:        { label: "Easy",        color: "#4E9F2E" },
  easy_medium: { label: "Easy–med",    color: "#8A9A1B" },
  medium:      { label: "Medium",      color: "#C2860B" },
  hard:        { label: "Hard",        color: "#D9600F" },
  very_hard:   { label: "Very hard",   color: "#C0341D" },
  skip:        { label: "Skip · t-online", color: "#6B7280" },
};

export const fmt = (n: number | null) => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,"")}m` : n >= 1e3 ? `${(n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,"")}k` : `${n}`;
export const pct = (x: number | null) => x == null ? "—" : `${Math.round(x*100)}%`;
export const catColor = (c: string | null) => `hsl(${(c && CAT_HUE[c]) ?? 255} 62% 52%)`;
export const initials = (r: { display_name: string | null; handle: string }) => ((r.display_name || r.handle).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || r.handle[0].toUpperCase());
export const erClass = (e: number | null) => e == null ? "" : e < 2 ? "er-bad" : e > 14 ? "er-warn" : "er-good";
export const profileUrl = (r: { platform: string | null; handle: string }) => r.platform === "instagram" ? `https://www.instagram.com/${r.handle}` : `https://www.tiktok.com/@${r.handle}`;
export const marketFlag = (m: string | null) => m === "dach" ? "🇩🇪 DACH" : m === "uk" ? "🇬🇧 UK" : m === "us" ? "🇺🇸 US" : (m || "—");

export function PlatIcon({ p }: { p: string | null }) {
  return p === "instagram"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/></svg>
    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.2v12.9a2.59 2.59 0 1 1-2.03-2.53v-3.26a5.76 5.76 0 1 0 5.03 5.71V8.9a7.5 7.5 0 0 0 4.3 1.34V7.06a4.28 4.28 0 0 1-2.99-1.24z"/></svg>;
}
export function Mono({ r, big }: { r: Row; big?: boolean }) {
  return (
    <div className="mono" style={{ background: catColor(r.category), ...(big ? { width: 52, height: 52, fontSize: 19, borderRadius: 14 } : {}) }}>
      {initials(r)}
      {r.avatar_url && <img src={r.avatar_url} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
    </div>
  );
}
function bar(label: string, val: string, width: number, color: string, note?: string) {
  return (
    <div className="stat">
      <div className="stat-head"><span className="stat-label">{label}</span><span className="stat-val">{val}</span></div>
      <div className="track"><div className="fill" style={{ width: `${Math.max(2, Math.min(100, width))}%`, background: color }} /></div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export type GenEmail = { subject: string; icebreaker: string; pitch: string };

export function Detail({ r, onClose, email }: { r: Row; onClose: () => void; email?: GenEmail | null }) {
  const lm = r.comment_lang_match ?? 0, sub = r.comment_substance_ratio ?? 0, rr = r.creator_reply_rate ?? 0;
  const marketLang = r.market === "dach" ? "German" : "English";
  const flag = r.market === "dach" ? "🇩🇪" : r.market === "uk" ? "🇬🇧" : r.market === "us" ? "🇺🇸" : "🌍";
  const langGood = lm >= 0.5, subGood = sub >= 0.6, rrGood = rr >= 0.15;
  const gN = [langGood, subGood, rrGood].filter(Boolean).length;
  const vb = gN >= 3 ? ["Strong", "var(--wp-good)", "var(--wp-goodsoft)"] : gN === 2 ? ["Solid", "var(--wp-good)", "var(--wp-goodsoft)"] : gN === 1 ? ["Mixed", "var(--wp-warn)", "var(--wp-warnsoft)"] : ["Weak", "var(--wp-bad)", "var(--wp-badsoft)"];
  const aqrow = (icon: string, label: string, desc: string, state: string) => (
    <div className="aqrow" key={label}><div className="aqicon">{icon}</div><div className="aqmain"><div className="aqlabel">{label}</div><div className="aqdesc">{desc}</div></div><div className={"aqmark aq-" + state}>{state === "good" ? "✓" : state === "bad" ? "✗" : "~"}</div></div>
  );
  const erCol = (r.engagement_median ?? 0) < 2 ? "var(--wp-muted)" : (r.engagement_median ?? 0) > 14 ? "var(--wp-warn)" : "var(--wp-good)";
  const vmax = Math.max(r.avg_views ?? 0, r.avg_views_pinned ?? 0) || 1;
  const osr = r.original_sound_ratio ?? 0;
  const emClass = r.email_type === "management" ? "em-mgmt" : r.email_type === "business_email" ? "em-biz" : "em-free";
  const emLabel = r.email_type === "management" ? "Management" : r.email_type === "business_email" ? "Business" : r.email_type === "freemail" ? "Freemail" : (r.email_type || "—");
  const adNote = (r.sponsored_count ?? 0) >= 2 ? `${r.sponsored_count} paid collabs → ad-experienced` : (r.sponsored_count === 1 ? "1 paid collab" : "no ads detected");

  return (
    <>
      <div className="p-head">
        <Mono r={r} big />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{r.display_name || r.handle}<span className="pf" style={{ padding: 3 }}><PlatIcon p={r.platform} /></span></div>
          <div className="hd">@{r.handle}</div>
          <div><span className="loc">{marketFlag(r.market)}</span></div>
        </div>
        <button className="x" onClick={onClose}><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div className="p-body">
        {email && (
          <div className="emailprev" style={{ margin: 0 }}>
            <div className="ep-label">Generated email · {r.email_difficulty && DIFF[r.email_difficulty] ? DIFF[r.email_difficulty].label + " to reach" : "cold outreach"}</div>
            <div className="ep-sub">{email.subject}</div>
            <div className="ep-body">{email.icebreaker}{"\n\n"}{email.pitch}</div>
          </div>
        )}
        {r.profile_summary && (
          <div className="summary">
            <div className="lead">{r.profile_summary}</div>
            <div className="src"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.3 3.7L17 7l-3.7 1.3L12 12l-1.3-3.7L7 7l3.7-1.3L12 2z"/></svg>Auto-profile from recent posts · real data only</div>
          </div>
        )}
        <div><div className="sec-t">Bio</div><div className="bio">{r.bio || "—"}</div></div>
        <div>
          <div className="sec-t">Reach &amp; engagement</div>
          {bar("Engagement rate", `${r.engagement_median ?? "—"}%`, ((r.engagement_median ?? 0) / 14) * 100, erCol, (r.engagement_median ?? 0) >= 2 && (r.engagement_median ?? 0) <= 14 ? "in target band 2–14%" : "outside band")}
          <div className="stat twobar">
            <div className="stat-head"><span className="stat-label">Reach — typical vs. peak</span><span className="stat-val">{fmt(r.avg_views)}</span></div>
            <div className="track"><div className="fill" style={{ width: `${Math.max(2, (r.avg_views ?? 0) / vmax * 100)}%`, background: "var(--wp-acc)" }} /></div>
            {r.avg_views_pinned ? (
              <>
                <div className="track" style={{ marginTop: 5 }}><div className="fill" style={{ width: "100%", background: "color-mix(in srgb,var(--wp-acc) 38%,transparent)" }} /></div>
                <div className="minilegend"><span><i style={{ background: "var(--wp-acc)" }} />{fmt(r.avg_views)} typical</span><span><i style={{ background: "color-mix(in srgb,var(--wp-acc) 38%,transparent)" }} />{fmt(r.avg_views_pinned)} pinned</span></div>
              </>
            ) : <div className="stat-note">no pinned post</div>}
          </div>
        </div>
        <div className="kv">
          <div className="cell"><div className="k">Followers</div><div className="v num">{fmt(r.follower_count)}</div></div>
          <div className="cell"><div className="k">Total posts</div><div className="v num">{fmt(r.video_count)}</div></div>
          <div className="cell"><div className="k">Posts / week</div><div className="v num">{r.posting_per_week ?? "—"}</div></div>
          <div className="cell"><div className="k">Persona</div><div className="v sm">{r.persona ? (PERSONA[r.persona] || r.persona) : "—"}</div></div>
        </div>
        <div>
          <div className="sec-t">Content</div>
          <div className="tagrow" style={{ marginBottom: 14 }}>
            {r.category && <span className="pill cat">{r.category}</span>}
            {r.category_secondary && <span className="pill">{r.category_secondary}</span>}
            {(r.content_format || []).map(f => <span key={f} className="pill">{f}</span>)}
          </div>
          {bar('Own original sound — “speaks”', pct(r.original_sound_ratio), osr * 100, osr >= 0.5 ? "var(--wp-good)" : "var(--wp-muted)", osr >= 0.5 ? "mostly own audio → talks / narrates" : "mostly others’ sounds → music / lip-sync")}
        </div>
        <div>
          <div className="aqhead"><div className="sec-t" style={{ margin: 0 }}>Audience quality</div><span className="aqbadge" style={{ background: vb[2], color: vb[1] }}>{vb[0]}</span></div>
          {aqrow(flag, "Right audience", langGood ? `${Math.round(lm * 100)}% of commenters write in ${marketLang}` : `only ${Math.round(lm * 100)}% write in ${marketLang} — likely off-market`, langGood ? "good" : "bad")}
          {aqrow("💬", "Real engagement", subGood ? `${Math.round(sub * 100)}% of comments are genuine sentences (not bot/emoji)` : `just ${Math.round(sub * 100)}% real comments — mostly emoji or one-word`, subGood ? "good" : "warn")}
          {aqrow("↩︎", "Responsive creator", rrGood ? `engages ~${Math.round(rr * 100)}% of comments (likes / replies)` : (rr > 0 ? `rarely engages comments (~${Math.round(rr * 100)}%)` : "doesn't reply to comments"), rrGood ? "good" : "warn")}
        </div>
        {r.audience_lang && <div className="stat-note" style={{ marginTop: -8 }}>Audience language: {LANG[r.audience_lang] || r.audience_lang}</div>}
        {r.top_hashtags && r.top_hashtags.length > 0 && (
          <div><div className="sec-t">Hashtags</div><div className="tagrow">{r.top_hashtags.map(h => <span key={h} className="pill ghost">#{h}</span>)}</div></div>
        )}
        <div>
          <div className="sec-t">Contact &amp; business</div>
          <div className="contact">
            <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></div><div className="cx"><div className="k">Email</div><div className="v">{r.email || "—"}</div></div>{r.email_type && <span className={"tag-em " + emClass}>{emLabel}</span>}{r.email_difficulty && DIFF[r.email_difficulty] && <span title="Cold-email deliverability" style={{ background: DIFF[r.email_difficulty].color, color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap", marginLeft: 6 }}>{DIFF[r.email_difficulty].label}</span>}</div>
            <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><path d="M20 7h-9M14 17H5M17 3l4 4-4 4M7 21l-4-4 4-4"/></svg></div><div className="cx"><div className="k">Ad experience</div><div className="v">{adNote}</div></div></div>
            {(r.source_value || r.source_brand) && <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg></div><div className="cx"><div className="k">Found via</div><div className="v">{r.source_value || r.source_brand}</div></div></div>}
          </div>
        </div>
      </div>
      <div className="p-foot">
        <a className="btn primary" href={profileUrl(r)} target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>Open {r.platform === "instagram" ? "Instagram" : "TikTok"} profile</a>
      </div>
    </>
  );
}
