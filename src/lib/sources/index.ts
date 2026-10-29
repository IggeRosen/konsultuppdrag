import type { SourceAdapter } from "../types.ts";
import { brainville } from "./brainville.ts";
import { cinode } from "./cinode.ts";
import { ework } from "./ework.ts";
import { keyman } from "./keyman.ts";
import { magnit } from "./magnit.ts";
import { emagine } from "./emagine.ts";
import { itjobb } from "./itjobb.ts";
import { kvadrat } from "./kvadrat.ts";
import { adadigital } from "./adadigital.ts";
import { nexer } from "./nexer.ts";
import { wise } from "./wise.ts";
import { experis } from "./experis.ts";

/**
 * Registrerade uppdragsportaler. Lägg till en ny källa genom att skapa en
 * adapter (se brainville.ts) och lägga till den här.
 */
export const SOURCES: SourceAdapter[] = [brainville, cinode, ework, keyman, magnit, emagine, itjobb, kvadrat, adadigital, nexer, wise, experis];

/** Portaler som planeras men ännu inte är implementerade – visas i UI:t. */
export const PLANNED_SOURCES: string[] = [];
