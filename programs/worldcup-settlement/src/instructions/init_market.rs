use anchor_lang::prelude::*;
use crate::constants::MARKET_SEED;
use crate::market::Market;

/// Creates a Market PDA keyed on match_id.
///
/// Stores epoch_day so settle_from_proof can derive the daily_batch_roots PDA
/// without the caller re-passing it.
///
/// TODO(C4): add event emission (MarketInitialized { match_id, epoch_day, authority })
pub fn init_market(ctx: Context<InitMarket>, match_id: u64, epoch_day: u16) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.match_id = match_id;
    market.epoch_day = epoch_day;
    market.authority = ctx.accounts.authority.key();
    market.settled = false; // council-4b: starts unsettled
    market.outcome = None;
    market.bump = ctx.bumps.market;
    Ok(())
}

#[derive(Accounts)]
#[instruction(match_id: u64, epoch_day: u16)]
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
