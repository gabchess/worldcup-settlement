/**
 * C8 agent types: trigger events, LLM assessor interface, trace records.
 */

// Re-export MatchState from client so downstream consumers have one import.
// ponytail: copy the type inline rather than a cross-package import; the
// project isn't using workspaces so a relative path is cleanest here.
export interface MatchState {
  fixtureId: number;
  timestamp: number;
  isLive: boolean;
  homeScore: number | null;
  awayScore: number | null;
  scoreDifferential: number | null;
  currentMinute: number | null;
  matchPhase: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  redCardDelta: number | null;
  prices: number[];
  pct: number | null;
}

// ---------------------------------------------------------------------------
// Trigger detector
// ---------------------------------------------------------------------------

export type TriggerType = "goal" | "red_card" | "edge";

export interface TriggerEvent {
  type: TriggerType;
  fixtureId: number;
  fromState: MatchState;
  toState: MatchState;
  /** Present only when type="edge": model-vs-market probability gap. */
  edge?: number;
}

// ---------------------------------------------------------------------------
// LLM assessor interface
// ---------------------------------------------------------------------------

export type SuggestedAction = "hold" | "increase" | "decrease" | "exit";

export interface AssessmentResult {
  assessment: string;
  suggestedAction: SuggestedAction;
  reasoningTrace: string;
}

/** Current position passed in by the caller (C9 will wire this properly). */
export interface PositionContext {
  side: "home" | "away" | "draw" | "none";
  stake: number; // notional units
  entryOdds: number | null;
}

/** LLMAssessor — swap real/stub without changing callers. */
export interface LLMAssessor {
  assess(
    event: TriggerEvent,
    modelProbability: number,
    position: PositionContext
  ): Promise<AssessmentResult>;
}

// ---------------------------------------------------------------------------
// Trace log record  (one entry per reasoning trace in traces.jsonl)
// ---------------------------------------------------------------------------

export interface TraceRecord {
  timestamp: string; // ISO 8601
  fixtureId: number;
  eventType: TriggerType;
  modelProbability: number;
  position: PositionContext;
  assessment: string;
  suggestedAction: SuggestedAction;
  reasoningTrace: string;
  impl: "real" | "stub";
}
