// Sitemap och JSON-LD är riktiga (itjobb.se via /api/debug, 2026-10-29), förkortade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractItjobbSlug, parseItjobbJob, parseItjobbSitemap } from "../src/lib/sources/itjobb.ts";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://itjobb.se/sv/jobb</loc><lastmod>2026-10-29T13:53:11.916Z</lastmod></url>
<url><loc>https://itjobb.se/sv/jobb/natverkstekniker-84</loc><lastmod>2026-10-28T19:07:44.494Z</lastmod></url>
<url><loc>https://itjobb.se/sv/jobb/it-sakerhetstekniker-15</loc><lastmod>2026-10-28T21:47:44.732Z</lastmod></url>
<url><loc>https://itjobb.se/sv/jobb/senior-testledare-it-projektledare-1</loc><lastmod>2026-10-19T12:07:45.998Z</lastmod></url>
</urlset>`;

const JOB = {
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  title: "Senior Testledare (IT-projektledare)",
  description:
    "Vill du vara med och bidra till att skapa Sveriges bästa hälso-och sjukvård?\nVi står mitt i en omfattande digital utveckling.  \n\n\nDitt uppdrag \nSom senior testledare ansvarar du för att planera, leda och samordna testaktiviteter.",
  datePosted: "2026-10-17T08:00:00.000Z",
  validThrough: "2026-11-16T22:59:59.000Z",
  employmentType: "FULL_TIME",
  hiringOrganization: { "@type": "Organization", name: "Västra Götalandsregionen IT" },
  jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressRegion: "Västra Götalands län", addressCountry: "SE" } },
};
const html = (j: unknown) =>
  `<html><head><script type="application/ld+json" id="jsonld-Corporation">{"@context":"https://schema.org","@type":"Corporation","name":"ITJobb"}</script><script type="application/ld+json" id="jobPosting-jsonld">${JSON.stringify(j)}</script></head><body></body></html>`;

test("annonsadresser", () => {
  assert.equal(extractItjobbSlug("https://itjobb.se/sv/jobb/natverkstekniker-84"), "natverkstekniker-84");
  assert.equal(extractItjobbSlug("https://itjobb.se/sv/jobb"), null);
  assert.equal(extractItjobbSlug("https://itjobb.se/sv/lediga-jobb/data-it"), null);
  assert.equal(extractItjobbSlug("https://example.com/sv/jobb/natverkstekniker-84"), null);
});

test("sitemapen: bara annonser, nyast ändrade först", () => {
  assert.deepEqual(
    parseItjobbSitemap(SITEMAP).map((e) => e.slug),
    ["it-sakerhetstekniker-15", "natverkstekniker-84", "senior-testledare-it-projektledare-1"],
  );
});

test("annonssidan via JSON-LD JobPosting", () => {
  const a = parseItjobbJob(html(JOB), "https://itjobb.se/sv/jobb/senior-testledare-it-projektledare-1");
  assert.deepEqual(a, {
    id: "itjobb:senior-testledare-it-projektledare-1",
    source: "ITJobb",
    title: "Senior Testledare (IT-projektledare)",
    url: "https://itjobb.se/sv/jobb/senior-testledare-it-projektledare-1",
    company: "Västra Götalandsregionen IT",
    location: "Västra Götalands län",
    country: "SE",
    published: "2026-10-17",
    deadline: "2026-11-16",
    extent: "Heltid",
    description:
      "Vill du vara med och bidra till att skapa Sveriges bästa hälso-och sjukvård?\nVi står mitt i en omfattande digital utveckling.\n\nDitt uppdrag\nSom senior testledare ansvarar du för att planera, leda och samordna testaktiviteter.",
  });
  const remote = parseItjobbJob(
    html({ ...JOB, employmentType: ["CONTRACTOR", "PART_TIME"], jobLocationType: "TELECOMMUTE", jobLocation: [{ address: { addressLocality: "Stockholm" } }, { address: { addressLocality: "Göteborg" } }] }),
    "https://itjobb.se/sv/jobb/x-1",
  );
  assert.equal(remote?.extent, "Konsultuppdrag, Deltid");
  assert.equal(remote?.workMode, "Distans");
  assert.equal(remote?.location, "Stockholm, Göteborg");
  assert.equal(parseItjobbJob("<html></html>", "https://itjobb.se/sv/jobb/x-1"), null);
});
