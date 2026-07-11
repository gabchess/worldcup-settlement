use crate::constants::MARKET_SEED;
use crate::errors::WorldCupError;
use crate::market::{Market, Side};
use crate::position::Position;
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

/// Records a single bet on an open market and transfers stake_lamports from bettor
/// to the market PDA (which acts as the escrow vault for this thin contract).
///
/// council-4b: market.settled guard enforced in account constraint.
/// council-4c: stake amount validated via checked_sub before CPI transfer.
pub fn open_position(ctx: Context<OpenPosition>, stake_lamports: u64, side: Side) -> Result<()> {
    // council-4c: guard against zero stake (no-op bets)
    require!(stake_lamports > 0, WorldCupError::ZeroStake);

    // PRD S193 Amendment 1 / ticket T1c: betting-lock closed-interval guard.
    // Rejects at unix_timestamp == lock_ts (not just strictly after) so a
    // betting tx cannot race a market-observation tx on the same clock tick.
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.market.lock_ts as i64,
        WorldCupError::BettingClosed
    );

    // council-4c: verify bettor has sufficient lamports without underflow.
    // System program enforces this too, but we surface the explicit guard.
    ctx.accounts
        .bettor
        .lamports()
        .checked_sub(stake_lamports)
        .ok_or(WorldCupError::ArithmeticOverflow)?;

    // Transfer stake from bettor to market PDA (vault = market account itself).
    // The market PDA holds collected lamports; claim_payout (C9) disburses from here.
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

    // Track cumulative per-side stake so claim_payout can compute winning_pool /
    // total_pool without scanning every Position account (PRD S193 Implementation
    // Decision #2). Same checked-arithmetic discipline as the balance guard above.
    let market = &mut ctx.accounts.market;
    match &side {
        Side::Home => {
            market.home_pool = market
                .home_pool
                .checked_add(stake_lamports)
                .ok_or(WorldCupError::ArithmeticOverflow)?;
        }
        Side::Away => {
            market.away_pool = market
                .away_pool
                .checked_add(stake_lamports)
                .ok_or(WorldCupError::ArithmeticOverflow)?;
        }
        Side::Draw => {
            market.draw_pool = market
                .draw_pool
                .checked_add(stake_lamports)
                .ok_or(WorldCupError::ArithmeticOverflow)?;
        }
    }

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
