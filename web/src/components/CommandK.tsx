import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { STATUS_LABELS, type Creator } from "../lib/types";
import { profileUrl } from "./CreatorTable";

interface Hit {
  id: string;
  handle: string | null;
  tiktok_username: string | null;
  email: string | null;
  platform: string | null;
  region_label: string | null;
  label: string | null;
  status: Creator["status"];
  campaigns?: { name: string } | null;
  lists?: { name: string } | null;
}

// Global ⌘K / Ctrl+K palette to search leads by handle, username or email.
export default function CommandK() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setActive(0);
  }, []);

  // Open on ⌘K / Ctrl+K (and a custom event fired by the sidebar trigger).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-k", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-k", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    const term = query.replace(/[,()%]/g, " ").trim();
    if (term.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      const like = `%${term}%`;
      const { data } = await supabase
        .from("creators")
        .select(
          "id, handle, tiktok_username, email, platform, region_label, label, status, campaigns(name), lists(name)"
        )
        .or(
          `handle.ilike.${like},tiktok_username.ilike.${like},email.ilike.${like}`
        )
        .order("date_added", { ascending: false })
        .limit(25);
      setHits((data ?? []) as unknown as Hit[]);
      setActive(0);
      setLoading(false);
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const openHit = useCallback((h: Hit | undefined) => {
    if (!h) return;
    const handle = h.handle || h.tiktok_username;
    if (handle) {
      window.open(profileUrl(h.platform, handle), "_blank", "noreferrer");
    }
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openHit(hits[active]);
    }
  }

  if (!open) return null;

  return (
    <div className="cmdk-backdrop" onClick={close}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="cmdk-input-wrap">
          <span className="cmdk-icon">⌕</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="Search leads — handle, username or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>

        <div className="cmdk-results">
          {query.replace(/[,()%]/g, " ").trim().length < 2 ? (
            <div className="cmdk-empty">Type at least 2 characters to search.</div>
          ) : loading ? (
            <div className="cmdk-empty">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="cmdk-empty">No leads found.</div>
          ) : (
            hits.map((h, i) => {
              const handle = h.handle || h.tiktok_username;
              const context = h.lists?.name ?? h.campaigns?.name ?? null;
              return (
                <div
                  key={h.id}
                  className={`cmdk-row${i === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openHit(h)}
                >
                  <div className="cmdk-row-main">
                    <span className="cmdk-handle">
                      {handle ? `@${handle.replace(/^@/, "")}` : "—"}
                    </span>
                    <span className="cmdk-email muted">{h.email ?? "no email"}</span>
                  </div>
                  <div className="cmdk-row-meta">
                    {h.region_label && (
                      <span className="cmdk-tag">{h.region_label.toUpperCase()}</span>
                    )}
                    {h.label && <span className="cmdk-tag">{h.label}</span>}
                    {context && <span className="cmdk-tag">{context}</span>}
                    <span className={`pill pill-${h.status}`}>
                      {STATUS_LABELS[h.status]}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open TikTok</span>
          <span className="grow" />
          {hits.length > 0 && <span>{hits.length} result{hits.length === 1 ? "" : "s"}</span>}
        </div>
      </div>
    </div>
  );
}
