// Förfrågan till emagines POST /api/JobAds/Search är odokumenterad. API:t är
// ASP.NET och svarar 400 med valideringsfel, t.ex.
//   {"errors":{"Filter":["The Filter field is required."],"Sorting":[...]}}
// eller "$.sorting.direction": ["The JSON value could not be converted to System.Int32 ..."].
// fixSearchBody läser felen och kompletterar förfrågan, så att rätt format kan
// hittas stegvis (se probeEmagineApi och scrapeSearch i emagine.ts).

type Json = Record<string, unknown>;

export const EMAGINE_PAGE_SIZE = 100; // portalens största sidstorlek (pageSizeOptions 20/50/100)

const PAGE_KEY = /^(page|pageNumber|pageNo|currentPage)$/i;
const PAGE_INDEX_KEY = /^(pageIndex)$/i;
const SIZE_KEY = /^(pageSize|size|take|limit|perPage|count|itemsPerPage|maxResultCount)$/i;
const SKIP_KEY = /^(skip|skipCount|offset|from|start)$/i;

/**
 * Startförfrågningar. Formatet är portalens eget (proxySearchAllJobs i
 * chunk-CU2XS2X6.js, 2026-09-26): { skipCount, maxResultCount, sorting, filter,
 * supportedLanguageId }, där sorting är t.ex. "CreationTime desc" (NewestFirst i
 * chunk-JD6HBCB5.js). Filtrets fält och språkets id är inte kända; saknas något
 * som krävs kompletteras det ur valideringsfelen.
 */
export function seedBodies(): Json[] {
  const base = { skipCount: 0, maxResultCount: EMAGINE_PAGE_SIZE, sorting: "CreationTime desc", filter: {} };
  return [{ ...base, supportedLanguageId: 1 }, base];
}

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "$.Filter.Paging[0].PageSize" / "Filter.PageSize" → ["filter","paging","pageSize"] */
export function errorPath(key: string): string[] {
  return key
    .replace(/^\$\.?/, "")
    .replace(/\[\d+\]/g, "")
    .split(".")
    .filter(Boolean)
    .map(camel);
}

function getPath(o: Json, path: string[]): unknown {
  let cur: unknown = o;
  for (const p of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    // ASP.NET matchar namn skiftlägesokänsligt.
    const k = Object.keys(cur).find((x) => x.toLowerCase() === p.toLowerCase());
    cur = k === undefined ? undefined : (cur as Json)[k];
  }
  return cur;
}

function setPath(o: Json, path: string[], value: unknown): boolean {
  let cur: Json = o;
  for (const [i, p] of path.entries()) {
    const k = Object.keys(cur).find((x) => x.toLowerCase() === p.toLowerCase()) ?? p;
    if (i === path.length - 1) {
      if (JSON.stringify(cur[k]) === JSON.stringify(value)) return false;
      cur[k] = value;
      return true;
    }
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  return false;
}

/** Rimligt värde för ett fält utifrån namnet (sidnummer, sidstorlek …). */
function valueByName(name: string): unknown {
  if (PAGE_KEY.test(name)) return 1;
  if (PAGE_INDEX_KEY.test(name) || SKIP_KEY.test(name)) return 0;
  if (SIZE_KEY.test(name)) return EMAGINE_PAGE_SIZE;
  if (/^(is|has|include|only|show)[A-Z]/.test(name)) return false;
  if (/(Ids|List|s)$/.test(name) && !/(Status|Address|Class)$/.test(name)) return [];
  if (/(id|number|count|type|direction|order)$/i.test(name)) return 0;
  return "";
}

/** Värde av den typ .NET-felmeddelandet nämner. */
function valueByType(msg: string, name: string): unknown {
  const t = msg.match(/converted to ([\w.`[\]]+)/)?.[1] ?? "";
  if (/Int\d+|Decimal|Double|Single|Byte/.test(t)) return /size/i.test(name) ? EMAGINE_PAGE_SIZE : PAGE_KEY.test(name) ? 1 : 0;
  if (/System\.String/.test(t)) return "";
  if (/Boolean/.test(t)) return false;
  if (/List|IEnumerable|ICollection|\[\]/.test(t)) return [];
  if (/DateTime|Guid/.test(t)) return null;
  return t ? {} : undefined;
}

/**
 * Kompletterar förfrågan utifrån valideringsfelen. Ger null om inget gick att
 * ändra (då kommer vi inte längre).
 */
export function fixSearchBody(body: Json, errors: Record<string, unknown>): Json | null {
  const next = structuredClone(body);
  let changed = false;
  for (const [key, msgs] of Object.entries(errors)) {
    const path = errorPath(key);
    const msg = Array.isArray(msgs) ? msgs.join(" ") : String(msgs);
    if (!path.length || (path.length === 1 && path[0] === "request")) continue;
    const name = path[path.length - 1];
    const cur = getPath(next, path);
    let value: unknown;
    if (/could not be converted|invalid|not valid/i.test(msg)) {
      value = valueByType(msg, name);
      // Okänd typ: prova i tur och ordning objekt → text → tal → lista.
      if (value === undefined || JSON.stringify(value) === JSON.stringify(cur)) {
        const order: unknown[] = [{}, "", 0, []];
        const i = order.findIndex((v) => JSON.stringify(v) === JSON.stringify(cur));
        value = order[(i + 1) % order.length];
      }
    } else if (/required/i.test(msg)) {
      // Saknat fält: föräldern har fält (objekt) om den nämnts, annars gissa på namnet.
      value = cur === undefined ? (/^(filter|sorting|sort|paging|pagination|criteria|query)$/i.test(name) ? {} : valueByName(name)) : cur === "" ? 0 : cur === 0 ? {} : "";
    } else if (/between|greater|less|range|minimum|maximum/i.test(msg)) {
      value = SIZE_KEY.test(name) ? 20 : 1;
    }
    if (value !== undefined && setPath(next, path, value)) changed = true;
  }
  return changed ? next : null;
}

/** Samma förfrågan för en annan sida (1-baserad). */
export function withPage(body: Json, page: number): Json {
  const copy = structuredClone(body);
  let size = EMAGINE_PAGE_SIZE;
  const visitSize = (o: Json) => {
    for (const [k, v] of Object.entries(o)) {
      if (SIZE_KEY.test(k) && typeof v === "number") size = v;
      else if (v && typeof v === "object" && !Array.isArray(v)) visitSize(v as Json);
    }
  };
  visitSize(copy);
  const visit = (o: Json) => {
    for (const [k, v] of Object.entries(o)) {
      if (PAGE_KEY.test(k) && typeof v === "number") o[k] = page;
      else if (PAGE_INDEX_KEY.test(k) && typeof v === "number") o[k] = page - 1;
      else if (SKIP_KEY.test(k) && typeof v === "number") o[k] = (page - 1) * size;
      else if (v && typeof v === "object" && !Array.isArray(v)) visit(v as Json);
    }
  };
  visit(copy);
  return copy;
}

/** Sant om förfrågan har något sidfält (annars går det inte att bläddra). */
export function hasPaging(body: Json): boolean {
  return JSON.stringify(withPage(body, 2)) !== JSON.stringify(body);
}
