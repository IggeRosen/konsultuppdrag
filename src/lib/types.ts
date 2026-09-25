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
