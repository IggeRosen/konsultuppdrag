# Uppdragsradarn

En webbapp som samlar publicerade konsultuppdrag från uppdragsportaler och
filtrerar dem på dina nyckelord. Källor just nu: **Brainville**, **Cinode Market**, **Ework** (via Verama), **KeyMan**, **Magnit** (Magnit Source) och **emagine**.

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
src/lib/sources/keyman.ts            KeyMan (listsida + sitemap + detaljsidor)
src/lib/sources/keyman-parse.ts      tolkning av keyman.se
src/lib/sources/magnit.ts            Magnit Source (POST-sökning + detaljer via API, Sverigefilter)
src/lib/sources/magnit-parse.ts      tolkning av Magnit Source
src/lib/sources/emagine.ts           emagine (listsidor + API + sitemap + detaljsidor, Sverigefilter)
src/lib/sources/emagine-parse.ts     tolkning av emagines portal och landssajter
src/lib/sweden.ts                    Sverigefilter för källor med uppdrag i flera länder
src/lib/sources/job-json.ts          generell tolkning av uppdragsobjekt i JSON (Verama, Magnit)
src/lib/json-api.ts                  generell sondering och paginering av JSON-API:er
src/lib/sitemap.ts                   delad sitemap-läsning
src/lib/sources/cinode-parse.ts      ren HTML-tolkning för Cinode
src/lib/parse-utils.ts               delade tolkningshjälpare (kort, JSON, JSON-LD, nästa sida)
src/lib/paging.ts                    delad paginering
src/lib/sources/index.ts             register över källor – lägg till nya portaler här
src/lib/aggregate.ts                 kör alla källor parallellt, cache 15 min
src/lib/match.ts                     nyckelordsmatchning och poängsättning
src/app/api/assignments/route.ts     GET /api/assignments?keywords=java,react&mode=any|all
src/app/api/debug/route.ts           GET /api/debug?url=<url hos någon av källorna> – visar vad scrapern ser
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

### KeyMan

KeyMan publicerar sina uppdrag på [keyman.se/sv/uppdrag](https://www.keyman.se/sv/uppdrag/).
Ett uppdrag har adressen `/sv/<kategori>/<titel>-<id>`. Appen läser:

1. Listsidan, med paginering (nästa-länk, `?page=` eller WordPress `/page/N/`), max `KEYMAN_MAX_PAGES` = 10
2. Sitemapen (`robots.txt`, `sitemap.xml`, `sitemap_index.xml`, `wp-sitemap.xml`): de nyaste uppdragen, max `KEYMAN_MAX_SITEMAP` = 60
3. Detaljsidor: titel och kund ur sidtiteln ("Titel - KUND - KeyMan" eller "… till Kund - KeyMan"),
   etiketterade fält (Ort, Omfattning, Start, Sista ansökningsdag …), JSON-LD och beskrivning,
   max `KEYMAN_MAX_DETAILS` = 80

Kategorin ur adressen (t.ex. Data/IT) läggs i beskrivningen. Utgångna uppdrag filtreras bort.

### Magnit

Magnit publicerar alla sina uppdrag öppet på [Magnit Source](https://magnit-source.magnitglobal.com/),
en Angular-app som hämtar uppdragen från en separat API-server
(`app-openmarketgateway-prod.azurewebsites.net`, kan ändras med `MAGNIT_GATEWAY_URL`).
Anropen är tagna ur sajtens JavaScript och används av sajten utan inloggning:

1. `POST /api/jobsearch` med `{ pageSize, sortOption: { orderBy: "PublishedDate", direction: "Desc" } }`,
   bläddras med `continuationToken` (sidstorlek `MAGNIT_PAGE_SIZE` = 100, max `MAGNIT_MAX_PAGES` = 10)
2. `GET /api/jobsearch/landing-page-job-requests` som reserv
3. `GET /api/jobsearch/<id>/details` för beskrivning (uppdragssidan på sajten är `/browse/job/<id>`), max `MAGNIT_MAX_DETAILS` = 120

Sajten är global, så appen visar bara uppdrag i Sverige ("Stockholm, SWE") eller med okänd plats.
Sätt `MAGNIT_ALL_COUNTRIES=1` för att visa alla. `/api/debug?url=https://magnit-source.magnitglobal.com/&probe=1`
visar vad sökningen ger.

### emagine

emagine publicerar uppdrag för frilanskonsulter i sin portal (`portal.emagine.org/jobs/<id>/<titel>`)
och listar dem på landssajterna, t.ex. [emagine-consulting.se](https://emagine-consulting.se/consultants/freelance-jobs/).
emagine finns i flera länder, så appen visar bara uppdrag i Sverige (eller med okänd plats);
`EMAGINE_ALL_COUNTRIES=1` visar alla. Appen läser:

1. Listsidorna på emagine-consulting.se, portal.emagine.org och emagine.org, med paginering (max `EMAGINE_MAX_PAGES` = 10)
2. Tänkbara JSON-API:er i portalen (`EMAGINE_API_URL` kan sättas)
3. Sitemaparna: de nyaste uppdragen, max `EMAGINE_MAX_SITEMAP` = 60
4. Detaljsidor: titel ("Titel • emagine Portal"), JSON-LD, plats, start, deadline, distans och beskrivning;
   uppdrag som inte längre tar emot ansökningar filtreras bort. Max `EMAGINE_MAX_DETAILS` = 80

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
2. Ingen konfiguration krävs. Valfria miljövariabler: `BRAINVILLE_COMPANY_IDS`, `BRAINVILLE_MAX_PAGES`, `BRAINVILLE_MAX_DETAILS`, `CINODE_LOAD_MORE_URL`, `CINODE_MAX_PAGES`, `CINODE_MAX_SITEMAP`, `CINODE_MAX_DETAILS`, `EWORK_API_URL`, `EWORK_MAX_PAGES`, `EWORK_MAX_SITEMAP`, `EWORK_MAX_DETAILS`, `KEYMAN_MAX_PAGES`, `KEYMAN_MAX_SITEMAP`, `KEYMAN_MAX_DETAILS`, `MAGNIT_GATEWAY_URL`, `MAGNIT_ALL_COUNTRIES`, `MAGNIT_PAGE_SIZE`, `MAGNIT_MAX_PAGES`, `MAGNIT_MAX_DETAILS`, `EMAGINE_API_URL`, `EMAGINE_ALL_COUNTRIES`, `EMAGINE_MAX_PAGES`, `EMAGINE_MAX_SITEMAP`, `EMAGINE_MAX_DETAILS`.
3. Sätt er domän under *Settings → Domains*.

Efter första deployen: öppna `/api/debug` för att se hur Brainvilles söksida
ser ut från Vercel och om scrapern hittar uppdrag (`parsedCount`). Svaret visar också
`nextPage`, `paginationHints`, `forms` och `listSnippet` (listans HTML). Lägg till
`&full=1` för hela sidans HTML.
