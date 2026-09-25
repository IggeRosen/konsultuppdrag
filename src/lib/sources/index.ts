import type { SourceAdapter } from "../types.ts";
import { brainville } from "./brainville.ts";
import { cinode } from "./cinode.ts";

/**
 * Registrerade uppdragsportaler. Lägg till en ny källa genom att skapa en
 * adapter (se brainville.ts) och lägga till den här.
 */
export const SOURCES: SourceAdapter[] = [brainville, cinode];

/** Portaler som planeras men ännu inte är implementerade – visas i UI:t. */
export const PLANNED_SOURCES = ["Magnit", "Ework", "Keyman", "Verama", "Emagine"];
