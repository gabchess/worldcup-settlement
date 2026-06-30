# C13 Demo Shot Script
## TxODDS x Solana World Cup Hackathon -- Track 2 Submission Video
### Canada vs South Africa | kickoff 16:00 BRT / 19:00 UTC | Solo one-take recording

**Hard cap:** 5:00 | **Scene count:** 6 | **Cut recommendation:** 3 clean cuts (see below)
**Recording:** Canada vs South Africa, Round of 32, live in-running data

---

## Pre-Record Checklist

Open and position these windows BEFORE starting the screen recorder. Arrange them so you can switch without hunting.

- [ ] Terminal 1 (full screen or large pane): agent running in live mode -- `USE_LIVE=1 npx ts-node loop.ts` -- from `/Users/gava/projects/worldcup-settlement/agent/`
- [ ] Browser tab A: Solana Explorer devnet, loaded with the C12b tx already Finalized: `https://explorer.solana.com/tx/3YznzQ4S3RNZudfDLt2f6BDe7NvA3tSCharWtKkDrjiieWcB1cy8gbERFzdDyvfsgXfGbc6KdUoLCRTNnouN5dxL?cluster=devnet`
- [ ] Browser tab B: dashboard `https://dashboard-three-kappa-83.vercel.app` -- pre-loaded, but do NOT show until after the live bet fires + snapshot refresh
- [ ] Browser tab C: Solana Explorer devnet home (blank search ready for tonight's tx sig)
- [ ] Terminal 2 (background, minimized): snapshot refresh command ready to paste -- `cd /Users/gava/projects/worldcup-settlement && node scripts/refresh-dashboard.js` (or `npm run refresh-dashboard`)
- [ ] Font size: bump terminal font to 20px+ so output is readable at 1080p
- [ ] Screen recorder: 1080p, capture entire screen or the active window set. Start recording BEFORE hitting play on scene 1.

---

## Camera-Day Runbook (Jun 29) -- READ FIRST

Four hard-won gotchas from today's (Jun 28) live rehearsal. Read these before touching the keyboard.

---

### Gotcha 1 -- Subscribe is single-use; fire it immediately before the loop

The TxLINE activate is single-use per subscribe transaction signature. Any authenticated read between `subscribe-fresh.ts` and the loop burns that subscription and the loop will 403.

**Rule:** run subscribe, then start the loop. Nothing authenticated in between. No live-capture checks, no explorer lookups, no npm scripts that hit the API.

```bash
# FROM client/
npx ts-node --project tsconfig.json subscribe-fresh.ts
# Then IMMEDIATELY, from agent/:
USE_LIVE=1 npx ts-node loop.ts
```

---

### Gotcha 2 -- One position per match per wallet. Never rehearse on the camera-take match.

The position PDA is `[b"position", market, wallet]` with no close instruction. Once the agent bets a match from this wallet, it cannot re-bet that match. The PDA is occupied and the second attempt will fail.

**Rule:** use a different match for the rehearsal than the one you record on camera. Pick an earlier R32 kickoff to rehearse, then pick a later one for the take.

---

### Gotcha 3 -- Dashboard refresh now filters to real bets only

`npm run refresh-dashboard` now writes ONLY on-chain bets with `impl==real` to the dashboard. If you see fewer entries than expected, that is correct behavior -- test/mock bets are filtered out.

After recording the live bet, refresh and redeploy:

```bash
npm run refresh-dashboard
cd dashboard && vercel --prod --yes   # ~30 seconds
```

---

### Gotcha 4 -- Odds scale fix coded but NOT yet validated on a live bet

The Opus narrative now normalizes entry odds to decimal (e.g. 18.6, not 186.0). The fix is coded but tomorrow's first fresh bet is the first live validation.

**Rule:** after the rehearsal bet lands, eyeball the narrative's odds number. It should read something like 18.x or 12.x -- a two-digit decimal. If it prints 186.0 or 120.0, the fix did not apply; flag it before the camera take and do not proceed until you understand why.

---

### Jun 29 Run Sequence

**Step 1 -- Rehearse on an EARLIER match** (different from your camera-take match)

1. Fresh subscribe -> loop on the early match.
2. Bet lands. Confirm Opus narrative quotes a two-digit decimal odds number (Fix B validated).
3. Refresh dashboard. Confirm only real bets appear.
4. This validates the full chain including Fix B. You are clear to record.

**Step 2 -- Record on a LATER, DIFFERENT match** (the one that goes on camera)

1. Fresh subscribe from `client/`: `npx ts-node --project tsconfig.json subscribe-fresh.ts`
2. Immediately start the loop from `agent/`: `USE_LIVE=1 npx ts-node loop.ts`
3. Let it run live on camera. The position PDA for this match is guaranteed clean.
4. After the tx fires: refresh + redeploy dashboard, then record Scene 5.

**Single-match fallback** (if only one R32 match is available that day): skip the rehearsal bet entirely and go straight to camera. The chain is validated except Fix B -- accept that the first fresh bet is on camera, and eyeball the odds number in the Opus trace when it prints. If it looks wrong, use the contingency path (C12b) instead.

**Today's real bet (wallet 3Xqis, SA v Canada)** stands as backup proof and b-roll. Dashboard already shows it. If tomorrow goes sideways, this is the Scene 4/5 fallback.

---

## One-Take vs Cuts Recommendation

**Recommendation: 3 clean cuts.** Do not attempt a true one-take at 5 minutes during a live match -- too many things can go wrong (agent HOLD cycle, explorer load delay, dashboard refresh lag). Three cuts gives you recovery room and makes the video tighter. Cut points:

- **Cut A:** after the hook (0:15) into the terminal setup shot
- **Cut B:** after the tx prints (2:30 area) -- pause recording, refresh the dashboard snapshot, resume
- **Cut C:** optional trim at the end if the settlement / P&L panel section runs long

Each cut is invisible to judges. The continuity of the story is what matters.

---

## THE SHOT SCRIPT

---

### SCENE 1 -- HOOK
**Duration:** 0:00 -- 0:15 (15 seconds)
**Cut point:** Cut A fires immediately after this scene ends.

[section -- bold, direct, no wind-up]

**On screen:** Nothing yet. Black / your desktop. Or a still of the dashboard if you want a visual frame. Do NOT show the terminal yet.

**SPOKEN:**
"I built an AI that bets on live soccer games by itself. [pause] On Solana. [pause] No human pushes the button."

**Delivery note:** Say it like you're telling a friend something that actually surprised you. Three beats, three pauses. The last sentence is the one that lands -- give it space.

---

### SCENE 2 -- LIVE DATA COMING IN
**Duration:** 0:15 -- 1:00 (45 seconds)
**On screen:** Terminal -- agent loop running, TxLINE WebSocket feed printing live match data (scores, odds, clock ticking). Canada vs South Africa in-running.

[section -- confident, show-don't-tell]

**SPOKEN:**
"Right now, a real World Cup match is being played. [short pause] Canada versus South Africa. [pause] The agent is subscribed to TxLINE -- that's the official TxODDS live data feed. It's pulling scores, odds, and the game clock in real time, every few seconds."

[pause]

"You can see the clock ticking right there in the terminal. [emphasis]That's live data.[/emphasis] Not a replay. Not a simulation."

**Delivery note:** Point at the clock readout in the terminal. Let the live output scroll a bit before talking over it. Silence for 2-3 seconds while data prints is fine -- it's the proof.

---

### SCENE 3 -- THE AGENT DECIDES (Model + Opus Trace)
**Duration:** 1:00 -- 2:15 (75 seconds)
**On screen:** Terminal -- model probability output followed by Opus reasoning trace printing. Show the full trace if it's short; scroll to the decision line if it's long.

[section -- building tension, this is the intellectual core]

**SPOKEN:**
"When something happens in the match -- a goal, a red card -- the agent wakes up. [pause] First, a logistic regression model runs. It looks at the score, the game clock, and any cards. It gives a win probability. [short pause] Right now you can see it: P(home wins) is about [say the actual number on screen]."

[pause]

"Then Claude Opus 4.8 reads the same data and writes a plain-English trade case. [short pause] It says whether to bet, hold, or exit -- and [emphasis]why[/emphasis]. That trace is public. Anyone can read it."

[pause]

"The model and the LLM agree. [short pause] The agent has an edge."

**Delivery note:** Read the actual P(home) number from the screen. If Opus prints something interesting in the trace, quote one phrase from it verbatim. Keep it specific -- the specificity is what makes judges believe it's real.

---

### SCENE 4 -- THE TRADE (THE CLIMAX)
**Duration:** 2:15 -- 3:00 (45 seconds)
**On screen:** Terminal -- `open_position` firing, then the Solana tx signature printing. Then switch to Browser tab C (Solana Explorer devnet) and search for the signature -- watch it go Finalized.

[section -- peak moment, let it breathe]

**SPOKEN:**
"The agent sizes the bet using fractional Kelly -- it only bets what the edge actually justifies. [short pause] And then..."

[pause -- let the terminal output speak]

"...it sends the transaction. [pause] On-chain. Right now. [pause] No human pushed the button."

[pause -- let the tx sig sit on screen for 2 seconds]

"That's the transaction signature. [short pause] Let me pull it up on Solana Explorer."

[switch to Explorer, paste sig, show Finalized status]

"[emphasis]Finalized.[/emphasis] [pause] That's a real on-chain position. Devnet, but the program is deployed, the money moved, the proof is there."

**Delivery note:** This is the emotional peak. After "no human pushed the button" -- stop talking for two full seconds. Let the tx sit. The silence IS the proof. Do not rush to the next line.

---

### SCENE 5 -- SETTLEMENT + DASHBOARD
**Duration:** 3:00 -- 4:30 (90 seconds)
**On screen:** First show terminal -- settlement flow or the daily_scores_roots PDA confirmation. Then switch to Browser tab B (dashboard) after snapshot refresh is done.

[section -- resolution, landing the plane]

**SPOKEN:**
"Settlement works the same way. The TxODDS oracle writes a Merkle root to a Solana PDA every day. Our contract reads that root and verifies the match outcome against it. [short pause] No centralized scorekeeper. The proof is on-chain."

[pause]

"Here's the dashboard. Four panels: the last thing the agent did, open positions, live P&L, and the Opus reasoning trace that drove the last bet."

[short pause -- point at or describe each panel]

"That position you just saw open -- it's right there. [short pause] And here's the trace. This is what the LLM actually said before it pulled the trigger."

[pause]

"I also want to show you something from yesterday. [switch to Browser tab A -- C12b tx] This is from Congo DR versus Uzbekistan. Another live match, another autonomous bet. Transaction 3Yznz. Finalized on devnet. [short pause] This has been running for real."

**Delivery note:** Keep the dashboard walkthrough brisk. Two sentences per panel maximum. The C12b backup beat is proof of pattern, not just a one-off. Mention "Congo DR vs Uzbekistan" by name -- it grounds it in reality.

---

### SCENE 6 -- CLOSE + CTA
**Duration:** 4:30 -- 5:00 (30 seconds)
**On screen:** Dashboard still visible, or cut back to the terminal. Optionally: repo URL on screen as a lower-third text overlay.

[section -- direct, warm, one ask]

**SPOKEN:**
"That's the full loop. Live data in. Model and LLM decide. On-chain position out. Settlement verified by Merkle proof against the oracle PDA."

[pause]

"The code is all in the repo. The program is deployed at [say the program ID or show it on screen]. The dashboard is live."

[pause]

"Track 2. Prediction markets and settlement. [short pause] Built solo."

**Delivery note:** Don't oversell. You've already shown the thing working. The close is just the receipt. Say it flat and confident.

---

## Timing Summary

| Scene | Beat | Duration | Running Total |
|-------|------|----------|---------------|
| 1 | Hook | 0:15 | 0:15 |
| 2 | Live data in (TxLINE WebSocket) | 0:45 | 1:00 |
| 3 | Agent decides (model + Opus trace) | 1:15 | 2:15 |
| 4 | The trade (open_position + Explorer) | 0:45 | 3:00 |
| 5 | Settlement + dashboard | 1:30 | 4:30 |
| 6 | Close + CTA | 0:30 | 5:00 |

**Total: 5:00 hard cap. On budget.**

---

## Five Required Beats -- Coverage Check

| Beat | Scene | On-screen proof |
|------|-------|-----------------|
| Live data (TxLINE WebSocket) | Scene 2 | Terminal: clock ticking, scores printing |
| Decide + trace (model + Opus) | Scene 3 | Terminal: P(home) number + full Opus reasoning trace |
| Trade tx (open_position, no human) | Scene 4 | Terminal: tx sig + Solana Explorer Finalized |
| Settlement (Merkle / daily_scores_roots PDA) | Scene 5 | Terminal or README showing PDA path |
| P&L (dashboard) | Scene 5 | Dashboard: open positions + live P&L panel |

All five beats covered.

---

## No-Edge Contingency Path

If the agent finds no tradeable edge during the recording window (it correctly prints HOLD or runs through several HOLD cycles), do NOT try to force a bet. Use this path instead:

**Narration pivot (insert after Scene 3, replace Scene 4 live-bet content):**

"Right now the model says HOLD. The edge isn't there yet. [pause] That's the system working correctly -- it doesn't bet every cycle, it bets when it has a real edge."

[pause]

"But I want to show you what it looks like when it does fire. [switch to Browser tab A -- C12b tx] This is from last night. Congo DR versus Uzbekistan. Live in-running data, same pipeline. The agent found the edge, sized the bet with fractional Kelly, and opened this position on-chain. [short pause] Transaction 3Yznz -- Finalized on devnet. [switch to Explorer -- show Finalized status] That's a real bet. Real transaction. No human involved."

Then continue into Scene 5 (settlement + dashboard) using the C12b position as the visible open position on the dashboard.

**Notes for the contingency path:**
- The C12b bet is already in the dashboard snapshot if you loaded it. It shows open. If it shows settled, that's even better -- point at the P&L.
- The Opus trace for C12b may be visible in the dashboard trace panel. Quote it if it's interesting.
- Total runtime impact: the contingency path is approximately the same length as the live-bet scene. No rewrite needed for other scenes.
- After using the contingency path, mention in the submission notes: "The agent found no edge during the recording window -- this demonstrates the HOLD behavior is working. The C12b transaction is our proof-of-live-bet."

---

## Key Numbers to Have Ready

Write these on a sticky note next to your screen so you can say them without looking lost:

- **Program ID:** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`
- **C12b tx (backup):** `3YznzQ4S3RNZudfDLt2f6BDe7NvA3tSCharWtKkDrjiieWcB1cy8gbERFzdDyvfsgXfGbc6KdUoLCRTNnouN5dxL`
- **Dashboard:** `https://dashboard-three-kappa-83.vercel.app`
- **Match:** C12b = Congo DR vs Uzbekistan | C13 = Canada vs South Africa
- **Model Brier:** 0.158 (vs 0.243 baseline -- "35% better than random") -- only mention if Scene 3 feels thin

---

*Internal planning doc. Narration copy is external-audience (first-person, 8yo simplicity filter applied). ernest_routing: SKIP.*
