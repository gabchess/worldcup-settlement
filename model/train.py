"""
C2 match-outcome model (retargeted from goal-in-15 to match winner, C9 gate).
Features: score_differential, match_phase (1-7 bucket), red_card_delta, match_phase^2
Target: P(home wins match) — 1 if home_final_score > away_final_score else 0
Pipeline: LogisticRegression + CalibratedClassifierCV (Platt / sigmoid)
Metric: Brier score on holdout split vs home-win base-rate baseline
Data: StatsBomb Open Data via statsbombpy (World Cup + Euro matches)

Retarget rationale: model↔market↔settlement coherence (C9 gate, Kent+Dayo).
The bet is on the match WINNER; the model must output the same event.
"""

import warnings
import sys
import json

import numpy as np
import pandas as pd
import joblib
from statsbombpy import sb
from sklearn.linear_model import LogisticRegression
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss
from sklearn.model_selection import train_test_split

warnings.filterwarnings("ignore")

MODEL_PATH = "model.joblib"
# Bump matches to get sufficient home-win label density (~45% WC base rate)
TARGET_COMPETITIONS = {43, 55}
MAX_MATCHES = 60  # ~60 matches × 90 rows = 5400 rows


def phase_bucket(minute: int) -> int:
    """Map match minute to ordinal bucket 1-7 per C2 spec."""
    if minute <= 15:
        return 1
    elif minute <= 30:
        return 2
    elif minute <= 45:
        return 3
    elif minute <= 60:
        return 4
    elif minute <= 75:
        return 5
    elif minute <= 90:
        return 6
    else:
        return 7


def build_rows_for_match(
    match_id: int,
    home_team: str | None,
    away_team: str | None,
    home_final: int,
    away_final: int,
) -> list[dict]:
    """
    Pull StatsBomb events for one match, build one row per minute with
    (score_differential, match_phase, red_card_delta, match_phase_sq, label).
    label = 1 if home_final > away_final (home wins the match) else 0.
    The label is constant per match — it's the final outcome applied to every
    minute-snapshot, so the model learns: "given this in-game state at minute T,
    what is P(home wins)?"
    """
    try:
        events = sb.events(match_id=match_id)
    except Exception:
        return []

    if events is None or events.empty:
        return []

    # Goal events (shot with goal outcome, or type == 'Goal')
    goals = pd.DataFrame()
    if "shot_outcome" in events.columns:
        goals = events[
            events["type"].str.lower().str.contains("shot", na=False)
            & events["shot_outcome"].str.lower().str.contains("goal", na=False)
        ].copy()
    if goals.empty and "type" in events.columns:
        goals = events[events["type"].str.lower() == "goal"].copy()

    # Red card events
    if "bad_behaviour_card" in events.columns:
        red_events = events[
            events["bad_behaviour_card"].str.lower().str.contains("red", na=False)
        ].copy()
    elif "foul_committed_card" in events.columns:
        red_events = events[
            events["foul_committed_card"].str.lower().str.contains("red", na=False)
        ].copy()
    else:
        red_events = pd.DataFrame()

    # Resolve teams from metadata; fall back to event order
    if home_team is None or away_team is None:
        teams = events["team"].unique().tolist() if "team" in events.columns else []
        if len(teams) < 2:
            return []
        home_team, away_team = teams[0], teams[1]

    # Match-level label: constant for all rows in this match
    label = int(home_final > away_final)

    rows = []
    for minute in range(1, 91):
        # In-game score at start of this minute
        goals_before = goals[goals["minute"] < minute] if not goals.empty else pd.DataFrame()
        home_goals = len(goals_before[goals_before["team"] == home_team]) if not goals_before.empty else 0
        away_goals = len(goals_before[goals_before["team"] == away_team]) if not goals_before.empty else 0
        score_diff = home_goals - away_goals

        # Red cards accumulated at start of this minute
        if not red_events.empty and "minute" in red_events.columns:
            reds_before = red_events[red_events["minute"] < minute]
            home_reds = len(reds_before[reds_before["team"] == home_team]) if not reds_before.empty else 0
            away_reds = len(reds_before[reds_before["team"] == away_team]) if not reds_before.empty else 0
            red_delta = home_reds - away_reds
        else:
            red_delta = 0

        phase = phase_bucket(minute)
        phase_sq = phase ** 2

        rows.append({
            "score_differential": score_diff,
            "match_phase": phase,
            "red_card_delta": red_delta,
            "match_phase_sq": phase_sq,
            "label": label,
        })
    return rows


def pull_data(max_matches: int = MAX_MATCHES) -> pd.DataFrame:
    """Pull StatsBomb open data and build feature matrix."""
    print("Fetching StatsBomb competition list...", flush=True)
    try:
        comps = sb.competitions()
    except Exception as e:
        print(f"statsbombpy error: {e}", flush=True)
        return pd.DataFrame()

    target = comps[comps["competition_id"].isin(TARGET_COMPETITIONS)]
    if target.empty:
        print("No target competitions found, using all available.", flush=True)
        target = comps

    all_rows = []
    matches_pulled = 0

    for _, comp_row in target.iterrows():
        if matches_pulled >= max_matches:
            break
        comp_id = comp_row["competition_id"]
        season_id = comp_row["season_id"]
        try:
            matches = sb.matches(competition_id=comp_id, season_id=season_id)
        except Exception:
            continue
        if matches is None or matches.empty:
            continue

        for _, match_row in matches.iterrows():
            if matches_pulled >= max_matches:
                break
            match_id = match_row["match_id"]
            home = match_row.get("home_team")
            away = match_row.get("away_team")
            # Final scores from match metadata (StatsBomb carries these)
            home_final = int(match_row.get("home_score", 0) or 0)
            away_final = int(match_row.get("away_score", 0) or 0)
            rows = build_rows_for_match(match_id, home, away, home_final, away_final)
            if rows:
                all_rows.extend(rows)
                matches_pulled += 1
                print(
                    f"  match {matches_pulled}/{max_matches} (id={match_id}): "
                    f"{len(rows)} rows | final {home_final}-{away_final}",
                    flush=True,
                )

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    home_win_rate = df["label"].mean()
    print(
        f"Total rows: {len(df)}, home-win rate: {home_win_rate:.3f}",
        flush=True,
    )
    return df


def fit_and_save(df: pd.DataFrame) -> dict:
    """Fit calibrated logistic regression, save model, return metrics."""
    feature_cols = ["score_differential", "match_phase", "red_card_delta", "match_phase_sq"]
    X = df[feature_cols].values
    y = df["label"].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    # ponytail: CalibratedClassifierCV wraps LR directly — no separate Platt step needed
    base = LogisticRegression(C=1.0, max_iter=500, random_state=42)
    model = CalibratedClassifierCV(base, method="sigmoid", cv=3)
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]
    brier = brier_score_loss(y_test, proba)
    base_rate = float(y_train.mean())
    brier_baseline = brier_score_loss(y_test, np.full_like(proba, base_rate))

    joblib.dump(model, MODEL_PATH)

    # Directional sanity checks
    feature_cols_list = feature_cols
    def _p(score_diff: int, phase: int, red_delta: int = 0) -> float:
        X_s = np.array([[score_diff, phase, red_delta, phase ** 2]])
        return float(model.predict_proba(X_s)[0, 1])

    leading_late = _p(2, 6)   # home leads by 2 at phase 6 (76-90 min)
    trailing_late = _p(-2, 6)  # home trails by 2 at phase 6

    return {
        "target": "P(home wins match)",
        "brier_score": brier,
        "brier_baseline": brier_baseline,
        "base_rate": base_rate,
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "matches": len(df) // 90,
        "dataset": "StatsBomb Open Data (World Cup + Euro)",
        "directional_sanity": {
            "leading_late_phase6_diff+2": leading_late,
            "trailing_late_phase6_diff-2": trailing_late,
            "directional_ok": bool(leading_late > 0.7 and trailing_late < 0.3),
        },
    }


def export_model_json(model, path: str = "model.json") -> None:
    """
    Export calibrated LR parameters to JSON for the TS bridge.
    Schema: feature_order, composition note, folds[{lr_coef, lr_intercept, platt_a, platt_b}].
    """
    folds = []
    for cal in model.calibrated_classifiers_:
        # sklearn >= 1.2: cal.estimator; older: cal.base_estimator
        lr = getattr(cal, "estimator", getattr(cal, "base_estimator", None))
        platt = cal.calibrators[0]  # sigmoid calibrator
        folds.append({
            "lr_coef": lr.coef_[0].tolist(),
            "lr_intercept": float(lr.intercept_[0]),
            "platt_a": float(platt.a_),
            "platt_b": float(platt.b_),
        })

    payload = {
        "feature_order": ["score_differential", "match_phase", "red_card_delta", "match_phase_sq"],
        "target": "P(home wins match)",
        "composition": (
            "mean of per-fold calibrated probabilities; "
            "fold_p = sigmoid(a * (X @ coef + intercept) + b); "
            "sigmoid(z) = 1 / (1 + exp(z))"
        ),
        "positive_class_index": 1,
        "folds": folds,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"Exported model.json ({len(folds)} folds).", flush=True)


if __name__ == "__main__":
    df = pull_data()
    if df.empty:
        print("ERROR: no data pulled from StatsBomb", file=sys.stderr)
        sys.exit(1)
    metrics = fit_and_save(df)
    # Load just-saved model to export JSON
    model = joblib.load(MODEL_PATH)
    export_model_json(model, "model.json")
    # Save metrics
    with open("metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)
    print(json.dumps(metrics, indent=2))
