import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities } from "../src/lib/parse-utils.ts";
import { parseMagnitJson } from "../src/lib/sources/magnit-parse.ts";

test("HTML-entiteter avkodas", () => {
  assert.equal(decodeEntities("F&ouml;r att kunna svara p&aring; detta avrop"), "För att kunna svara på detta avrop");
  assert.equal(decodeEntities("V&auml;nligen &Aring;&Auml;&Ouml; &#228;&#xE5; &amp; &nbsp;x"), "Vänligen ÅÄÖ äå &  x");
  assert.equal(decodeEntities("&okänd; &unknown; 5 & 6"), "&okänd; &unknown; 5 & 6");
});

// Text från Magnits uppdrag "Senior Metodutvecklare (nivå 3) Linköping" (sökning på "PLM", 2026-10-15).
test("Magnit: beskrivning och ort med å, ä och ö", () => {
  const [a] = parseMagnitJson({
    jobs: [
      {
        id: "MAGNIT-12345",
        title: "Senior Metodutvecklare (niv&aring; 3) Link&ouml;ping",
        location: "Linkoping, SWE",
        clientInfo: { name: "SAAB AB" },
        description:
          "<p>Observera! F&ouml;r att kunna svara p&aring; detta avrop ber vi er att fylla i kravmatrisen och bifoga ett CV. V&auml;nligen se bifogad manual f&ouml;r instruktioner.</p><p>&nbsp;</p><p>Varje leverant&ouml;r f&aring;r maximalt skicka in 3 kandidater</p>",
        publishedDate: "2026-10-10T08:00:00Z",
      },
    ],
  });
  assert.equal(a.title, "Senior Metodutvecklare (nivå 3) Linköping");
  assert.equal(a.location, "Linköping");
  assert.equal(
    a.description,
    "Observera! För att kunna svara på detta avrop ber vi er att fylla i kravmatrisen och bifoga ett CV. Vänligen se bifogad manual för instruktioner. Varje leverantör får maximalt skicka in 3 kandidater",
  );
});
