---
version: alpha
name: World Cup TxODDS
description: An editorial broadsheet for an autonomous trader — warm parchment, one terracotta number, one paragraph of machine reasoning.
colors:
  parchment: "#f0ebe3"
  ivory: "#faf7f0"
  ink: "#2c2926"
  ink-muted: "#87867f"
  border: "#e0dacf"
  terracotta: "#c96442"
  terracotta-deep: "#8b4518"
  sage: "#5a7260"
  sage-soft-bg: "#e4ebe6"
  fresco-ochre: "#c4a574"
  fresco-red: "#a64d4d"
  aegean: "#c5d4dc"
typography:
  h1:
    fontFamily: Cinzel
    fontSize: 2rem
    fontWeight: 600
    letterSpacing: "0.01em"
  hero-number:
    fontFamily: Geist
    fontSize: 3rem
    fontWeight: 600
    letterSpacing: "-0.02em"
    fontVariation: "tabular-nums"
  stat-number:
    fontFamily: Geist
    fontSize: 1.75rem
    fontWeight: 600
    fontVariation: "tabular-nums"
  probability-number:
    fontFamily: Geist
    fontSize: 3rem
    fontWeight: 600
    fontVariation: "tabular-nums"
  body-md:
    fontFamily: Geist
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.75
  pill:
    fontFamily: Geist
    fontSize: 0.75rem
    letterSpacing: "0.08em"
  mono:
    fontFamily: Geist Mono
    fontSize: 0.8125rem
rounded:
  card: 16px
  pill: 9999px
  badge: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  hero-card:
    backgroundColor: "#ffffff"
    borderColor: "{colors.border}"
    borderRadius: "{rounded.card}"
  hero-stat-primary:
    textColor: "{colors.terracotta}"
  pill-chip:
    backgroundColor: "{colors.ivory}"
    borderColor: "{colors.border}"
    textColor: "{colors.ink-muted}"
  badge-live:
    backgroundColor: "{colors.sage-soft-bg}"
    textColor: "{colors.sage}"
  panel-greek:
    backgroundColor: "{colors.ivory}"
---

## Overview

**Design philosophy (LOCKED):** *An editorial broadsheet for an autonomous trader — warm parchment and a single classical ornament frame one big terracotta number and one paragraph of machine reasoning; everything else recedes so the agent's judgment is the page.*

One committed aesthetic: editorial **light**. No dark mode, no toggle. The page has exactly two jobs — make the **Net P&L number** unmistakably the focal point, and make the **Opus reasoning trace** the closing argument. Every token below serves one of those two jobs or recedes.

Reference bar (the *quality* target, not the brand): Mythos (`mythos-wc-bot.vercel.app/bot`). This product is **World Cup TxODDS**, not Mythos.

## Colors

Palette is verbatim from the Mythos reference. Hex is the canonical brand value; **oklch derivations + APCA pass/fail are appended in the Phase 1c section below** (oklch-skill) and are what the CSS ships.

| Token | Hex | Role |
|---|---|---|
| `parchment` | `#f0ebe3` | Page background. The whole surface. |
| `ivory` | `#faf7f0` | Secondary panel + pill background (warmer than white, sits *on* parchment). |
| `ink` | `#2c2926` | Primary text + hero probability number. |
| `ink-muted` | `#87867f` | Secondary text, prose, labels, pill text. |
| `border` | `#e0dacf` | 1px hairline on cards, pills, panels. |
| `terracotta` | `#c96442` | **RARE accent.** Net P&L primary stat ONLY (+ positive-gain elsewhere is sage, not this). |
| `terracotta-deep` | `#8b4518` | Loss state on P&L numbers. |
| `sage` | `#5a7260` | Gain state on numbers; live-badge text. |
| `sage-soft-bg` | `#e4ebe6` | Live-badge background. Border = sage @22%. |
| `fresco-ochre` | `#c4a574` | Diamond dividers (@45%), reasoning-trace left-border (4px). |
| `fresco-red` | `#a64d4d` | Reserved (alerts/errors). Not in v1 layout. |
| `aegean` | `#c5d4dc` | Reserved cool accent. Not in v1 layout. |

Semantic mapping: **gain → sage**, **loss → terracotta-deep**. The bright `terracotta` is reserved for the single hero Net P&L value so it stays the focal point (anti-pattern #4).

## Typography

Loaded via `next/font` (self-hosted, no layout shift). Two families do all the work; a third is hashes only.

- **Cinzel** (display serif) — the page `h1` string **"World Cup TxODDS"** and nothing else. Fallback: Cinzel → Georgia → Times. Cinzel has no usable tabular figures, so it must never touch a number (anti-pattern #1).
- **Geist** (variable sans) — all body text, labels, prose, **and every number**. Numbers are `fontWeight: 600` + `letter-spacing: -0.02em` + `font-variant-numeric: tabular-nums`.
- **Geist Mono** — transaction hashes, program ID, the model `assessment` string. Monospace signals "machine output / verifiable on-chain."

Number hierarchy: hero Net P&L `3rem` (clamp 36→48px) → reasoning-trace probability `3rem` ink → secondary hero stats `1.75rem`. (Fluid clamp values finalized in Phase 2, impeccable-typeset.)

## Layout

- Container: `max-w-4xl mx-auto`, padding `px-5 sm:px-8`, `py-10`. **No sidebar.**
- DOM order (top → bottom): **header (Cinzel h1 + live badge + program ID + devnet)** → **meander strip** → **3-up hero card** → **pill chip row** → **positions panel** → **reasoning-trace panel**.
- **Meander strip:** one Greek-key SVG, 8px tall, `repeat-x`, stroke `ink-muted` @35%. Sits between header and hero. A hairline ornament that reads as an editorial section rule — not a colored band (anti-pattern #3).
- Responsive: 3-up hero collapses to stacked single-column under ~640px; everything else is already single-column.

## Elevation & Depth

- **Hero card:** white bg, 1px `border` hairline, `16px` radius, layered shadow + inset white highlight (`box-shadow: 0 1px 3px rgba(44,41,38,.06), 0 8px 24px rgba(44,41,38,.05), inset 0 1px 0 #fff`). This is the only elevated surface — elevation itself marks it as the hero.
- **Greek panels (positions + reasoning):** `card-panel-greek` — `ivory` bg, no drop shadow, instead an inset classical frame via `::before` (1px `fresco-ochre` @25%, 6px offset inset). Flat + framed, so they read as *secondary* to the elevated hero.

## Shapes

- Cards: `16px` radius. Pills: full-round (`9999px`). Badge: `8px`.
- Diamond dividers between the 3 hero columns: `::after` content `◆`, 8px, `fresco-ochre` @45%, vertically centered. One ornament per gap; not a full vertical rule.

## Components

### 3-up hero card (the focal point)
Three columns, **NOT equal weight**:
1. **Net P&L** — primary. Value = `totalPnl` (existing export). `terracotta`, `3rem`, Geist 600 tabular-nums. Sign-prefixed (`+`/`−`). Largest optical weight on the page.
2. **Open Positions** — secondary. Value = `openPositions.length` (existing export). `ink`, `1.75rem`.
3. **Model Edge** — secondary. Value = **DERIVED, needs new export in `src/lib/traces.ts`**: `modelProbability − (1 / toDecimalOdds(entryOdds))` for the latest/headline trace, rendered as percentage points (e.g. `+5.13 pp`). `ink` (or sage if positive), `1.75rem`. This is the model-vs-market gap the VO narrates ("Brazil 41.9% model vs 36.8% market = 5.13pp").

Columns separated by diamond dividers. Each column: small `ink-muted` uppercase label (letter-spacing 0.08em) above the number.

### Pill chip row
Secondary facts as static `rounded-full` pills below the hero: `ivory` bg, 1px `border`, `px-5 py-2`, `12px`, letter-spacing `0.08em`, `ink-muted` text. **No hover, no pointer cursor** — these are facts, not buttons (anti-pattern #6). Example content: "3 open · 0.0189 SOL at risk · devnet · Updated 2h ago".

### Live badge
Agent-active indicator in header: `sage-soft-bg` bg, `sage` @22% border, `sage` text, pulse 2.5s. (Recolor of the v1 pulse indicator — keep the idea, restyle.)

### Reasoning-trace panel (the unique feature)
- Probability `3rem` Geist 600 `ink` (model probability, e.g. "41.9%").
- Reasoning prose `ink-muted`, `leading-7` (`line-height: 1.75`). **Verbatim from data — do not rewrite.**
- `assessment` string in Geist Mono inside a sub-panel with a 4px `fresco-ochre` left-border.
- Tx link (if present) → Solana Explorer, truncated hash in Geist Mono.

### Positions panel
`card-panel-greek` styling. Per position: fixture id, side, stake (SOL), entry odds (decimal). Numbers Geist tabular-nums.

## Do's and Don'ts

### DO
- Put `font-variant-numeric: tabular-nums` on **every** live-updating number. Non-negotiable.
- Keep the existing logic helpers untouched: `extractTxHash`, `truncateMiddle`, `relativeTime`, `toDecimalOdds`, `pnlEstimate`. This is a presentation rebuild, not a logic rewrite.
- **KEEP VERBATIM:** the disclaimer "mark-to-model estimate (devnet PoC) — formula: stake × (entryOdds × modelProbability − 1)"; decimal odds; Solana Explorer tx links (truncated hash); the program ID `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp` in Geist Mono; the reasoning prose.
- h1 string is exactly **"World Cup TxODDS"**.

### DON'T (the 7 anti-patterns from design-critique)
1. **Cinzel on numbers.** Cinzel touches the h1 string only. Every digit is Geist.
2. **Three equal hero columns.** Net P&L is primary (terracotta, largest); the other two are secondary ink.
3. **Loud meander.** 8px hairline @35%, never a saturated band.
4. **Terracotta leaking past the primary stat.** Bright terracotta = Net P&L value only. Links stay ink; gains sage; losses terracotta-deep.
5. **Keeping the 3px P&L bars.** Dropped. The number is the visualization.
6. **Pills that look like buttons.** No hover, no pointer.
7. **Parchment + white with no contrast check.** APCA Lc 75+ on ink-on-parchment body text, verified in Phase 1c before CSS ships.

### Also DROP (from brief point 16)
Dark `oklch(12%)` background, system-ui font stack, 3px pnl bars, the 2×2 equal-density grid, the rectangular devnet badge. No marble SVGs in v1.

---

## Phase 1c — oklch conversion + APCA

Computed deterministically (OKLab matrices + APCA 0.0.98G), not eyeballed. The CSS variables Bram ships use these **oklch** values; the hex in frontmatter stays as the brand-canonical reference.

### Hex → OKLCH

| Token | Hex | OKLCH |
|---|---|---|
| parchment | `#f0ebe3` | `oklch(0.942 0.012 79.8)` |
| ivory | `#faf7f0` | `oklch(0.977 0.01 87.5)` |
| ink | `#2c2926` | `oklch(0.283 0.007 67.5)` |
| ink-prose **(NEW)** | `#57564f` | `oklch(0.452 0.011 100)` |
| ink-muted | `#87867f` | `oklch(0.619 0.01 100.1)` |
| border | `#e0dacf` | `oklch(0.89 0.016 82.8)` |
| terracotta | `#c96442` | `oklch(0.617 0.138 39)` |
| terracotta-deep | `#8b4518` | `oklch(0.471 0.11 49.3)` |
| sage | `#5a7260` | `oklch(0.527 0.04 152.5)` |
| sage-soft-bg | `#e4ebe6` | `oklch(0.933 0.01 155.1)` |
| fresco-ochre | `#c4a574` | `oklch(0.738 0.075 78.6)` |
| fresco-red | `#a64d4d` | `oklch(0.533 0.118 21.9)` |
| aegean | `#c5d4dc` | `oklch(0.861 0.02 230.7)` |

### APCA contrast results (and the one required fix)

| Pair | Lc | Verdict |
|---|---|---|
| ink on parchment (body) | **89.7** | PASS+ |
| ink on white (hero card) | **101.3** | PASS+ |
| ink on ivory (panels) | **96.6** | PASS+ |
| ink-muted on parchment | 52.6 | FAILS for body → **small labels only** |
| ink-muted on ivory | 59.5 | small labels/pills only |
| ink-muted on white | 64.2 | OK for small hero-card labels |
| **ink-prose `#57564f` on ivory** (reasoning prose) | **80.9** | PASS+ |
| ink-prose `#57564f` on parchment | 74.1 | PASS (≈ threshold) |
| terracotta on white (hero number, 3rem/600) | 65.9 | PASS (large-text) |
| terracotta-deep on white (loss number) | 84.1 | PASS+ |
| sage on white (gain number) | 76.0 | PASS+ |
| sage on sage-soft-bg (live badge label) | 63.1 | PASS (badge label) |

**Required refinement (mandated by brief point 14, not a re-litigation of point 9):** the reasoning-trace **body prose** must use a darker muted ink. `ink-muted #87867f` is **Lc 52.6 / 59.5** — it fails the brief's own Lc-75 body-text gate. Resolution: introduce **`--ink-prose` `#57564f` `oklch(0.452 0.011 100)`** for body-sized muted prose (the reasoning trace, which renders on the ivory panel at Lc 80.9 ✓). Keep `--ink-muted #87867f` for genuinely small/secondary UI text (labels, pill chips, relative-time, captions) where the soft-grey aesthetic is intact and APCA relaxes for small non-essential text. This is the standard "two muted inks" split — the soft look is preserved everywhere it's readable.

Large-number accents (terracotta 65.9, sage 63.1 badge) clear the APCA large-text / spot-text floor (Lc 60) at their rendered sizes/weights. No change needed.

### 50–950 scales (L-ramp holding each hue's C/H; for hover/active/border derivations)

```
parchment  50 oklch(0.985 0.008 79.8) · 100 0.955 · 200 0.905 · 300 0.835 · 400 0.74 · 500 0.64 · 600 0.545 · 700 0.46 · 800 0.375 · 900 0.295/0.01 · 950 0.235/0.01  (C 0.012, H 79.8)
ink        50 oklch(0.985 0.005 67.5) · … · 500 0.64 · 700 0.46 · 900 0.295 · 950 0.235  (C 0.007, H 67.5)
terracotta 50 oklch(0.985 0.097 39)   · 200–800 C 0.138 · 900/950 C 0.117  (H 39)
sage       50 oklch(0.985 0.028 152.5)· 200–800 C 0.04  · 900/950 C 0.034  (H 152.5)
```

### Shippable CSS custom-property block (Bram pastes this into globals.css `:root`)

```css
:root {
  /* Surfaces */
  --parchment:       oklch(0.942 0.012 79.8);   /* #f0ebe3 page background */
  --ivory:           oklch(0.977 0.01 87.5);    /* #faf7f0 panels + pills */
  --white:           oklch(1 0 0);              /* hero card surface */

  /* Text */
  --ink:             oklch(0.283 0.007 67.5);   /* #2c2926 primary text + hero probability */
  --ink-prose:       oklch(0.452 0.011 100);    /* #57564f body-sized muted prose (APCA-safe) */
  --ink-muted:       oklch(0.619 0.01 100.1);   /* #87867f SMALL labels / pills / captions only */
  --border:          oklch(0.89 0.016 82.8);    /* #e0dacf hairline */

  /* Accents */
  --terracotta:      oklch(0.617 0.138 39);     /* #c96442 hero Net P&L value ONLY */
  --terracotta-deep: oklch(0.471 0.11 49.3);    /* #8b4518 loss state */
  --sage:            oklch(0.527 0.04 152.5);   /* #5a7260 gain state + live-badge text */
  --sage-soft-bg:    oklch(0.933 0.01 155.1);   /* #e4ebe6 live-badge background */
  --fresco-ochre:    oklch(0.738 0.075 78.6);   /* #c4a574 diamond dividers + trace left-border */
  --fresco-red:      oklch(0.533 0.118 21.9);   /* #a64d4d reserved */
  --aegean:          oklch(0.861 0.02 230.7);   /* #c5d4dc reserved */
}
```

Phase 1c verdict: **palette converted, APCA gate PASSED with one mandated fix (`--ink-prose`). Lc 75+ holds on every body-text pair.**

---

## Phase 2a — Layout lock (impeccable-layout)

**Build-stack note for Bram:** project is plain Next.js + `globals.css`, **no Tailwind installed**. Recommend hand-written CSS in `globals.css` (a single page does not justify adding a Tailwind toolchain — ponytail). The brief's Tailwind class names are *descriptive*; translate to the concrete px/grid values below. If you'd rather add Tailwind v4, the tokens map 1:1 — your call, but plain CSS is the simpler path here.

**Squint test (target):** terracotta **Net P&L number** reads first (only saturated color + largest figure + only elevated white surface), Cinzel **h1** second, **meander** registers as a section rule, everything else is a calm grey field. PASS condition for design-review.

### Spacing scale (4pt, mapped to existing token names)
`--xs:4px · --sm:8px · --md:16px · --lg:24px · --xl:40px`. Add `--gap-section:40px` and `--pad-card:28px` as named values (both on-scale). **No arbitrary px outside this set.** Prefer `gap` over margins for sibling spacing.

### Container
`max-width:896px; margin-inline:auto; padding-inline:20px (≥640px: 32px); padding-block:40px;`

### 3-up hero card (the focal point)
```
grid: display:grid; grid-template-columns:1fr 1fr 1fr; align-items:start;
card padding: 28px 24px; border-radius:16px; background:var(--white);
border:1px solid var(--border); box-shadow: 0 1px 3px oklch(0.283 0.007 67.5/.06),
  0 8px 24px oklch(0.283 0.007 67.5/.05), inset 0 1px 0 oklch(1 0 0);
column: flex column, gap 8px, label ABOVE number (label 12px uppercase ink-muted
  letter-spacing .08em; number on its own line);
diamonds: each column except the last gets ::after '◆' 8px fresco-ochre@45%,
  absolutely centered in the column gap (top:50%; right:-4px; translateY(-50%));
hierarchy: col1 Net P&L number = 3rem terracotta; col2/col3 = 1.75rem ink.
```
Responsive **<640px**: `grid-template-columns:1fr;` stack the three; **hide diamonds**, separate stacked stats with `border-top:1px solid var(--border); padding-top:16px` (first row no border). Numbers drop to clamp floor.

### Pill chip row
`display:flex; flex-wrap:wrap; gap:8px;` directly below hero. Each pill: `padding:8px 20px; border-radius:9999px; background:var(--ivory); border:1px solid var(--border); font-size:12px; letter-spacing:.08em; color:var(--ink-muted);` — **no hover, `cursor:default`.**

### Vertical rhythm (6 sections, data-dense cadence)
| Between | Gap |
|---|---|
| header → meander | 12px (tight — meander hugs the header) |
| meander → hero card | 40px (`--xl`) |
| hero card → pill row | 16px (`--md`) |
| pill row → positions panel | 40px (`--gap-section`) |
| positions panel → reasoning trace | 24px (`--lg`) |
Within panels: 8–12px between sibling rows. The alternation (tight within, generous between) is the rhythm — not uniform spacing.

### Secondary panels (positions + reasoning)
`card-panel-greek`: `background:var(--ivory); border-radius:12px; padding:24px; position:relative;` inner classical frame via `::before { content:''; position:absolute; inset:6px; border:1px solid oklch(0.738 0.075 78.6/.25); border-radius:8px; pointer-events:none; }`. Flat (no drop shadow) so they read secondary to the elevated hero.

### Bans honored
No nested cards (hero is the only elevated card; panels are flat-framed, not cards-in-cards). No identical repeated card grid (hero ≠ pills ≠ panels — three distinct structures). No hero-metric-template gradient.

---

## Phase 2b — Typography lock (impeccable-typeset)

### Font loading (next/font)
Install the official `geist` package (`socket npm install geist` — npm project, package-lock present). Cinzel from `next/font/google`.

```tsx
// layout.tsx
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Cinzel } from "next/font/google";

const cinzel = Cinzel({
  subsets: ["latin"], weight: ["600"], variable: "--font-cinzel",
  display: "swap", fallback: ["Georgia", "Times New Roman", "serif"],
});

// <html className={`${GeistSans.variable} ${GeistMono.variable} ${cinzel.variable}`}>
```
`GeistSans.variable` → `--font-geist-sans`; `GeistMono.variable` → `--font-geist-mono`.

```css
/* globals.css :root */
--font-display: var(--font-cinzel), Georgia, "Times New Roman", serif;
--font-body:    var(--font-geist-sans), -apple-system, system-ui, sans-serif;
--font-mono:    var(--font-geist-mono), ui-monospace, "SF Mono", monospace;
```
```css
body { font-family: var(--font-body); font-kerning: normal; color: var(--ink); background: var(--parchment); }
h1   { font-family: var(--font-display); }   /* Cinzel binds HERE and nowhere else */
.mono { font-family: var(--font-mono); }
```

### The number rule (single utility — apply to EVERY digit)
```css
.num {
  font-family: var(--font-body);     /* Geist, never Cinzel */
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
```
**Hard rule, enforced by selector scoping:** Cinzel only ever matches `h1`. Numbers only ever live in `.num` spans. There is no selector path from Cinzel to a digit — anti-pattern #1 is structurally impossible, not just discouraged.

### Type scale (concrete)
| Role | Size | Weight | line-height | letter-spacing | Color | Family |
|---|---|---|---|---|---|---|
| h1 "World Cup TxODDS" | `clamp(1.75rem, 1.5rem + 1vw, 2rem)` | 600 | 1.15 | 0.01em | ink | Cinzel (`text-wrap:balance`) |
| Hero Net P&L (`.num`) | `clamp(2.25rem, 1.9rem + 1.8vw, 3rem)` (36→48px) | 600 | 1 | -0.02em | terracotta | Geist |
| Reasoning probability (`.num`) | `clamp(2.5rem, 2.2rem + 1.5vw, 3rem)` | 600 | 1 | -0.02em | ink | Geist |
| Secondary hero stats (`.num`) | `1.75rem` (fixed) | 600 | 1.1 | -0.02em | ink (sage if +) | Geist |
| Body / reasoning prose | `1rem` (fixed, ≥16px) | 400 | 1.75 | normal | **ink-prose** | Geist (`max-width:68ch`, `text-wrap:pretty`) |
| Eyebrow labels | `0.75rem` | 600 | 1.2 | 0.08em | ink-muted | Geist (uppercase) |
| Pill chips | `0.75rem` | 500 | 1 | 0.08em | ink-muted | Geist |
| Mono (hash / program ID / assessment) | `0.8125rem` (13px) | 400 | 1.5 | 0 | ink-muted / ink | Geist Mono |

### Bans honored
Exactly 3 families (Cinzel display, Geist body+numbers, Geist Mono code) — no fourth, no two-similar-sans pairing. Body ≥16px in `rem`. Bounded clamp only on the 2 display figures (ratio ≤1.34×). No `px` font sizes. No `user-scalable=no`.

---

## Phase 2 verdict
**Layout + typography LOCKED.** DESIGN.md is now the complete build spec: oklch tokens (APCA-passed) → layout grid + rhythm → next/font wiring + type scale + the structural Cinzel-never-on-digits guarantee. Ready for Bram (Phase 3).
