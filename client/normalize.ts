/**
 * Normalise raw TxLINE snapshots into a MatchState object.
 *
 * DEFERRED fields (home_score, away_score, current_minute, red-card counts)
 * are mapped via the inferred field names from c2-signal-set-lock.md.
 * They will be null until confirmed from a live API call.
 */

import { OddsObject, OddsSnapshot, ScoresSnapshot, MatchState } from "./types";

/**
 * Encode current_minute → match_phase bucket (1–7).
 * Returns null when minute is null (DEFERRED).
 */
export function minuteToPhase(minute: number | null): number | null {
  if (minute === null) return null;
  if (minute <= 15) return 1;
  if (minute <= 30) return 2;
  if (minute <= 45) return 3;
  if (minute <= 60) return 4;
  if (minute <= 75) return 5;
  if (minute <= 90) return 6;
  return 7; // ET / penalties
}

/**
 * Pick the "best" odds object from a snapshot (first InRunning one, or first overall).
 */
export function bestOdds(odds: OddsSnapshot): OddsObject | null {
  if (odds.length === 0) return null;
  return odds.find((o) => o.InRunning) ?? odds[0];
}

export function normalizeMatchState(
  fixtureId: number,
  scores: ScoresSnapshot,
  odds: OddsSnapshot
): MatchState {
  const now = Date.now();
  const oddsObj = bestOdds(odds);

  // DEFERRED: scores fields — null until live API confirms exact field names
  const homeScore =
    typeof scores.home_score === "number" ? scores.home_score : null;
  const awayScore =
    typeof scores.away_score === "number" ? scores.away_score : null;
  const minute =
    typeof scores.current_minute === "number" ? scores.current_minute : null;
  const homeRed =
    typeof scores.home_red_cards === "number" ? scores.home_red_cards : null;
  const awayRed =
    typeof scores.away_red_cards === "number" ? scores.away_red_cards : null;

  return {
    fixtureId,
    timestamp: now,
    isLive: oddsObj?.InRunning ?? false,

    homeScore,
    awayScore,
    scoreDifferential:
      homeScore !== null && awayScore !== null ? homeScore - awayScore : null,

    currentMinute: minute,
    matchPhase: minuteToPhase(minute),

    homeRedCards: homeRed,
    awayRedCards: awayRed,
    redCardDelta:
      homeRed !== null && awayRed !== null ? homeRed - awayRed : null,

    prices: oddsObj?.Prices ?? [],
    pct: oddsObj?.Pct ?? null,

    rawOdds: oddsObj,
    rawScores: scores,
  };
}
