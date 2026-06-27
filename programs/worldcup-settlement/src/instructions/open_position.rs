use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::constants::MARKET_SEED;
use crate::errors::WorldCupError;
use crate::market::{Market, Side};
use crate::position::Position;

/// Records a single bet on an open market and transfers stake_lamports from bettor
/// to the market PDA (which acts as the escrow vault for this thin contract).
///
/// council-4b: market.settled guard enforced in account constraint.
/// council-4c: stake amount validated via checked_sub before CPI transfer.
pub fn open_position(
    ctx: Context<OpenPosition>,
    stake_lamports: u64,
    side: Side,
) -> Result<()> {
    // council-4c: guard against zero stake (no-op bets)
    require!(stake_lamports > 0, WorldCupError::ZeroStake);

    // council-4c: verify bettor has sufficient lamports without underflow.
    // System program enforces this too, but we surface the explicit guard.
    ctx.accounts
        .bettor
        .lamports()
        .checked_sub(stake_lamports)
        .ok_or(WorldCupError::ArithmeticOverflow)?;

    // Transfer stake from bettor to market PDA (vault = market account itself).
    // The market PDA holds collected lamports; C9 claim logic disburses from here.
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.market.to_account_info(),
            },
        ),
        stake_lamports,
    )?;

    let position = &mut ctx.accounts.position;
    position.market = ctx.accounts.market.key();
    position.bettor = ctx.accounts.bettor.key();
    position.stake_lamports = stake_lamports; // council-4c: amount matches transferred lamports
    position.side = side;
    position.claimed = false;
    position.bump = ctx.bumps.position;
    Ok(())
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.match_id.to_le_bytes()],
        bump = market.bump,
        // council-4b: market must not already be settled
        constraint = !market.settled @ WorldCupError::AlreadySettled,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = bettor,
        space = Position::SIZE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub bettor: Signer<'info>,

    pub system_program: Program<'info, System>,
}
