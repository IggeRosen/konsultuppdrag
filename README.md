# Uppdragsradarn

En webbapp som samlar publicerade konsultuppdrag från uppdragsportaler och
filtrerar dem på dina nyckelord. Källor just nu: **Brainville**, **Cinode Market** och **Ework** (via Verama).

## Funktioner

- Nyckelord som chips (sparas i webbläsaren och i URL:en – länken går att dela)
- Matcha *något* eller *alla* nyckelord; träffar i titeln rankas högst
- Helordsmatchning som klarar `C#`, `.NET`, `Go` (matchar inte "Google")
- Markering av träffar, sortering, fritextfilter
- "Nya sedan senaste besöket" och ★ sparade uppdrag
- Status per källa, så man ser om en portal inte svarar – klicka på en källa för att dölja/visa den

## Arkitektur

```
src/lib/sources/brainville.ts        hämtning (sök-sidor + företagssidor + detaljsidor)
src/lib/sources/brainville-parse.ts  ren HTML-tolkning (testbar)
src/lib/sources/cinode.ts            Cinode Market (listsida + sitemap + detaljsidor)
src/lib/sources/cinode-loadmore.ts   "Load more"-paginering för Cinode
src/lib/sources/ework.ts             Ework/Verama (JSON-API + listsida + sitemap + detaljsidor)
src/lib/sources/ework-parse.ts       tolkning av Veramas JSON och HTML
src/lib/sitemap.ts                   delad sitemap-läsning
src/lib/sources/cinode-parse.ts      ren HTML-tolkning för Cinode
src/lib/parse-utils.ts               delade tolkningshjälpare (kort, JSON, JSON-LD, nästa sida)
src/lib/paging.ts                    delad paginering
src/lib/sources/index.ts             register över källor – lägg till nya portaler här
src/lib/aggregate.ts                 kör alla källor parallellt, cache 15 min
src/lib/match.ts                     nyckelordsmatchning och poängsättning
src/app/api/assignments/route.ts     GET /api/assignments?keywords=java,react&mode=any|all
src/app/api/debug/route.ts           GET /api/debug?url=<brainville-, cinode- eller verama-url> – visar vad scrapern ser
src/components/App.tsx               UI
```

### Brainville

Brainvilles API listar bara uppdrag som det egna företaget publicerat, så appen
läser de publika sidorna:

1. Söksidan `/PublicPage/RequisitionSearch`, med paginering: en "nästa"-länk följs
   om den finns, annars provas vanliga sidparametrar (`page`, `p` …). Max `BRAINVILLE_MAX_PAGES` (10) sidor.
   Sammanfattningsraden ("Finspång Start immediately about 12 months 1 d") delas upp i
   ort, start, längd, omfattning och publiceringsdatum.
2. Förmedlares "Öppna uppdrag"-sidor `/PublicProfile/Requisitions?id=<företag>`
   (Ework, KeyMan, Randstad m.fl. – ändra med `BRAINVILLE_COMPANY_IDS=648,7820,...`)
3. Detaljsidor för varje uppdrag (för beskrivningstext), max `BRAINVILLE_MAX_DETAILS` (60)

Uppdrag identifieras via länkmönstren `/Market/RequisitionSearchResult/Details/<id>`
och `/PublicProfile/Requisition?...&id=<id>`. Inbäddad JSON i `<script>` tolkas också.

### Cinode

[Cinode Market](https://cinode.market/requests) är öppen utan inloggning. Appen läser:

1. Listsidan `cinode.com/market/requests` (20 uppdrag per sida). Varje kort tolkas strukturerat:
   titel, kund, ort, distans/hybrid, period, publicerad och sista svarsdag.
   Nästa sida hämtas via "Load more"-knappens `data-next-cursor` med `?nextCursor=<cursor>`.
   Slutar den adressen fungera provas alternativ automatiskt (se
   `/api/debug?url=https://cinode.market/requests&probe=1`), och den kan överstyras med
   `CINODE_LOAD_MORE_URL`, t.ex. `https://cinode.com/market/requests?nextCursor={cursor}`. Max `CINODE_MAX_PAGES` = 10.
2. Sitemapen (`robots.txt` → `sitemap.xml`): de nyaste uppdragen (högst id), max `CINODE_MAX_SITEMAP` = 80
3. Detaljsidor `cinode.market/requests/<id>`: titel och kund ur sidtiteln
   ("Cinode Market - Titel - Kund - Referens"), JSON-LD `JobPosting`, sista svarsdag,
   ort, start och beskrivning. Max `CINODE_MAX_DETAILS` = 80

Uppdrag vars sista svarsdag har passerat filtreras bort.

### Ework

Ework publicerar sina uppdrag på [Verama](https://app.verama.com/sv/job-requests), en
JavaScript-app som hämtar listan från ett JSON-API. Appen läser:

1. JSON-API:t `app.verama.com/api/public/job-requests?page=0&size=50` (publikt, nyaste först),
   med paginering (`totalPages`/`last`), max `EWORK_MAX_PAGES` = 6 sidor à 50 uppdrag. Svarar
   det inte provas några alternativ. Adressen kan överstyras med `EWORK_API_URL` (`{page}` = sidnummer).
   Kontrollera med `/api/debug?url=https://app.verama.com/sv/job-requests&probe=1`, som även visar
   fältnamnen (`firstKeys`) och hur första uppdraget tolkas (`firstItem`).
2. Listsidan `app.verama.com/sv/job-requests` (länkar och inbäddad JSON om den är serverrenderad)
3. Sitemapen (bara om API:t inte svarar): de nyaste uppdragen, max `EWORK_MAX_SITEMAP` = 60
4. Detaljsidor `app.verama.com/sv/job-requests/<id>` för uppdrag som saknar titel (titel och beskrivning ur meta), max `EWORK_MAX_DETAILS` = 60

Uppdrag vars sista ansökningsdag har passerat filtreras bort.

### Lägga till en ny portal

Skapa `src/lib/sources/<portal>.ts` som exporterar en `SourceAdapter`
(`fetchAssignments()` returnerar `Assignment[]`) och lägg till den i `SOURCES`.

## Utveckling

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # enhetstester för tolkning och matchning
npm run build
```

## Publicera på Vercel

1. Importera repot på vercel.com → *Add New Project* (ramverket känns igen som Next.js).
2. Ingen konfiguration krävs. Valfria miljövariabler: `BRAINVILLE_COMPANY_IDS`, `BRAINVILLE_MAX_PAGES`, `BRAINVILLE_MAX_DETAILS`, `CINODE_LOAD_MORE_URL`, `CINODE_MAX_PAGES`, `CINODE_MAX_SITEMAP`, `CINODE_MAX_DETAILS`, `EWORK_API_URL`, `EWORK_MAX_PAGES`, `EWORK_MAX_SITEMAP`, `EWORK_MAX_DETAILS`.
3. Sätt er domän under *Settings → Domains*.

Efter första deployen: öppna `/api/debug` för att se hur Brainvilles söksida
ser ut från Vercel och om scrapern hittar uppdrag (`parsedCount`). Svaret visar också
`nextPage`, `paginationHints`, `forms` och `listSnippet` (listans HTML). Lägg till
`&full=1` för hela sidans HTML.
