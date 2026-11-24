"use client";

import { useEffect, useMemo, useState } from "react";
import type { DuplicateGroup, DuplicateReport } from "@/lib/duplicates";

function formatDate(d?: string) {
  if (!d) return null;
  const date = new Date(d);
  return isNaN(date.getTime()) ? d : date.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

const nf = new Intl.NumberFormat("sv-SE");
const hasSure = (g: DuplicateGroup) => g.pairs.some((p) => p.certain);

/** Etikett för en grupp eller ett par: "Säker" eller "72 % sannolik". */
export function ConfidenceBadge({ certain, confidence }: { certain: boolean; confidence: number }) {
  return certain ? (
    <span className="dup-badge sure" title="Säker dubblett">
      ✔ Säker dubblett
    </span>
  ) : (
    <span className="dup-badge maybe" title={`Bedömd sannolikhet att det är samma uppdrag: ${confidence} %`}>
      ≈ {confidence} % misstänkt
    </span>
  );
}

function Kpi({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{nf.format(value)}</div>
      <div className="kpi-label">{label}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

/** Stapeldiagram: antal dubblettpar per säkerhetsintervall (en serie, en färg). */
function ConfidenceChart({ buckets }: { buckets: DuplicateReport["buckets"] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <figure className="chart">
      <figcaption>Jämförda par per bedömd säkerhet</figcaption>
      <div className="bars" role="list">
        {buckets.map((b) => (
          <div className="bar-col" role="listitem" key={b.label} title={`${b.label}: ${b.count} par`}>
            <span className="bar-value">{b.count}</span>
            <div className="bar-track">
              <div className="bar" style={{ height: `${(b.count / max) * 100}%` }} />
            </div>
            <span className="bar-label">{b.label}</span>
          </div>
        ))}
      </div>
      <p className="chart-note">
        Ett par är två annonser som jämförts. Finns samma uppdrag i tre annonser blir det tre par men två dubbletter,
        så antalet par kan vara större än antalet dubbletter ovan.
      </p>
    </figure>
  );
}

/** Värmekarta: hur många av radkällans annonser som också finns hos kolumnkällan (diagonalen = inom samma källa). */
function OverlapHeatmap({ overlap }: { overlap: DuplicateReport["overlap"] }) {
  // Bara källor som har någon dubblett, så kartan blir läsbar.
  const keep = overlap.sources.map((_, i) => overlap.matrix[i].some((n) => n > 0));
  const idx = overlap.sources.map((_, i) => i).filter((i) => keep[i]);
  const max = Math.max(1, ...idx.flatMap((i) => idx.map((j) => overlap.matrix[i][j])));
  if (!idx.length) return null;
  return (
    <figure className="chart">
      <figcaption>Vilka källor delar uppdrag? (antal annonser)</figcaption>
      <div className="heat-scroll">
        <table className="heat">
          <thead>
            <tr>
              <th />
              {idx.map((j) => (
                <th key={j} scope="col" className="heat-col">
                  <span>{overlap.sources[j]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {idx.map((i) => (
              <tr key={i}>
                <th scope="row">{overlap.sources[i]}</th>
                {idx.map((j) => {
                  const n = overlap.matrix[i][j];
                  const label =
                    i === j
                      ? `${n} annonser från ${overlap.sources[i]} har en dubblett inom ${overlap.sources[i]}`
                      : `${n} annonser från ${overlap.sources[i]} finns även hos ${overlap.sources[j]}`;
                  return (
                    <td
                      key={j}
                      title={label}
                      aria-label={label}
                      className={`${n ? "" : "zero"}${i === j ? " diag" : ""}`}
                      style={n ? { background: `color-mix(in srgb, var(--accent) ${Math.round(15 + (n / max) * 85)}%, var(--surface))` } : undefined}
                    >
                      <span className={n / max > 0.55 ? "on-dark" : ""}>{n || ""}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="chart-note">
        Läs radvis: siffran är hur många av radens annonser som även finns hos kolumnens källa. Diagonalen visar
        annonser med dubblett inom samma källa. Mörkare ruta = fler annonser.
      </p>
    </figure>
  );
}

/** Liten matris för en grupp: bedömd säkerhet för varje par av annonser (tomt = under 50 %). */
function GroupMatrix({ group }: { group: DuplicateGroup }) {
  const n = group.items.length;
  const pos = new Map(group.items.map((it, i) => [it.id, i]));
  const cell = group.items.map(() => group.items.map((): DuplicateGroup["pairs"][number] | null => null));
  for (const p of group.pairs) {
    const i = pos.get(p.a);
    const j = pos.get(p.b);
    if (i === undefined || j === undefined) continue;
    cell[i][j] = p;
    cell[j][i] = p;
  }
  const label = (i: number) => {
    const it = group.items[i];
    return `${i + 1} ${it.source}${it.company ? ` (${it.company})` : ""}`;
  };
  return (
    <figure className="dup-matrix">
      <figcaption>Hur annonserna hänger ihop (nummer enligt listan ovan)</figcaption>
      <div className="heat-scroll">
        <table className="heat">
          <thead>
            <tr>
              <th />
              {group.items.map((_, j) => (
                <th key={j} scope="col">
                  {j + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.items.map((it, i) => (
              <tr key={it.id}>
                <th scope="row" title={label(i)}>
                  {i + 1}
                </th>
                {Array.from({ length: n }, (_, j) => {
                  const p = cell[i][j];
                  if (i === j) return <td key={j} className="zero self" aria-label="samma annons" />;
                  const text = p ? (p.certain ? "säker" : `${p.confidence} %`) : "under 50 %";
                  const title = `${label(i)} ↔ ${label(j)}: ${text}`;
                  return (
                    <td
                      key={j}
                      title={title}
                      aria-label={title}
                      className={p ? "" : "zero"}
                      style={p ? { background: `color-mix(in srgb, var(--accent) ${p.certain ? 100 : Math.round(15 + ((p.confidence - 50) / 49) * 70)}%, var(--surface))` } : undefined}
                    >
                      <span className={p && (p.certain || p.confidence >= 80) ? "on-dark" : ""}>{p ? (p.certain ? "✔" : p.confidence) : ""}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="chart-note">
        Siffran är bedömd sannolikhet i procent, ✔ betyder säker dubblett. Tom ruta: paret är under 50 % på egen hand men
        hör till gruppen via andra annonser.
      </p>
    </figure>
  );
}

function GroupCard({ group, highlight }: { group: DuplicateGroup; highlight: boolean }) {
  const byId = new Map(group.items.map((i) => [i.id, i]));
  const pos = new Map(group.items.map((it, i) => [it.id, i + 1]));
  const name = (id: string) => `${pos.get(id) ?? "?"} ${byId.get(id)?.source ?? id}`;
  return (
    <article className={`card dup-group${highlight ? " highlight" : ""}`} id={`dup-${group.items[0].id}`}>
      <div className="dup-head">
        {group.certain ? (
          <ConfidenceBadge certain confidence={100} />
        ) : (
          <>
            {group.pairs.some((p) => p.certain) && <ConfidenceBadge certain confidence={100} />}
            <ConfidenceBadge certain={false} confidence={group.confidence} />
          </>
        )}
        <span className="dup-count">{group.items.length} annonser</span>
      </div>
      <ul className="dup-items">
        {group.items.map((it, i) => (
          <li key={it.id}>
            <span className="dup-num">{i + 1}</span>
            <span className="badge">{it.source}</span>{" "}
            <a href={it.url} target="_blank" rel="noopener noreferrer">
              {it.title}
            </a>
            <span className="dup-meta">
              {[it.company, it.location, it.published && `publ. ${formatDate(it.published)}`, it.start && `start ${formatDate(it.start)}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <details className="dup-why">
        <summary>Varför?</summary>
        {group.items.length > 2 && <GroupMatrix group={group} />}
        <ul>
          {group.pairs.map((p) => (
            <li key={`${p.a}|${p.b}`}>
              <strong>
                {name(p.a)} ↔ {name(p.b)}
              </strong>{" "}
              {p.certain ? "säker" : `${p.confidence} %`}: {p.reasons.join(", ")}
              {p.against.length > 0 && <span className="dup-against"> · emot: {p.against.join(", ")}</span>}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export default function Duplicates({
  report,
  loading,
  error,
  focus,
}: {
  report: DuplicateReport | null;
  loading: boolean;
  error: string | null;
  focus: string | null;
}) {
  const [show, setShow] = useState<"all" | "sure" | "maybe">("all");
  const [limit, setLimit] = useState(40);
  const groups = useMemo(
    () => (report?.groups ?? []).filter((g) => (show === "sure" ? hasSure(g) : show === "maybe" ? !g.certain : true)),
    [report, show],
  );
  const focusIndex = focus ? groups.findIndex((g) => g.items.some((i) => i.id === focus)) : -1;

  useEffect(() => {
    if (focusIndex < 0) return;
    if (focusIndex >= limit) setLimit(focusIndex + 10);
    const el = document.getElementById(`dup-${groups[focusIndex].items[0].id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusIndex, groups, limit]);

  if (error) return <div className="error">Kunde inte analysera dubbletter: {error}</div>;
  if (!report) return <div className="list">{loading && Array.from({ length: 3 }, (_, i) => <div className="skeleton" key={i} />)}</div>;

  const share = report.total ? Math.round((report.redundant / report.total) * 100) : 0;
  return (
    <section aria-label="Dubbletter">
      <div className="kpis">
        <Kpi label="uppdrag i listan" value={report.total} note="samma som under Uppdrag" />
        <Kpi label="unika uppdrag" value={report.unique} note={`${share} % av listan är dubbletter`} />
        <Kpi label="säkra dubbletter" value={report.redundantCertain} note="annonser som är kopior av en annan" />
        <Kpi label="misstänkta dubbletter" value={report.redundantSuspected} note="annonser som troligen är kopior" />
      </div>

      <div className="charts">
        <ConfidenceChart buckets={report.buckets} />
        <OverlapHeatmap overlap={report.overlap} />
      </div>

      <details className="panel method">
        <summary>Så bedöms dubbletter</summary>
        <p>
          Varje par av uppdrag med liknande titel (eller samma annonslänk) jämförs. En <strong>säker dubblett</strong> är
          ett par med samma annonslänk, med i praktiken samma titel och minst 85 % lik beskrivning, eller med minst 92 %
          lik beskrivning (kopierad text) och minst 60 % lik titel.
        </p>
        <p>
          Övriga par får en <strong>bedömd sannolikhet</strong> i procent. Titelns likhet ger upp till 55 poäng (korta,
          allmänna titlar som ”Business Analyst” upp till 45). Beskrivningarnas likhet ger upp till 35: antingen kopierad
          text eller omskriven text om samma sak, där samma ovanliga ord återkommer (t.ex. ”PLM”, ”Teamcenter”). Saknas
          beskrivning väger titeln för båda; handlar texterna om helt olika saker dras 15 poäng av.
        </p>
        <p>
          Samma ort ger +8 och samma <em>ovanliga</em> ort (under 3 % av annonserna, t.ex. Finspång) +20. Olika orter
          ger −20, men orter i samma region (t.ex. Solna och Stockholm) räknas varken som samma eller olika. Samma
          startdatum ger +5, samma sista ansökningsdag +4 och startdatum mer än två veckor isär −10. Samma källa och samma
          företag ger −5. Par under 50 % visas inte. Datumstämplar och prefix som ”Konsultuppdrag –” tas bort innan
          titlarna jämförs.
        </p>
        <p>
          Analysen gäller samma annonser som listan under Uppdrag, alltså de som matchar dina nyckelord, inklusive
          Platsbanken och Brainvilles sökning.
        </p>
        <p>
          Antalet dubbletter räknas som hur många annonser listan hade haft färre om varje uppdrag bara fanns en gång.
          Bedömningen är automatisk: kontrollera under ”Varför?” innan du drar slutsatser om en misstänkt dubblett.
        </p>
      </details>

      <div className="controls dup-controls">
        <div className="seg" role="group" aria-label="Visa grupper">
          <button aria-pressed={show === "all"} onClick={() => setShow("all")}>
            Alla ({report.groups.length})
          </button>
          <button aria-pressed={show === "sure"} onClick={() => setShow("sure")}>
            Säkra ({report.groups.filter(hasSure).length})
          </button>
          <button aria-pressed={show === "maybe"} onClick={() => setShow("maybe")}>
            Misstänkta ({report.groups.filter((g) => !g.certain).length})
          </button>
        </div>
      </div>

      <div className="list">
        {groups.slice(0, limit).map((g, i) => (
          <GroupCard key={g.items[0].id} group={g} highlight={i === focusIndex} />
        ))}
      </div>
      {groups.length > limit && (
        <p style={{ textAlign: "center" }}>
          <button className="btn" onClick={() => setLimit((l) => l + 40)}>
            Visa fler ({groups.length - limit} kvar)
          </button>
        </p>
      )}
      {!groups.length && <div className="empty">Inga dubbletter hittades.</div>}
    </section>
  );
}
