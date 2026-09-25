"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchedAssignment, SourceStatus } from "@/lib/types";

interface ApiResponse {
  keywords: string[];
  mode: "any" | "all";
  total: number;
  count: number;
  results: MatchedAssignment[];
  sources: SourceStatus[];
  plannedSources: string[];
}

const DEFAULT_KEYWORDS = ["Java", "React", ".NET", "Azure"];
const SUGGESTIONS = ["Python", "TypeScript", "AWS", "Kubernetes", "DevOps", "Projektledare", "Arkitekt", "Scrum", "C#", "SAP", "Test", "Data"];

const LS = { keywords: "ur.keywords", mode: "ur.mode", seen: "ur.seen", saved: "ur.saved" };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* privat läge m.m. */
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length || !text) return <>{text}</>;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

function formatDate(d?: string) {
  if (!d) return null;
  const date = new Date(d);
  return isNaN(date.getTime()) ? d : date.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

export default function App() {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [mode, setMode] = useState<"any" | "all">("any");
  const [input, setInput] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"relevance" | "newest">("relevance");
  const [view, setView] = useState<"all" | "new" | "saved">("all");
  const [seen, setSeen] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const seenAtLoad = useRef<Set<string>>(new Set());

  // Initiera från URL (delbar länk) eller localStorage.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("kw");
    setKeywords(fromUrl ? fromUrl.split(",").map((s) => s.trim()).filter(Boolean) : load(LS.keywords, DEFAULT_KEYWORDS));
    setMode(params.get("mode") === "all" ? "all" : load(LS.mode, "any"));
    const s = load<string[]>(LS.seen, []);
    seenAtLoad.current = new Set(s);
    setSeen(s);
    setSaved(load<string[]>(LS.saved, []));
    setReady(true);
  }, []);

  const fetchData = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ keywords: keywords.join(","), mode });
        if (refresh) qs.set("refresh", "1");
        const res = await fetch(`/api/assignments?${qs}`);
        if (!res.ok) throw new Error(`Servern svarade ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
        // Markera allt som hämtats som "sett" till nästa besök.
        const ids = json.results.map((r) => r.id);
        setSeen((prev) => {
          const next = [...new Set([...prev, ...ids])].slice(-5000);
          store(LS.seen, next);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Något gick fel");
      } finally {
        setLoading(false);
      }
    },
    [keywords, mode],
  );

  useEffect(() => {
    if (!ready) return;
    store(LS.keywords, keywords);
    store(LS.mode, mode);
    const url = new URL(window.location.href);
    url.searchParams.set("kw", keywords.join(","));
    if (mode === "all") url.searchParams.set("mode", "all");
    else url.searchParams.delete("mode");
    window.history.replaceState(null, "", url);
    fetchData();
  }, [ready, keywords, mode, fetchData]);

  const addKeyword = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setKeywords((prev) => {
      const lower = new Set(prev.map((k) => k.toLowerCase()));
      return [...prev, ...parts.filter((p) => !lower.has(p.toLowerCase()))];
    });
    setInput("");
  };
  const removeKeyword = (k: string) => setKeywords((prev) => prev.filter((x) => x !== k));
  const toggleSaved = (id: string) =>
    setSaved((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      store(LS.saved, next);
      return next;
    });

  const isNew = (id: string) => seenAtLoad.current.size > 0 && !seenAtLoad.current.has(id);

  const visible = useMemo(() => {
    if (!data) return [];
    const f = filter.trim().toLowerCase();
    let list = data.results.filter((r) => {
      if (view === "saved" && !saved.includes(r.id)) return false;
      if (view === "new" && !isNew(r.id)) return false;
      if (!f) return true;
      return `${r.title} ${r.company ?? ""} ${r.location ?? ""} ${r.description ?? ""}`.toLowerCase().includes(f);
    });
    if (sort === "newest") list = [...list].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, sort, view, saved]);

  const newCount = data ? data.results.filter((r) => isNew(r.id)).length : 0;
  const suggestions = SUGGESTIONS.filter((s) => !keywords.some((k) => k.toLowerCase() === s.toLowerCase())).slice(0, 6);

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Uppdragsradarn</h1>
          <p>Alla konsultuppdrag som matchar dina nyckelord – samlade från uppdragsportalerna.</p>
        </div>
        <button className="btn" onClick={() => fetchData(true)} disabled={loading}>
          {loading ? "Hämtar…" : "↻ Uppdatera"}
        </button>
      </header>

      <section className="panel" aria-label="Nyckelord">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            addKeyword(input);
          }}
        >
          <input
            className="kw-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Lägg till nyckelord, t.ex. Kotlin, Scrum Master, Göteborg"
            aria-label="Nytt nyckelord"
          />
          <button className="btn primary" type="submit">
            Lägg till
          </button>
        </form>
        <div className="chips">
          {keywords.map((k) => (
            <span className="chip" key={k}>
              {k}
              <button aria-label={`Ta bort ${k}`} onClick={() => removeKeyword(k)}>
                ×
              </button>
            </span>
          ))}
          {!keywords.length && <span style={{ color: "var(--muted)", fontSize: 14 }}>Inga nyckelord – visar alla uppdrag.</span>}
          {suggestions.map((s) => (
            <button key={s} className="chip suggest" onClick={() => addKeyword(s)}>
              + {s}
            </button>
          ))}
        </div>
        <div className="controls">
          <span>Matcha</span>
          <div className="seg" role="group" aria-label="Matchningsläge">
            <button aria-pressed={mode === "any"} onClick={() => setMode("any")}>
              något ord
            </button>
            <button aria-pressed={mode === "all"} onClick={() => setMode("all")}>
              alla ord
            </button>
          </div>
          <div className="seg" role="group" aria-label="Visa">
            <button aria-pressed={view === "all"} onClick={() => setView("all")}>
              Alla
            </button>
            <button aria-pressed={view === "new"} onClick={() => setView("new")}>
              Nya{newCount ? ` (${newCount})` : ""}
            </button>
            <button aria-pressed={view === "saved"} onClick={() => setView("saved")}>
              Sparade{saved.length ? ` (${saved.length})` : ""}
            </button>
          </div>
          <label>
            Sortera{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value as "relevance" | "newest")}>
              <option value="relevance">Relevans</option>
              <option value="newest">Senast publicerad</option>
            </select>
          </label>
          <input type="search" placeholder="Filtrera i resultatet…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </section>

      {data && (
        <div className="sources" aria-label="Källor">
          {data.sources.map((s) => (
            <span key={s.source} className={`src ${s.ok ? "ok" : "err"}`} title={s.error ?? s.strategies.join(" · ")}>
              {s.source} · {s.ok ? `${s.count} uppdrag` : "ej tillgänglig"}
            </span>
          ))}
          {data.plannedSources.map((s) => (
            <span key={s} className="src plan" title="Kommer snart">
              {s} · snart
            </span>
          ))}
        </div>
      )}

      {data?.sources
        .filter((s) => !s.ok)
        .map((s) => (
          <p key={s.source} className="error" style={{ padding: "12px 0 0", textAlign: "left", fontSize: 14 }}>
            {s.source}: {s.error}
          </p>
        ))}

      {data && !loading && (
        <p className="summary">
          {visible.length} av {data.total} uppdrag
          {keywords.length ? ` matchar ${mode === "all" ? "alla" : "något"} av dina ${keywords.length} nyckelord` : ""}.
        </p>
      )}

      {error && <div className="error">Kunde inte hämta uppdrag: {error}</div>}

      <div className="list">
        {loading && !data && Array.from({ length: 5 }, (_, i) => <div className="skeleton" key={i} />)}
        {visible.map((a) => (
          <article key={a.id} className={`card${open === a.id ? " open" : ""}`}>
            <div className="card-head">
              <div>
                <h3>
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    <Highlight text={a.title} words={a.matched} />
                  </a>
                </h3>
                <div className="meta">
                  <span className="badge">{a.source}</span>
                  {isNew(a.id) && <span className="badge new">Ny</span>}
                  {a.company && <span>🏢 {a.company}</span>}
                  {a.location && <span>📍 {a.location}</span>}
                  {a.published && <span>Publicerad {formatDate(a.published)}</span>}
                  {a.deadline && <span>Sista dag {formatDate(a.deadline)}</span>}
                  {a.startText ? <span>Start {a.startText}</span> : a.start && <span>Start {formatDate(a.start)}</span>}
                  {a.duration && <span>⏱ {a.duration}</span>}
                  {a.extent && <span>{a.extent}</span>}
                </div>
              </div>
              <div className="card-actions">
                <button
                  className="icon-btn"
                  aria-pressed={saved.includes(a.id)}
                  aria-label={saved.includes(a.id) ? "Ta bort från sparade" : "Spara uppdrag"}
                  title={saved.includes(a.id) ? "Sparad" : "Spara"}
                  onClick={() => toggleSaved(a.id)}
                >
                  {saved.includes(a.id) ? "★" : "☆"}
                </button>
              </div>
            </div>
            {a.description && (
              <p className="desc" onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: "pointer" }}>
                <Highlight text={a.description} words={a.matched} />
              </p>
            )}
            {a.matched.length > 0 && (
              <div className="tags">
                {a.matched.map((m) => (
                  <span className="tag" key={m}>
                    {m}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      {data && !loading && !visible.length && !error && (
        <div className="empty">
          {data.total === 0
            ? "Inga uppdrag kunde hämtas från källorna just nu. Försök igen om en stund."
            : view === "saved"
              ? "Du har inte sparat några uppdrag än. Klicka på ☆ för att spara."
              : "Inga uppdrag matchar. Prova färre eller andra nyckelord."}
        </div>
      )}

      <footer>
        Uppdragen hämtas från publika sidor och cachas i 15 minuter. Klicka på ett uppdrag för att läsa mer och anmäla
        intresse direkt hos portalen.
      </footer>
    </div>
  );
}
