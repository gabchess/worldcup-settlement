import {
  latestTrace,
  positionsWithPnl,
  totalPnl,
  openPositions,
  toDecimalOdds,
} from "@/lib/traces";

const PROGRAM_ID = "FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp";
const EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatSol(lamports: number): string {
  // ponytail: display raw value with SOL label; actual unit depends on agent impl; upgrade when agent emits explicit unit field; ceiling: pre-mainnet
  return (lamports / 1_000_000_000).toFixed(4) + " SOL";
}

function pnlClass(value: number): string {
  return value >= 0 ? "pnl-positive" : "pnl-negative";
}

function actionClass(action: string): string {
  if (action === "increase") return "action-badge action-increase";
  if (action === "decrease") return "action-badge action-decrease";
  return "action-badge action-hold";
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

// Max absolute pnl across all positions — used to scale the bar widths.
const maxAbsPnl = positionsWithPnl.reduce(
  (m, t) => Math.max(m, Math.abs(t.pnl)),
  1 // floor at 1 to avoid division by zero
);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const updatedAt = latestTrace ? relativeTime(latestTrace.timestamp) : null;

  return (
    <>
      <header className="header">
        <span className="pulse-wrap" aria-label="Agent active">
          <span className="pulse-ring" />
          <span className="pulse-dot" />
        </span>
        <h1>World Cup Settlement</h1>

        <div className="header-meta">
          {updatedAt && <span className="updated-at">Updated {updatedAt}</span>}
          <a
            href={EXPLORER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="program-id"
            title="View program on Solana Explorer"
          >
            {PROGRAM_ID.slice(0, 8)}…{PROGRAM_ID.slice(-8)}
          </a>
          <span className="badge badge-devnet">devnet</span>
        </div>
      </header>

      <main className="main">
        {/* Panel 1: Last agent action */}
        <section className="panel" aria-label="Last agent action">
          <p className="panel-title">Last agent action</p>
          {latestTrace ? (
            <>
              <div className="field-row">
                <span className="field-label">Event</span>
                <span className="field-value">
                  {latestTrace.eventType.replaceAll("_", " ")}
                </span>
              </div>
              <div className="field-row">
                <span className="field-label">Fixture</span>
                <span className="field-value">#{latestTrace.fixtureId}</span>
              </div>
              <div className="field-row">
                <span className="field-label">Action</span>
                <span className={actionClass(latestTrace.suggestedAction)}>
                  {latestTrace.suggestedAction}
                </span>
              </div>
              {(() => {
                const tx = extractTxHash(latestTrace.assessment);
                return tx ? (
                  <div className="field-row">
                    <span className="field-label">Tx</span>
                    <a
                      href={`https://explorer.solana.com/tx/${tx}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tx-hash"
                      title={tx}
                    >
                      {truncateMiddle(tx)}
                    </a>
                  </div>
                ) : null;
              })()}
              <div className="field-row">
                <span className="field-label">When</span>
                <span className="relative-time">
                  {relativeTime(latestTrace.timestamp)}
                </span>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">⊘</div>
              <p className="empty-headline">No actions recorded</p>
              <p className="empty-sub">
                The agent hasn&apos;t acted yet this session.
              </p>
            </div>
          )}
        </section>

        {/* Panel 2: Open positions */}
        <section className="panel" aria-label="Open positions">
          <p className="panel-title">Open positions</p>
          {openPositions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">◻</div>
              <p className="empty-headline">No open positions</p>
              <p className="empty-sub">
                The agent has no active bets in this session.
              </p>
            </div>
          ) : (
            openPositions.map((t) => (
              <div key={t.fixtureId} className="position-row">
                <div className="position-header">
                  <span className="fixture-id">Fixture #{t.fixtureId}</span>
                  <span className="badge">{t.position.side}</span>
                </div>
                <div className="field-row">
                  <span className="field-label">Stake</span>
                  <span className="field-value">
                    {formatSol(t.position.stake)}
                  </span>
                </div>
                <div className="field-row">
                  <span className="field-label">Entry odds</span>
                  <span className="field-value">
                    {t.position.entryOdds != null
                      ? toDecimalOdds(t.position.entryOdds).toFixed(2)
                      : "—"}
                  </span>
                </div>
              </div>
            ))
          )}
        </section>

        {/* Panel 3: Live P&L */}
        <section className="panel" aria-label="Live P&L">
          <p className="panel-title">Live P&amp;L</p>
          {positionsWithPnl.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">◻</div>
              <p className="empty-headline">No positions to value</p>
              <p className="empty-sub">
                Open positions will appear here once bets are placed.
              </p>
            </div>
          ) : (
            <>
              {positionsWithPnl.map((t) => {
                const barWidth = Math.round(
                  (Math.abs(t.pnl) / maxAbsPnl) * 100
                );
                return (
                  <div
                    key={t.fixtureId}
                    className="field-row"
                    style={{ display: "block", padding: "8px 0" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span className="field-label">
                        #{t.fixtureId} {t.position.side}
                      </span>
                      <span className={`field-value ${pnlClass(t.pnl)}`}>
                        {t.pnl >= 0 ? "+" : ""}
                        {formatSol(t.pnl)}
                      </span>
                    </div>
                    <div className="pnl-bar-wrap">
                      <div
                        className={`pnl-bar ${
                          t.pnl >= 0 ? "positive" : "negative"
                        }`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="pnl-total">
                <span className="field-label">Net total</span>
                <span className={`field-value ${pnlClass(totalPnl)}`}>
                  {totalPnl >= 0 ? "+" : ""}
                  {formatSol(totalPnl)}
                </span>
              </div>
              <p className="pnl-disclaimer">
                mark-to-model estimate (devnet PoC) — formula: stake &times;
                (entryOdds &times; modelProbability &minus; 1)
              </p>
            </>
          )}
        </section>

        {/* Panel 4: Latest reasoning trace — spans full width */}
        <section className="panel" aria-label="Latest reasoning trace">
          <p className="panel-title">Latest reasoning trace</p>
          {latestTrace ? (
            <>
              {/* Hero stat: model probability */}
              <div className="trace-hero">
                <span className="trace-hero-stat">
                  {(latestTrace.modelProbability * 100).toFixed(1)}%
                </span>
                <span className="trace-hero-label">model probability</span>
              </div>

              <p className="trace-text">{latestTrace.reasoningTrace}</p>
              <div className="trace-assessment">{latestTrace.assessment}</div>

              {(() => {
                const tx = extractTxHash(latestTrace.assessment);
                return tx ? (
                  <div className="field-row" style={{ marginTop: "12px" }}>
                    <span className="field-label">Tx on-chain</span>
                    <a
                      href={`https://explorer.solana.com/tx/${tx}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tx-hash"
                      title={tx}
                    >
                      {truncateMiddle(tx)}
                    </a>
                  </div>
                ) : null;
              })()}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">⊘</div>
              <p className="empty-headline">No traces recorded</p>
              <p className="empty-sub">
                Reasoning traces from the agent will appear here.
              </p>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
