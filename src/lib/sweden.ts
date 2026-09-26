import type { Assignment } from "./types.ts";

// Filter för källor som publicerar uppdrag i flera länder (Magnit, Emagine).

export const SWEDISH_PLACES = [
  "sweden", "sverige", "stockholm", "göteborg", "goteborg", "gothenburg", "malmö", "malmo", "uppsala", "linköping",
  "linkoping", "västerås", "vasteras", "örebro", "orebro", "norrköping", "helsingborg", "jönköping", "umeå", "umea",
  "lund", "luleå", "lulea", "sundsvall", "gävle", "södertälje", "solna", "kista", "karlstad", "växjö", "halmstad",
  "borås", "boras", "eskilstuna", "sollentuna", "nacka", "botkyrka", "kalmar", "skövde", "trollhättan", "östersund",
];

/** Sant om uppdraget är i Sverige, eller om platsen är okänd. */
export function isSwedish(a: Pick<Assignment, "country" | "location">): boolean {
  const country = a.country?.trim().toLowerCase();
  if (country) return ["se", "swe", "sweden", "sverige"].includes(country);
  const loc = a.location?.toLowerCase();
  if (!loc) return true;
  return SWEDISH_PLACES.some((p) => loc.includes(p));
}

