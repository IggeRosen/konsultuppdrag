import type { SourceAdapter } from "../types.ts";
import { brainville } from "./brainville.ts";
import { cinode } from "./cinode.ts";
import { ework } from "./ework.ts";

/**
 * Registrerade uppdragsportaler. Lägg till en ny källa genom att skapa en
 * adapter (se brainville.ts) och lägga till den här.
 */
export const SOURCES: SourceAdapter[] = [brainville, cinode, ework];

/** Portaler som planeras men ännu inte är implementerade – visas i UI:t. */
export const PLANNED_SOURCES = ["Magnit", "Keyman", "Emagine"];
