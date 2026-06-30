import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  OffthreadVideo,
} from "remotion";
import { loadFont as loadCinzel } from "@remotion/google-fonts/Cinzel";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

// Load fonts
const cinzelFont = loadCinzel();
const geistFont = loadGeist();
const geistMonoFont = loadGeistMono();

// Design tokens — verbatim from dashboard DESIGN.md
const T = {
  parchment: "#f0ebe3",
  ivory: "#faf7f0",
  white: "#ffffff",
  ink: "#2c2926",
  inkProse: "#57564f",
  inkMuted: "#87867f",
  border: "#e0dacf",
  terracotta: "#c96442",
  terracottaDeep: "#8b4518",
  sage: "#5a7260",
  sageSoftBg: "#e4ebe6",
  ochre: "#c4a574",
};

// Timeline constants (frame = sec × 30)
// Seq 1: Hook     0 → 6.59s    (0 → 197.7f)
// Seq 2: Terminal 6.59 → 105.69s (197.7 → 3170.7f)
// Seq 3: Explorer 105.69 → 118.60s (3170.7 → 3558f)
// Seq 4: Dashboard 118.60 → 181.71s (3558 → 5451.3f)
// Seq 5: Close    181.71 → 203.58s (5451.3 → 6107.4f → 6108f)

const FPS = 30;

// Segment start frames
const S1_START = 0;
const S2_START = Math.round(6.59 * FPS); // 198
const S3_START = Math.round(105.69 * FPS); // 3171
const S4_START = Math.round(118.6 * FPS); // 3558
const S5_START = Math.round(181.71 * FPS); // 5451

// Segment durations in frames
const S1_DUR = S2_START - S1_START; // 198
const S2_DUR = S3_START - S2_START; // 2973
const S3_DUR = S4_START - S3_START; // 387
const S4_DUR = S5_START - S4_START; // 1893
const S5_DUR = 6108 - S5_START; // 657

// Clip durations in frames (actual)
const TERMINAL_CLIP_FRAMES = Math.round(44.37 * FPS); // 1331
const EXPLORER_CLIP_FRAMES = Math.round(11.2 * FPS); // 336
const DASHBOARD_CLIP_FRAMES = Math.round(11.67 * FPS); // 350

// Seg-2 card timing within Seq 2
// Post-clip window: S2_DUR - TERMINAL_CLIP_FRAMES = 2973 - 1331 = 1642 frames
// 3 cards, ~547f each (~18.2s each). Cross-fade 15f between cards.
const CARD_WINDOW_START = TERMINAL_CLIP_FRAMES; // frame within seq2
const CARD_DUR = Math.floor((S2_DUR - CARD_WINDOW_START) / 3); // ~547f per card
const CARD_A_START = CARD_WINDOW_START;
const CARD_B_START = CARD_WINDOW_START + CARD_DUR;
const CARD_C_START = CARD_WINDOW_START + CARD_DUR * 2;

// Shared font families (after load)
const FONT_CINZEL = `'Cinzel', Georgia, serif`;
const FONT_GEIST = `'Geist', -apple-system, system-ui, sans-serif`;
const FONT_GEIST_MONO = `'Geist Mono', 'SF Mono', monospace`;

// ── Utilities ──────────────────────────────────────────────────────────────

function fadeIn(
  frame: number,
  startFrame: number,
  durationFrames: number = 12
): number {
  return interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function fadeOut(
  frame: number,
  totalDuration: number,
  durationFrames: number = 15
): number {
  return interpolate(
    frame,
    [totalDuration - durationFrames, totalDuration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

// ── Segment 1: Hook Card ──────────────────────────────────────────────────

const HookCard: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = fadeIn(frame, 0, 12);
  const sfOpacity = spring({
    frame,
    fps: FPS,
    config: { stiffness: 100, damping: 20 },
  });

  return (
    <AbsoluteFill style={{ background: T.parchment, opacity }}>
      <Audio src={staticFile("vo/s1-hook.mp3")} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 20,
        }}
      >
        {/* TRACK 2 pill */}
        <div
          style={{
            opacity: sfOpacity,
            fontFamily: FONT_GEIST,
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: T.inkMuted,
            background: T.ivory,
            border: `1px solid ${T.border}`,
            borderRadius: 9999,
            padding: "8px 24px",
            textTransform: "uppercase",
          }}
        >
          TRACK 2
        </div>

        {/* Ochre diamond ornament */}
        <div style={{ color: T.ochre, fontSize: 20, opacity: sfOpacity }}>
          ◆
        </div>

        {/* Main title — Cinzel, terracotta OK at display size */}
        <h1
          style={{
            fontFamily: FONT_CINZEL,
            fontSize: 88,
            fontWeight: 600,
            color: T.terracotta,
            letterSpacing: "0.01em",
            margin: 0,
            textAlign: "center",
            opacity: sfOpacity,
          }}
        >
          World Cup TxODDS
        </h1>

        {/* Subtitle — Geist */}
        <p
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 32,
            fontWeight: 400,
            color: T.inkProse,
            margin: 0,
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.5,
            opacity: sfOpacity,
          }}
        >
          An AI that bets on live soccer. On Solana. Autonomously.
        </p>
      </div>
    </AbsoluteFill>
  );
};

// ── Editorial Card (shared card shell) ───────────────────────────────────

interface CardProps {
  localFrame: number; // frame within this card's window
  totalCardFrames: number;
}

const CardShell: React.FC<CardProps & { children: React.ReactNode }> = ({
  localFrame,
  totalCardFrames,
  children,
}) => {
  const entryOpacity = interpolate(localFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitOpacity = interpolate(
    localFrame,
    [totalCardFrames - 20, totalCardFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = Math.min(entryOpacity, exitOpacity);

  const sf = spring({
    frame: localFrame,
    fps: FPS,
    config: { stiffness: 120, damping: 20 },
  });
  const translateY = interpolate(sf, [0, 1], [30, 0]);

  return (
    <AbsoluteFill
      style={{
        background: T.parchment,
        opacity,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: T.white,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: "52px 64px",
          width: 860,
          boxShadow:
            "0 1px 3px rgba(44,41,38,.06), 0 8px 24px rgba(44,41,38,.05), inset 0 1px 0 #fff",
          transform: `translateY(${translateY}px)`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

// ── Card A: MODEL vs MARKET ───────────────────────────────────────────────

const CardModelVsMarket: React.FC<CardProps> = (props) => (
  <CardShell {...props}>
    {/* Eyebrow label */}
    <div
      style={{
        fontFamily: FONT_GEIST,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.1em",
        color: T.inkMuted,
        textTransform: "uppercase",
        marginBottom: 32,
      }}
    >
      MODEL EDGE
    </div>

    {/* Two stat rows */}
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        marginBottom: 36,
      }}
    >
      {/* Model row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 20,
            fontWeight: 500,
            color: T.ink,
          }}
        >
          Model — Brazil
        </span>
        <span
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 36,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            fontVariant: "tabular-nums",
            color: T.ink,
          }}
        >
          41.9%
        </span>
      </div>

      {/* Hairline */}
      <div style={{ height: 1, background: T.border }} />

      {/* Market row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 20,
            fontWeight: 500,
            color: T.inkMuted,
          }}
        >
          Market
        </span>
        <span
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 36,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            fontVariant: "tabular-nums",
            color: T.inkMuted,
          }}
        >
          36.8%
        </span>
      </div>
    </div>

    {/* Diamond divider */}
    <div
      style={{
        textAlign: "center",
        color: T.ochre,
        fontSize: 14,
        marginBottom: 32,
        letterSpacing: "0.4em",
      }}
    >
      ◆
    </div>

    {/* Big terracotta edge number */}
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontFamily: FONT_GEIST,
          fontSize: 80,
          fontWeight: 600,
          letterSpacing: "-0.03em",
          fontVariant: "tabular-nums",
          color: T.terracotta,
          lineHeight: 1,
          marginBottom: 8,
        }}
      >
        +5.1 pp
      </div>
      <div
        style={{
          fontFamily: FONT_GEIST,
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "0.1em",
          color: T.inkMuted,
          textTransform: "uppercase",
        }}
      >
        edge
      </div>
    </div>
  </CardShell>
);

// ── Card B: CLAUDE OPUS TRADE CASE ───────────────────────────────────────

const CardTradeCase: React.FC<CardProps> = (props) => (
  <CardShell {...props}>
    {/* Eyebrow label */}
    <div
      style={{
        fontFamily: FONT_GEIST,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.1em",
        color: T.inkMuted,
        textTransform: "uppercase",
        marginBottom: 32,
      }}
    >
      REASONING
    </div>

    {/* Cinzel heading */}
    <div
      style={{
        fontFamily: FONT_CINZEL,
        fontSize: 38,
        fontWeight: 600,
        color: T.ink,
        letterSpacing: "0.01em",
        marginBottom: 32,
      }}
    >
      Claude Opus Trade Case
    </div>

    {/* Ochre-bordered reasoning trace block — matches dashboard .trace-assessment */}
    <div
      style={{
        borderLeft: `4px solid ${T.ochre}`,
        paddingLeft: 20,
        marginBottom: 36,
        background: T.ivory,
        borderRadius: "0 8px 8px 0",
        padding: "20px 20px 20px 24px",
      }}
    >
      <div
        style={{
          fontFamily: FONT_GEIST_MONO,
          fontSize: 22,
          color: T.inkProse,
          lineHeight: 1.7,
          letterSpacing: 0,
        }}
      >
        fair odds at 41.9% imply 2.39
        <br />
        line at 2.72
        <br />
        +13.9% edge
      </div>
    </div>

    {/* Verdict chip */}
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: T.sageSoftBg,
        border: `1px solid ${T.sage}`,
        borderRadius: 9999,
        padding: "10px 24px",
      }}
    >
      <span
        style={{
          fontFamily: FONT_GEIST,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: T.sage,
          textTransform: "uppercase",
        }}
      >
        BET
      </span>
    </div>
  </CardShell>
);

// ── Card C: SIZE & SEND ───────────────────────────────────────────────────

const CardSizeAndSend: React.FC<CardProps> = (props) => {
  const { localFrame } = props;
  // Pulse animation on sage dot: 0→1→0 over 40 frames
  const pulseOpacity = Math.abs(Math.sin((localFrame / 40) * Math.PI));

  return (
    <CardShell {...props}>
      {/* Eyebrow */}
      <div
        style={{
          fontFamily: FONT_GEIST,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.1em",
          color: T.inkMuted,
          textTransform: "uppercase",
          marginBottom: 32,
        }}
      >
        EXECUTION
      </div>

      {/* Cinzel heading */}
      <div
        style={{
          fontFamily: FONT_CINZEL,
          fontSize: 38,
          fontWeight: 600,
          color: T.ink,
          letterSpacing: "0.01em",
          marginBottom: 28,
        }}
      >
        Size &amp; Send
      </div>

      {/* Sizing method */}
      <div
        style={{
          fontFamily: FONT_GEIST,
          fontSize: 22,
          fontWeight: 400,
          color: T.inkProse,
          lineHeight: 1.6,
          marginBottom: 36,
        }}
      >
        Fractional Kelly sizing
      </div>

      {/* TX SENT chip — terracotta */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            background: T.terracotta,
            borderRadius: 9999,
            padding: "10px 24px",
            fontFamily: FONT_GEIST,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          TX SENT
        </div>

        {/* on-chain · no human pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: T.sageSoftBg,
            border: `1px solid ${T.sage}`,
            borderRadius: 9999,
            padding: "10px 20px",
          }}
        >
          {/* Pulse dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: T.sage,
              opacity: 0.4 + pulseOpacity * 0.6,
            }}
          />
          <span
            style={{
              fontFamily: FONT_GEIST,
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: T.sage,
              textTransform: "uppercase",
            }}
          >
            on-chain · no human
          </span>
        </div>
      </div>
    </CardShell>
  );
};

// ── Segment 2: Terminal + Cards ───────────────────────────────────────────

const SegTerminal: React.FC = () => {
  const frame = useCurrentFrame();
  const isClipPlaying = frame < TERMINAL_CLIP_FRAMES;
  const localCardFrame = (n: number) =>
    frame - (CARD_WINDOW_START + CARD_DUR * n);

  return (
    <AbsoluteFill>
      <Audio src={staticFile("vo/s2-terminal.mp3")} />

      {/* Terminal clip phase */}
      {isClipPlaying && (
        <AbsoluteFill style={{ background: T.parchment }}>
          <OffthreadVideo
            src={staticFile("clips/terminal.mp4")}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </AbsoluteFill>
      )}

      {/* Card A */}
      {frame >= CARD_A_START && frame < CARD_B_START && (
        <CardModelVsMarket
          localFrame={localCardFrame(0)}
          totalCardFrames={CARD_DUR}
        />
      )}

      {/* Card B */}
      {frame >= CARD_B_START && frame < CARD_C_START && (
        <CardTradeCase
          localFrame={localCardFrame(1)}
          totalCardFrames={CARD_DUR}
        />
      )}

      {/* Card C */}
      {frame >= CARD_C_START && (
        <CardSizeAndSend
          localFrame={localCardFrame(2)}
          totalCardFrames={CARD_DUR}
        />
      )}
    </AbsoluteFill>
  );
};

// ── Segment 3: Explorer ───────────────────────────────────────────────────

const SegExplorer: React.FC = () => {
  const frame = useCurrentFrame();
  const isClipDone = frame >= EXPLORER_CLIP_FRAMES;

  return (
    <AbsoluteFill style={{ background: T.parchment }}>
      <Audio src={staticFile("vo/s3-explorer.mp3")} />
      {!isClipDone ? (
        <OffthreadVideo
          src={staticFile("clips/explorer.mp4")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <Img
          src={staticFile("clips/explorer-last.png")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
    </AbsoluteFill>
  );
};

// ── Segment 4: Dashboard + Ken-Burns ────────────────────────────────────

const SegDashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const isClipDone = frame >= DASHBOARD_CLIP_FRAMES;

  // Ken-Burns on the still: starts when clip ends
  // Scale 1.0 → 1.12 over the hold period; translateY 0 → -6%
  const holdFrame = Math.max(0, frame - DASHBOARD_CLIP_FRAMES);
  const holdDuration = S4_DUR - DASHBOARD_CLIP_FRAMES;

  const kbScale = interpolate(holdFrame, [0, holdDuration], [1.0, 1.12], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const kbTranslateYPct = interpolate(holdFrame, [0, holdDuration], [0, -6], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: T.parchment }}>
      <Audio src={staticFile("vo/s4-dashboard.mp3")} />
      {!isClipDone ? (
        <OffthreadVideo
          src={staticFile("clips/dashboard.mp4")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        /* Ken-Burns hold on dashboard still */
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <Img
            src={staticFile("clips/dashboard-still.png")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              transform: `scale(${kbScale}) translateY(${kbTranslateYPct}%)`,
              transformOrigin: "50% 40%",
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

// ── Segment 5: Close Card ────────────────────────────────────────────────

const SegClose: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const sfOpacity = spring({
    frame,
    fps: FPS,
    config: { stiffness: 80, damping: 18 },
  });
  const fadeOutOpacity = fadeOut(frame, S5_DUR, 15);
  const opacity = sfOpacity * fadeOutOpacity;

  return (
    <AbsoluteFill style={{ background: T.parchment }}>
      <Audio src={staticFile("vo/s5-close.mp3")} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 36,
          padding: "0 120px",
          opacity,
        }}
      >
        {/* Main headline — Cinzel */}
        <h2
          style={{
            fontFamily: FONT_CINZEL,
            fontSize: 80,
            fontWeight: 600,
            color: T.ink,
            letterSpacing: "0.01em",
            margin: 0,
            textAlign: "center",
          }}
        >
          The full loop.
        </h2>

        {/* Four lines of Geist body */}
        <div
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 30,
            fontWeight: 400,
            color: T.inkProse,
            lineHeight: 1.75,
            textAlign: "center",
          }}
        >
          Live data in.{" "}
          <span style={{ color: T.ink, fontWeight: 600 }}>
            Model + LLM decide.
          </span>{" "}
          On-chain out.{" "}
          <span style={{ color: T.ink, fontWeight: 600 }}>
            Settlement by Merkle proof.
          </span>
        </div>

        {/* Program ID pill */}
        <div
          style={{
            background: T.ivory,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: "14px 28px",
          }}
        >
          <span
            style={{
              fontFamily: FONT_GEIST_MONO,
              fontSize: 18,
              color: T.inkMuted,
              letterSpacing: "0.01em",
            }}
          >
            FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp
          </span>
        </div>

        {/* Footer line */}
        <div
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 18,
            fontWeight: 500,
            color: T.inkMuted,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            textAlign: "center",
          }}
        >
          Track 2 · Prediction markets &amp; settlement · Built solo
        </div>

        {/* Ochre diamond */}
        <div style={{ color: T.ochre, fontSize: 16 }}>◆</div>
      </div>
    </AbsoluteFill>
  );
};

// ── Root Composition ─────────────────────────────────────────────────────

export const DemoVideo: React.FC = () => {
  // Ensure fonts are referenced (loadFont returns the font family)
  void cinzelFont;
  void geistFont;
  void geistMonoFont;

  return (
    <AbsoluteFill style={{ background: T.parchment }}>
      {/* Sequence 1: Hook */}
      <Sequence from={S1_START} durationInFrames={S1_DUR}>
        <HookCard />
      </Sequence>

      {/* Sequence 2: Terminal + editorial cards */}
      <Sequence from={S2_START} durationInFrames={S2_DUR}>
        <SegTerminal />
      </Sequence>

      {/* Sequence 3: Explorer */}
      <Sequence from={S3_START} durationInFrames={S3_DUR}>
        <SegExplorer />
      </Sequence>

      {/* Sequence 4: Dashboard + Ken-Burns */}
      <Sequence from={S4_START} durationInFrames={S4_DUR}>
        <SegDashboard />
      </Sequence>

      {/* Sequence 5: Close */}
      <Sequence from={S5_START} durationInFrames={S5_DUR}>
        <SegClose />
      </Sequence>
    </AbsoluteFill>
  );
};
