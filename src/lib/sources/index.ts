import type { SourceAdapter } from "../types.ts";
import { brainville } from "./brainville.ts";

/**
 * Registrerade uppdragsportaler. Lägg till en ny källa genom att skapa en
 * adapter (se brainville.ts) och lägga till den här.
 */
export const SOURCES: SourceAdapter[] = [brainville];

/** Portaler som planeras men ännu inte är implementerade – visas i UI:t. */
export const PLANNED_SOURCES = ["Cinode", "Magnit", "Ework", "Keyman", "Verama", "Emagine"];
