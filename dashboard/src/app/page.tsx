import {
  latestTrace,
  positionsWithPnl,
  totalPnl,
  openPositions,
} from "@/lib/traces";

const PROGRAM_ID = "FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp";
const EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

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
  // stake values in traces appear to be in lamports
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

export default function Page() {
  return (
    <>
      <header className="header">
        <h1>World Cup Settlement</h1>
        <a
          href={EXPLORER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="program-id"
          title="View on Solana Explorer"
        >
          {PROGRAM_ID.slice(0, 8)}…{PROGRAM_ID.slice(-8)}
        </a>
        <span className="badge badge-devnet">devnet</span>
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
              <div className="field-row">
                <span className="field-label">When</span>
                <span className="relative-time">
                  {relativeTime(latestTrace.timestamp)}
                </span>
              </div>
            </>
          ) : (
            <p className="empty">No actions recorded.</p>
          )}
        </section>

        {/* Panel 2: Open positions */}
        <section className="panel" aria-label="Open positions">
          <p className="panel-title">Open positions</p>
          {openPositions.length === 0 ? (
            <p className="empty">No open positions.</p>
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
                    {t.position.entryOdds ?? "—"}
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
            <p className="empty">No positions to value.</p>
          ) : (
            <>
              {positionsWithPnl.map((t) => (
                <div key={t.fixtureId} className="field-row">
                  <span className="field-label">
                    #{t.fixtureId} {t.position.side}
                  </span>
                  <span className={`field-value ${pnlClass(t.pnl)}`}>
                    {t.pnl >= 0 ? "+" : ""}
                    {formatSol(t.pnl)}
                  </span>
                </div>
              ))}
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

        {/* Panel 4: Latest reasoning trace */}
        <section className="panel" aria-label="Latest reasoning trace">
          <p className="panel-title">Latest reasoning trace</p>
          {latestTrace ? (
            <>
              <p className="trace-text">{latestTrace.reasoningTrace}</p>
              <div className="trace-assessment">{latestTrace.assessment}</div>
              <div className="field-row" style={{ marginTop: "8px" }}>
                <span className="field-label">Model P</span>
                <span className="field-value">
                  {(latestTrace.modelProbability * 100).toFixed(1)}%
                </span>
              </div>
            </>
          ) : (
            <p className="empty">No traces recorded.</p>
          )}
        </section>
      </main>
    </>
  );
}
