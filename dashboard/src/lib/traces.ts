import rawTraces from "../../data/traces.json";

export interface Position {
  side: string;
  stake: number;
  entryOdds: number | null;
}

export interface Trace {
  timestamp: string;
  fixtureId: number;
  eventType: string;
  modelProbability: number;
  position: Position;
  assessment: string;
  suggestedAction: string;
  reasoningTrace: string;
  impl: string;
}

const traces: Trace[] = rawTraces as Trace[];

// Sort descending by timestamp (most recent first)
const sorted = [...traces].sort(
  (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
);

// Single export: most recent trace overall (used for lastAction AND latestTrace)
export const latestTrace: Trace = sorted[0];

// Dedup to one entry per fixtureId, keeping the most-recent trace for that fixture.
// ponytail: O(n) Map dedup; upgrade to server-side aggregation when traces exceed thousands; ceiling: pre-mainnet snapshot
const dedupedByFixture = new Map<number, Trace>();
for (const t of sorted) {
  // sorted is most-recent-first, so first occurrence wins (= most recent)
  if (!dedupedByFixture.has(t.fixtureId)) {
    dedupedByFixture.set(t.fixtureId, t);
  }
}

// Open positions: stake > 0 and side is not "none", one row per fixtureId
export const openPositions: Trace[] = Array.from(
  dedupedByFixture.values()
).filter((t) => t.position.stake > 0 && t.position.side !== "none");

// Mark-to-model P&L per position: stake * (entryOdds * modelProbability - 1)
// ponytail: expected-value mark only; upgrade when agent emits realized settled P&L; ceiling: pre-mainnet
function pnlEstimate(t: Trace): number {
  if (!t.position.entryOdds || t.position.stake === 0) return 0;
  return t.position.stake * (t.position.entryOdds * t.modelProbability - 1);
}

export const positionsWithPnl = openPositions.map((t) => ({
  ...t,
  pnl: pnlEstimate(t),
}));

export const totalPnl: number = positionsWithPnl.reduce(
  (sum, t) => sum + t.pnl,
  0
);
