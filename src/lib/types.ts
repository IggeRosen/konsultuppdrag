export interface Assignment {
  /** Unikt id, prefixat med källan, t.ex. "brainville:330877" */
  id: string;
  source: string;
  title: string;
  url: string;
  company?: string;
  location?: string;
  published?: string;
  deadline?: string;
  start?: string;
  /** Slutdatum för uppdraget */
  end?: string;
  /** Pris, t.ex. "676 kr/tim" */
  rate?: string;
  /** Arbetsform, t.ex. "Hybrid · 50 % distans" eller "På plats" */
  workMode?: string;
  /** Start i klartext, t.ex. "Omgående" eller "Om 2 månader" */
  startText?: string;
  /** Uppdragslängd, t.ex. "12 månader" */
  duration?: string;
  /** Omfattning, t.ex. "40 tim/vecka" */
  extent?: string;
  description?: string;
}

export interface SourceStatus {
  source: string;
  ok: boolean;
  count: number;
  strategies: string[];
  error?: string;
  fetchedAt: string;
}

export interface SourceAdapter {
  name: string;
  homepage: string;
  fetchAssignments(): Promise<{ assignments: Assignment[]; strategies: string[] }>;
}

export interface MatchedAssignment extends Assignment {
  score: number;
  matched: string[];
}
