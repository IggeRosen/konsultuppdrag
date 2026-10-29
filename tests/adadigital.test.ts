// Sitemap och JSON-LD är riktiga (adadigital.se via /api/debug, 2026-10-29), förkortade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAdaSlug, parseAdaJob, parseAdaSitemap } from "../src/lib/sources/adadigital.ts";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.adadigital.se/lediga-jobb/data-och-analytics/data-scientist-inom-paketlogistik-till-postnord/</loc><lastmod>2026-10-05T08:17:07+00:00</lastmod></url>
<url><loc>https://www.adadigital.se/lediga-jobb/data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm/</loc><lastmod>2026-10-27T12:57:03+00:00</lastmod></url>
<url><loc>https://www.adadigital.se/lediga-jobb/tech/systemtekniker-till-ticket-i-stockholm/</loc><lastmod>2026-10-29T15:07:03+00:00</lastmod></url>
<url><loc>https://www.adadigital.se/lediga-jobb/ort/stockholm/</loc></url>
</urlset>`;

const LD = `
			{
				"@context": "http://schema.org",
				"@type": "JobPosting",
				"title": "Konsult \\/ Interim Data Engineer \\/ BI i Stockholm",
				"jobBenefits": "Centralt kontor, Flexibel arbetsplats, Dedikerad konsultchef, Ny Teknik",
				"datePosted": "2026-10-27T13:57:03+01:00",
				"description": "\\u00c4r du konsult \\/ interim och s\\u00f6ker nytt uppdrag som Data Engineer eller BI-utvecklare i Stockholm? L\\u00e4s d\\u00e5 vidare!",
				"employmentType": "FULL_TIME",
				"industry": "Data och Analytics",
				"hiringOrganization": {
					"@type": "Organization",
					"name": "Ada Digital"				},
				"jobLocation": {
					"@type": "Place",
					"address": { "@type": "PostalAddress", "addressLocality": "Stockholm", "addressRegion": "Stockholms l\\u00e4n", "addressCountry": "SE" }
				},
				"validThrough": "2026-11-26"
			}
		`;
const URL_ = "https://www.adadigital.se/lediga-jobb/data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm/";
const page = (body = "") => `<html><head><script type="application/ld+json">${LD}</script></head><body><header><nav>Lediga IT-jobb</nav></header>${body}<footer>Kontakt</footer></body></html>`;

test("parseAdaSitemap ger annonserna, nyast först, utan ort-/yrkessidor", () => {
  const e = parseAdaSitemap(SITEMAP);
  assert.deepEqual(
    e.map((x) => x.slug),
    ["tech/systemtekniker-till-ticket-i-stockholm", "data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm", "data-och-analytics/data-scientist-inom-paketlogistik-till-postnord"],
  );
});

test("parseAdaJob läser JSON-LD JobPosting", () => {
  const a = parseAdaJob(page(), URL_);
  assert.ok(a);
  assert.equal(a.id, "adadigital:data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm");
  assert.equal(a.source, "ADA Digital");
  assert.equal(a.title, "Konsult / Interim Data Engineer / BI i Stockholm");
  assert.equal(a.url, URL_);
  assert.equal(a.company, "Ada Digital");
  assert.equal(a.location, "Stockholm");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-10-27");
  assert.equal(a.deadline, "2026-11-26");
  assert.equal(a.extent, "Konsultuppdrag/interim");
  assert.match(a.description ?? "", /^Är du konsult \/ interim/);
  assert.match(a.description ?? "", /Område: Data och Analytics\./);
});

test("parseAdaJob tar annonstexten från sidan när den finns", () => {
  const text = "Om uppdraget. ".repeat(30);
  const a = parseAdaJob(page(`<main><h1>Rubrik</h1><p>${text}</p><ul><li>SQL</li><li>Power BI</li></ul></main>`), URL_);
  assert.match(a?.description ?? "", /Om uppdraget\./);
  assert.match(a?.description ?? "", /\nSQL\nPower BI/);
  assert.doesNotMatch(a?.description ?? "", /Lediga IT-jobb|Kontakt/);
});

test("extractAdaSlug", () => {
  assert.equal(extractAdaSlug(URL_), "data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm");
  assert.equal(extractAdaSlug("https://www.adadigital.se/lediga-jobb/yrke/data-och-analytics/"), null);
  assert.equal(extractAdaSlug("https://www.adadigital.se/kontakta/"), null);
});
