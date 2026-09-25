# Uppdragsradarn

En webbapp som samlar publicerade konsultuppdrag från uppdragsportaler och
filtrerar dem på dina nyckelord. Första källan är **Brainville**.

## Funktioner

- Nyckelord som chips (sparas i webbläsaren och i URL:en – länken går att dela)
- Matcha *något* eller *alla* nyckelord; träffar i titeln rankas högst
- Helordsmatchning som klarar `C#`, `.NET`, `Go` (matchar inte "Google")
- Markering av träffar, sortering, fritextfilter
- "Nya sedan senaste besöket" och ★ sparade uppdrag
- Status per källa, så man ser om en portal inte svarar

## Arkitektur

```
src/lib/sources/brainville.ts        hämtning (sök-sidor + företagssidor + detaljsidor)
src/lib/sources/brainville-parse.ts  ren HTML-tolkning (testbar)
src/lib/sources/index.ts             register över källor – lägg till nya portaler här
src/lib/aggregate.ts                 kör alla källor parallellt, cache 15 min
src/lib/match.ts                     nyckelordsmatchning och poängsättning
src/app/api/assignments/route.ts     GET /api/assignments?keywords=java,react&mode=any|all
src/app/api/debug/route.ts           GET /api/debug?url=<brainville-url> – visar vad scrapern ser
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
2. Ingen konfiguration krävs. Valfria miljövariabler: `BRAINVILLE_COMPANY_IDS`, `BRAINVILLE_MAX_PAGES`, `BRAINVILLE_MAX_DETAILS`.
3. Sätt er domän under *Settings → Domains*.

Efter första deployen: öppna `/api/debug` för att se hur Brainvilles söksida
ser ut från Vercel och om scrapern hittar uppdrag (`parsedCount`). Svaret visar också
`nextPage`, `paginationHints`, `forms` och `listSnippet` (listans HTML). Lägg till
`&full=1` för hela sidans HTML.
