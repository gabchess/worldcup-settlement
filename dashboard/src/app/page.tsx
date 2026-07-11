import {
  latestTrace,
  positionsWithPnl,
  totalPnl,
  openPositions,
  toDecimalOdds,
  modelEdge,
} from "@/lib/traces";

const PROGRAM_ID = "FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp";
const EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// This page is statically generated at build time (Next.js prerenders "/" as
// static content — confirmed via `next build`). A relative-time string like
// "Updated 2h ago" would be computed once at build and never revisited, so it
// silently goes stale the moment the deploy ages past minutes. An absolute
// date is honest at any distance from build time — it says exactly what it
// means and never quietly lies.
function formatSnapshotDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatSol(lamports: number): string {
  // ponytail: display raw value with SOL label; actual unit depends on agent impl; upgrade when agent emits explicit unit field; ceiling: pre-mainnet
  return (lamports / 1_000_000_000).toFixed(4) + " SOL";
}

/** Extract a Solana tx hash from the assessment string if present. */
function extractTxHash(assessment: string): string | null {
  const match = assessment.match(/tx=([A-Za-z0-9]{43,88})/);
  return match ? match[1] : null;
}

/** Middle-truncate a long string: first8…last8 */
function truncateMiddle(s: string, chars = 8): string {
  if (s.length <= chars * 2 + 1) return s;
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

// Meander SVG — 8px tall Greek-key, stroke ink-muted @35%, repeat-x
function MeanderSvg() {
  return (
    <svg
      className="meander-strip"
      xmlns="http://www.w3.org/2000/svg"
      height="8"
      preserveAspectRatio="xMidYMid repeat"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="meander"
          x="0"
          y="0"
          width="20"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          {/* Simple step meander: L-shapes forming a continuous key border */}
          <path
            d="M0 7 L0 1 L6 1 L6 4 L3 4 L3 7 L13 7 L13 4 L10 4 L10 1 L20 1"
            fill="none"
            stroke="oklch(0.619 0.01 100.1 / 0.35)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="100%" height="8" fill="url(#meander)" />
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const snapshotDate = latestTrace
    ? formatSnapshotDate(latestTrace.timestamp)
    : null;
  const atRisk = openPositions.reduce((s, t) => s + t.position.stake, 0);
  const txHash = latestTrace ? extractTxHash(latestTrace.assessment) : null;

  // Model edge display
  const edgeDisplay =
    modelEdge != null
      ? `${modelEdge >= 0 ? "+" : ""}${modelEdge.toFixed(2)} pp`
      : "—";
  const edgePositive = modelEdge != null && modelEdge >= 0;

  return (
    <div className="container">
      {/* Header */}
      <header className="page-header">
        <h1>World Cup TxODDS</h1>
        <div className="header-right">
          <span
            className="badge-status"
            aria-label="Devnet snapshot. Recorded reasoning trace, not a live feed"
          >
            <span className="status-dot-wrap" aria-hidden="true">
              <span className="status-dot" />
            </span>
            Snapshot
          </span>
          <a
            href={EXPLORER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="program-id-link mono"
            title={PROGRAM_ID}
          >
            {truncateMiddle(PROGRAM_ID)}
          </a>
          <span className="pill-devnet">devnet</span>
        </div>
      </header>

      {/* Meander strip */}
      <MeanderSvg />

      {/* 3-up hero card */}
      <div className="hero-card">
        <div className="hero-grid">
          {/* Col 1: Net P&L — primary */}
          <div className="hero-col">
            <span className="hero-label">Net P&amp;L</span>
            <span className={`num hero-number-primary`}>
              {totalPnl >= 0 ? "+" : ""}
              <span className="num">{formatSol(totalPnl)}</span>
            </span>
          </div>

          {/* Col 2: Open Positions — secondary */}
          <div className="hero-col">
            <span className="hero-label">Open Positions</span>
            <span className="num hero-number-secondary">
              {openPositions.length}
            </span>
          </div>

          {/* Col 3: Model Edge — secondary */}
          <div className="hero-col">
            <span className="hero-label">Model Edge</span>
            <span
              className={`num hero-number-secondary${
                edgePositive ? " gain" : ""
              }`}
            >
              {edgeDisplay}
            </span>
          </div>
        </div>
      </div>

      {/* Pill chip row */}
      <div className="pill-row" role="list" aria-label="Status pills">
        <span className="pill-chip" role="listitem">
          <span className="num">{openPositions.length}</span> open
        </span>
        <span className="pill-chip" role="listitem">
          <span className="num">{formatSol(atRisk)}</span> at risk
        </span>
        <span className="pill-chip" role="listitem">
          devnet
        </span>
        {snapshotDate && (
          <span className="pill-chip" role="listitem">
            Recorded {snapshotDate}
          </span>
        )}
      </div>

      {/* Positions panel */}
      <section className="card-panel-greek" aria-label="Open positions">
        <p className="panel-title">Open Positions</p>
        {openPositions.length === 0 ? (
          <div className="empty-state">No open positions yet.</div>
        ) : (
          openPositions.map((t) => (
            <div key={t.fixtureId} className="position-row">
              <div className="position-header">
                <span className="field-label mono">
                  Fixture #<span className="num">{t.fixtureId}</span>
                </span>
                <span className="badge-side">{t.position.side}</span>
              </div>
              <div className="field-row">
                <span className="field-label">Stake</span>
                <span className="field-value num">
                  {formatSol(t.position.stake)}
                </span>
              </div>
              <div className="field-row">
                <span className="field-label">Entry odds</span>
                <span className="field-value num">
                  {t.position.entryOdds != null
                    ? toDecimalOdds(t.position.entryOdds).toFixed(2)
                    : "—"}
                </span>
              </div>
            </div>
          ))
        )}
        {positionsWithPnl.length > 0 && (
          <p className="pnl-disclaimer">
            mark-to-model estimate (devnet PoC) — formula: stake &times;
            (entryOdds &times; modelProbability &minus; 1)
          </p>
        )}
      </section>

      {/* Reasoning-trace panel */}
      <section className="card-panel-greek" aria-label="Latest reasoning trace">
        <p className="panel-title">Latest Reasoning Trace</p>
        {latestTrace ? (
          <>
            <p className="trace-prob num">
              {(latestTrace.modelProbability * 100).toFixed(1)}%
            </p>
            <p className="trace-prob-label">model probability</p>
            <p className="trace-prose">{latestTrace.reasoningTrace}</p>
            <div className="trace-assessment mono">
              {latestTrace.assessment}
            </div>
            {txHash && (
              <div className="field-row" style={{ marginTop: "12px" }}>
                <span className="field-label">Tx on-chain</span>
                <a
                  href={`https://explorer.solana.com/tx/${txHash}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tx-hash mono"
                  title={txHash}
                >
                  {truncateMiddle(txHash)}
                </a>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">No traces recorded yet.</div>
        )}
      </section>
    </div>
  );
}
