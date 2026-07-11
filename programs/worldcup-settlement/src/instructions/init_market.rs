use crate::constants::MARKET_SEED;
use crate::market::Market;
use anchor_lang::prelude::*;

/// Creates a Market PDA keyed on match_id.
///
/// Stores epoch_day so settle_from_proof can derive the daily_batch_roots PDA
/// without the caller re-passing it.
///
/// `lock_ts` closes the betting window (PRD S193 Amendment 1): an explicit
/// per-market argument, not derived or hardcoded, so the caller makes an
/// intentional, auditable choice for how long betting stays open. Enforced by
/// open_position (rejects at/after lock_ts) and settle_from_proof (rejects
/// before lock_ts).
///
/// TODO(C4): add event emission (MarketInitialized { match_id, epoch_day, authority })
pub fn init_market(
    ctx: Context<InitMarket>,
    match_id: u64,
    epoch_day: u16,
    lock_ts: u64,
) -> Result<()> {
    // Guard the u64->i64 cast used when comparing lock_ts to Clock::unix_timestamp:
    // a value above i64::MAX would wrap negative and silently brick the market
    // (all bets rejected) or no-op the settle guard (Kent review, S193).
    require!(
        lock_ts <= i64::MAX as u64,
        crate::errors::WorldCupError::InvalidLockTs
    );

    let market = &mut ctx.accounts.market;
    market.match_id = match_id;
    market.epoch_day = epoch_day;
    market.authority = ctx.accounts.authority.key();
    market.settled = false; // council-4b: starts unsettled
    market.outcome = None;
    market.bump = ctx.bumps.market;
    market.home_pool = 0;
    market.away_pool = 0;
    market.draw_pool = 0;
    market.lock_ts = lock_ts;
    Ok(())
}

#[derive(Accounts)]
#[instruction(match_id: u64, epoch_day: u16, lock_ts: u64)]
pub struct InitMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = Market::SIZE,
        seeds = [MARKET_SEED, &match_id.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
