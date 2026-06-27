/**
 * C8 trigger detector.
 *
 * Compares consecutive MatchState snapshots and emits a TriggerEvent only on
 * material changes:
 *   - goal:     scoreDifferential changes between ticks
 *   - red_card: redCardDelta changes between ticks
 *
 * Fires SPARINGLY — skips null fields (DEFERRED scores) and non-live states.
 */

import { MatchState, TriggerEvent } from "./types";

/**
 * Compare prev and next; return a TriggerEvent if material event occurred,
 * or null if nothing changed.
 *
 * Only checks scoreDifferential for goals (catches both home and away goals
 * with a single comparison) and redCardDelta for cards.
 */
export function detectTrigger(
  prev: MatchState,
  next: MatchState,
): TriggerEvent | null {
  // Only fire for live matches (InRunning=true).
  // Pre-match score changes are noise.
  if (!next.isLive) return null;

  // Score check — null means DEFERRED (live API not yet confirmed), skip.
  if (
    prev.scoreDifferential !== null &&
    next.scoreDifferential !== null &&
    prev.scoreDifferential !== next.scoreDifferential
  ) {
    return {
      type: "goal",
      fixtureId: next.fixtureId,
      fromState: prev,
      toState: next,
    };
  }

  // Red card check
  if (
    prev.redCardDelta !== null &&
    next.redCardDelta !== null &&
    prev.redCardDelta !== next.redCardDelta
  ) {
    return {
      type: "red_card",
      fixtureId: next.fixtureId,
      fromState: prev,
      toState: next,
    };
  }

  return null;
}
