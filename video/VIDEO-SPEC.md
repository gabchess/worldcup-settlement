# World Cup TxODDS — Demo Video Build Spec (Remotion)

Track 2 hackathon demo. 1920×1080, 30fps, ~203.6s (3:24). Editorial style matches the dashboard (AR-607 design bar) — the graphic cards reuse the dashboard's tokens so the whole film looks like one product.

## Output
- Remotion project: `~/projects/worldcup-settlement/video/` (this dir).
- Final render: `~/Desktop/worldcup-c13-2026-06-29/c13-demo-final.mp4` (H.264, 1080p, with audio).

## Assets (absolute paths)
Clips (`~/Desktop/worldcup-c13-2026-06-29/`):
- `c13-raw-live-bet-brazil-japan.mp4` — 44.4s — the agent terminal placing the live bet.
- `c13-explorer-finalized.mp4` — 11.2s — Solana Explorer, finalized tx.
- `c13-dashboard-txodds.mp4` — 11.7s — the new dashboard screen recording.

VO segments (`~/Desktop/worldcup-c13-2026-06-29/vo-segments/`), each is one Remotion `<Sequence>`'s audio:
- `s1-hook.mp3` 6.59s · `s2-terminal.mp3` 99.10s · `s3-explorer.mp3` 12.91s · `s4-dashboard.mp3` 63.11s · `s5-close.mp3` 21.87s.

Copy assets into `public/` (Remotion serves from there): `public/clips/*.mp4`, `public/vo/*.mp3`.

## Editorial design tokens (from dashboard DESIGN.md — use verbatim on all cards)
```
--parchment: #f0ebe3   (card/scene bg)
--ivory:     #faf7f0   (inner panels)
--ink:       #2c2926   (primary text, numbers)
--ink-prose: #57564f   (body prose)
--ink-muted: #87867f   (labels)
--border:    #e0dacf   (hairlines)
--terracotta:#c96442   (the ONE accent — primary stat only)
--sage:      #5a7260   (positive/edge)
--ochre:     #c4a574   (ornament: diamond ◆, left-border)
```
Fonts via `@remotion/google-fonts`: **Cinzel** (loadFont) for card H1 only; **Geist** for everything incl. numbers (weight 600, `font-variant-numeric: tabular-nums`, letter-spacing -0.02em); **Geist Mono** for the program ID / tx hash. Same rule as the dashboard: Cinzel never touches a digit.

## Timeline (5 sequences, frame = sec × 30)
| # | Seq | start–end (s) | dur (s) | Visual |
|---|-----|---------------|---------|--------|
| 1 | Hook card | 0–6.59 | 6.59 | Parchment. Cinzel "World Cup TxODDS" (terracotta-on-parchment OK at display size), subtitle Geist "An AI that bets on live soccer. On Solana. Autonomously." + small ochre `◆` + a "TRACK 2" pill. Gentle fade-in (opacity interpolate 0→1 over 12 frames). |
| 2 | Terminal + cards | 6.59–105.69 | 99.10 | **0–~46s:** `c13-raw-live-bet` clip via `<OffthreadVideo>` (full-bleed, object-fit contain on parchment letterbox). **~46–99s:** three editorial graphic cards (below), distributed across the remaining ~53s (~17–18s each), cross-fading. |
| 3 | Explorer | 105.69–118.60 | 12.91 | `c13-explorer-finalized` clip (11.2s) then hold last frame ~1.7s. |
| 4 | Dashboard | 118.60–181.71 | 63.11 | `c13-dashboard-txodds` clip (11.7s) at start, then a slow **Ken-Burns** on the dashboard for ~51s: use the clip's last frame OR a static screenshot (`public/clips/dashboard-still.png` — extract with ffmpeg) and `interpolate` scale 1.0→1.12 + translateY 0→-6% across the hold, easing. Optional: at the "and there is the trace" beat (~last 20s), pan toward the lower reasoning-trace region. |
| 5 | Close card | 181.71–203.58 | 21.87 | Parchment. Cinzel "The full loop." Four Geist lines: "Live data in. Model + LLM decide. On-chain out. Settlement by Merkle proof." Then Geist Mono program ID `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp` in an ivory pill, and "Track 2 · Prediction markets & settlement · Built solo." Slow fade-out last 15 frames. |

### Segment-2 graphic cards (editorial, reuse dashboard hero-card style: white card, 1px border, 16px radius, layered shadow)
- **Card A — MODEL vs MARKET** (~46–63s): label "MODEL EDGE". Two rows: "Model — Brazil 41.9%" (ink) / "Market — 36.8%" (ink-muted). Big terracotta number: "+5.1 pp" with label "edge". Diamond `◆` divider.
- **Card B — CLAUDE OPUS TRADE CASE** (~63–82s): label "REASONING". Geist Mono block (ochre left-border, like the dashboard's `.trace-assessment`): "fair odds at 41.9% → ~2.39 · line at 2.72 · +13.9% edge". Verdict chip "BET" in sage.
- **Card C — SIZE & SEND** (~82–99s): label "EXECUTION". "Fractional Kelly sizing" + a terracotta "TX SENT" + "on-chain · no human" sage pill. Optionally a faint pulse on a sage dot (like the dashboard LIVE badge).

(Exact sub-timings are approximate — distribute evenly; main-thread will refine after first render.)

## Remotion implementation notes
- `<Composition id="demo" durationInFrames={6108} fps={30} width={1920} height={1080} />` (6108 = round(203.6×30)).
- Each segment: `<Sequence from={startFrame} durationInFrames={segFrames}>` containing `<Audio src={staticFile('vo/sX.mp3')} />` + visual.
- Clips: `<OffthreadVideo src={staticFile('clips/...')} />`. If a clip is shorter than its sequence, freeze: render the video for its real length, then an `<Img>` of the last frame for the remainder (extract stills with ffmpeg into `public/clips/`).
- Ken-Burns / fades: `interpolate(frame, [...], [...], {extrapolateLeft:'clamp', extrapolateRight:'clamp'})`; `spring` for card entrances.
- Letterbox clips on parchment (don't stretch); 16:9 clips should fit 1920×1080 cleanly.

## Verifier (run before returning — paste output)
1. `cd ~/projects/worldcup-settlement/video && npx remotion render demo ~/Desktop/worldcup-c13-2026-06-29/c13-demo-final.mp4` → MUST exit 0.
2. `ffprobe` the output: duration 200–207s, 1920×1080, has BOTH a video and an audio stream. Paste the ffprobe summary.
3. Confirm `public/` has all 3 clips + 5 vo mp3s.
Return MARTA_REPORT: render exit code, ffprobe summary (duration/resolution/streams), output path, any timing approximations used.
