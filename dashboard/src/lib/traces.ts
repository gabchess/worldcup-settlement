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

// Mark-to-model P&L per position: stake * (decimalOdds * modelProbability - 1)
// TxLINE Prices are integer-scaled ×1000 (e.g. 14700 → 14.7 decimal odds).
// Detected by value >= 100; real decimal odds are always < 100.
// ponytail: threshold heuristic, upgrade to explicit unit field when agent emits one; ceiling: pre-mainnet
function toDecimalOdds(raw: number): number {
  return raw >= 100 ? raw / 1000 : raw;
}

function pnlEstimate(t: Trace): number {
  if (!t.position.entryOdds || t.position.stake === 0) return 0;
  const decimalOdds = toDecimalOdds(t.position.entryOdds);
  return t.position.stake * (decimalOdds * t.modelProbability - 1);
}

export const positionsWithPnl = openPositions.map((t) => ({
  ...t,
  pnl: pnlEstimate(t),
}));

export const totalPnl: number = positionsWithPnl.reduce(
  (sum, t) => sum + t.pnl,
  0
);
