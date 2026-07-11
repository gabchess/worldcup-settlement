/// Integration tests for worldcup-settlement instructions.
///
/// Uses litesvm (in-process SVM) — no local validator, no devnet.
/// The compiled .so is loaded from target/deploy/worldcup_settlement.so.
///
/// settle_from_proof tests require `--features test-oracle` so PLAN_B_ORACLE_AUTHORITY
/// in the .so matches the TEST_ORACLE_SECRET keypair used here.
mod common;

use anchor_lang::InstructionData;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use worldcup_settlement::{self, instruction as ix};

use common::{
    market_pda, oracle_keypair, position_pda, program_id, send, set_clock_timestamp, svm,
    FAR_FUTURE_LOCK_TS, SYSTEM_PROGRAM_ID,
};

/// Build a stat_data buffer that encodes match_id (u64 LE at bytes 0..8) and
/// outcome byte (at byte 8: 0=Home, 1=Away, 2=Draw).
fn stat_data_for(match_id: u64, outcome_byte: u8) -> Vec<u8> {
    let mut buf = vec![0u8; 9];
    buf[..8].copy_from_slice(&match_id.to_le_bytes());
    buf[8] = outcome_byte;
    buf
}

/// Build the settle_from_proof instruction accounts list.
/// Plan-B path: daily_batch_roots_pda and txodds_program are pass-through (unused).
fn settle_accounts(market_key: &Pubkey, authority: &Pubkey) -> Vec<AccountMeta> {
    // For Plan-B path, daily_batch_roots_pda and txodds_program are not read,
    // but they must be present in the accounts list (Anchor validates them).
    // Use TXODDS_PROGRAM_ID for txodds_program (passes the constraint check).
    let txodds = worldcup_settlement::constants::TXODDS_PROGRAM_ID;
    vec![
        AccountMeta::new(*market_key, false),
        AccountMeta::new_readonly(txodds, false), // daily_batch_roots_pda (unused in Plan-B)
        AccountMeta::new_readonly(txodds, false), // txodds_program
        AccountMeta::new(*authority, true),
    ]
}

// ── Test 1: init_market happy path ─────────────────────────────────────────

#[test]
fn test_init_market_happy_path() {
    let mut svm = svm();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 42;
    let epoch_day: u16 = 100;
    let (market_pda, _) = market_pda(match_id);

    let system_program_id = SYSTEM_PROGRAM_ID;

    let accounts = vec![
        AccountMeta::new(market_pda, false),
        AccountMeta::new(authority.pubkey(), true),
        AccountMeta::new_readonly(system_program_id, false),
    ];
    let data = ix::InitMarket {
        match_id,
        epoch_day,
        lock_ts: FAR_FUTURE_LOCK_TS,
    }
    .data();
    let ix_obj = Instruction {
        program_id: program_id(),
        accounts,
        data,
    };

    send(&mut svm, &authority, &[&authority], ix_obj).expect("init_market failed");

    // Read back Market account and verify fields.
    let raw = svm
        .get_account(&market_pda)
        .expect("market account not found");
    // Skip the 8-byte anchor discriminator, then borsh-deserialize Market fields.
    // Offsets: discriminator(8) + match_id(8) + epoch_day(2) + authority(32) + settled(1) + ...
    let data = &raw.data[8..]; // skip discriminator
    let deserialized: worldcup_settlement::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &data[..]).expect("deserialize market");

    assert_eq!(deserialized.match_id, match_id, "match_id mismatch");
    assert_eq!(deserialized.epoch_day, epoch_day, "epoch_day mismatch");
    assert_eq!(
        deserialized.authority,
        authority.pubkey(),
        "authority mismatch"
    );
    assert!(
        !deserialized.settled,
        "market should not be settled at init"
    );
    assert!(
        deserialized.outcome.is_none(),
        "outcome should be None at init"
    );
}

// ── Test 2: double-init rejected ───────────────────────────────────────────

#[test]
fn test_init_market_double_init_rejected() {
    let mut svm = svm();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 99;
    let epoch_day: u16 = 200;
    let (market_pda, _) = market_pda(match_id);
    let system_program_id = SYSTEM_PROGRAM_ID;

    let make_ix = || {
        let accounts = vec![
            AccountMeta::new(market_pda, false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(system_program_id, false),
        ];
        Instruction {
            program_id: program_id(),
            accounts,
            data: ix::InitMarket {
                match_id,
                epoch_day,
                lock_ts: FAR_FUTURE_LOCK_TS,
            }
            .data(),
        }
    };

    // First call succeeds.
    send(&mut svm, &authority, &[&authority], make_ix()).expect("first init_market should succeed");

    // Second call must fail (Anchor `init` constraint: account already allocated).
    send(&mut svm, &authority, &[&authority], make_ix())
        .expect_err("double-init should be rejected");
}

// ── Test 3: open_position happy path ───────────────────────────────────────

#[test]
fn test_open_position_happy_path() {
    let mut svm = svm();
    let authority = Keypair::new();
    let bettor = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 7;
    let epoch_day: u16 = 55;
    let (market_key, _) = market_pda(match_id);
    let (position_key, _) = position_pda(&market_key, &bettor.pubkey());
    let stake: u64 = 1_000_000; // 0.001 SOL
    let system_id = SYSTEM_PROGRAM_ID;

    // Init market first.
    {
        let accounts = vec![
            AccountMeta::new(market_key, false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(system_id, false),
        ];
        let data = ix::InitMarket {
            match_id,
            epoch_day,
            lock_ts: FAR_FUTURE_LOCK_TS,
        }
        .data();
        send(
            &mut svm,
            &authority,
            &[&authority],
            Instruction {
                program_id: program_id(),
                accounts,
                data,
            },
        )
        .expect("init_market");
    }

    let bettor_lamports_before = svm.get_account(&bettor.pubkey()).unwrap().lamports;
    let market_lamports_before = svm.get_account(&market_key).unwrap().lamports;

    // Open position.
    {
        let accounts = vec![
            AccountMeta::new(market_key, false),
            AccountMeta::new(position_key, false),
            AccountMeta::new(bettor.pubkey(), true),
            AccountMeta::new_readonly(system_id, false),
        ];
        let data = ix::OpenPosition {
            stake_lamports: stake,
            side: worldcup_settlement::market::Side::Home,
        }
        .data();
        send(
            &mut svm,
            &bettor,
            &[&bettor],
            Instruction {
                program_id: program_id(),
                accounts,
                data,
            },
        )
        .expect("open_position");
    }

    // Verify lamport transfer: bettor paid stake + rent (position account), market received stake.
    let bettor_lamports_after = svm.get_account(&bettor.pubkey()).unwrap().lamports;
    let market_lamports_after = svm.get_account(&market_key).unwrap().lamports;

    assert!(
        bettor_lamports_after < bettor_lamports_before,
        "bettor should have fewer lamports"
    );
    assert_eq!(
        market_lamports_after,
        market_lamports_before + stake,
        "market should have received exactly stake_lamports"
    );

    // Verify Position account fields.
    let raw = svm
        .get_account(&position_key)
        .expect("position account not found");
    let data = &raw.data[8..]; // skip discriminator
    let pos: worldcup_settlement::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &data[..]).expect("deserialize position");

    assert_eq!(pos.market, market_key, "position.market mismatch");
    assert_eq!(pos.bettor, bettor.pubkey(), "position.bettor mismatch");
    assert_eq!(
        pos.stake_lamports, stake,
        "position.stake_lamports mismatch"
    );
    assert_eq!(
        pos.side,
        worldcup_settlement::market::Side::Home,
        "position.side mismatch"
    );
    assert!(!pos.claimed, "position.claimed should be false");
}

// ── Test 4: open_position rejected on settled market ───────────────────────

#[test]
fn test_open_position_rejected_on_settled_market() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let authority = Keypair::new();
    let bettor = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 1;
    let epoch_day: u16 = 10;
    let (market_key, _) = market_pda(match_id);
    let system_id = SYSTEM_PROGRAM_ID;

    // Init market.
    {
        let accounts = vec![
            AccountMeta::new(market_key, false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(system_id, false),
        ];
        let data = ix::InitMarket {
            match_id,
            epoch_day,
            lock_ts: FAR_FUTURE_LOCK_TS,
        }
        .data();
        send(
            &mut svm,
            &authority,
            &[&authority],
            Instruction {
                program_id: program_id(),
                accounts,
                data,
            },
        )
        .expect("init_market");
    }

    // Force market.settled = true by directly writing to the account.
    // This simulates a post-settlement state without going through settle_from_proof (C5 stub).
    // ponytail: offset poke; ceiling = C5 settle stub; upgrade = replace with real settle_from_proof call once C5 ships.
    {
        let raw = svm.get_account(&market_key).expect("market account");
        let owner = raw.owner;

        // Reconstruct Market with settled = true.
        let mut market_data = raw.data.clone();
        // Layout: discriminator(8) + match_id(8) + epoch_day(2) + authority(32) = 50 → settled field.
        market_data[50] = 1u8; // settled = true

        svm.set_account(
            market_key,
            solana_account::Account {
                lamports: raw.lamports,
                data: market_data,
                owner,
                executable: false,
                rent_epoch: raw.rent_epoch,
            },
        )
        .unwrap();

        // Self-check: deserialize and confirm the poke hit the right field.
        // If Market layout changes, this assertion fails loudly before any downstream test can lie.
        let updated = svm
            .get_account(&market_key)
            .expect("market account after poke");
        let market: worldcup_settlement::market::Market =
            anchor_lang::AnchorDeserialize::deserialize(&mut &updated.data[8..])
                .expect("deserialize market after poke");
        assert!(
            market.settled,
            "offset-50 poke must set market.settled = true; layout may have changed"
        );
    }

    // Attempt to open a position — must fail with AlreadySettled (code 6000).
    let (position_key, _) = position_pda(&market_key, &bettor.pubkey());
    let accounts = vec![
        AccountMeta::new(market_key, false),
        AccountMeta::new(position_key, false),
        AccountMeta::new(bettor.pubkey(), true),
        AccountMeta::new_readonly(system_id, false),
    ];
    let data = ix::OpenPosition {
        stake_lamports: 500_000,
        side: worldcup_settlement::market::Side::Away,
    }
    .data();

    let err = send(
        &mut svm,
        &bettor,
        &[&bettor],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect_err("open_position on settled market should fail");

    // Anchor custom error AlreadySettled = index 0 → code 6000
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6000)),
        "expected AlreadySettled (6000)"
    );
}

// ── settle_from_proof tests (Plan-B path, USE_PLAN_B = true) ───────────────
// These run against the .so compiled with --features test-oracle, where
// PLAN_B_ORACLE_AUTHORITY = AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9
// (ed25519 secret = [1u8; 32], matching TEST_ORACLE_SECRET above).

fn init_market_for_settle(svm: &mut LiteSVM, match_id: u64) -> Pubkey {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let epoch_day: u16 = 1;
    let (market_key, _) = market_pda(match_id);
    let system_id = SYSTEM_PROGRAM_ID;
    let accounts = vec![
        AccountMeta::new(market_key, false),
        AccountMeta::new(authority.pubkey(), true),
        AccountMeta::new_readonly(system_id, false),
    ];
    let data = ix::InitMarket {
        match_id,
        epoch_day,
        // These tests settle immediately at litesvm's default (frozen)
        // Clock::default().unix_timestamp == 0 and never open a position, so
        // lock_ts = 0 preserves the pre-T1c "settle right after init"
        // scenario exactly (settle_from_proof's guard is unix_timestamp >=
        // lock_ts; 0 >= 0 holds at t=0 with no clock warp needed).
        lock_ts: 0,
    }
    .data();
    send(
        svm,
        &authority,
        &[&authority],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("init_market for settle test");
    market_key
}

// ── Test 5: Plan-B happy path ───────────────────────────────────────────────

#[test]
fn test_settle_plan_b_happy() {
    let mut svm = svm();
    let oracle = oracle_keypair();
    svm.airdrop(&oracle.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 200;
    let market_key = init_market_for_settle(&mut svm, match_id);

    // stat_data: match_id=200, outcome=Away (byte 1)
    let stat = stat_data_for(match_id, 1);
    let data = ix::SettleFromProof {
        proof_nodes: vec![],
        stat_data: stat,
    }
    .data();
    let accounts = settle_accounts(&market_key, &oracle.pubkey());

    send(
        &mut svm,
        &oracle,
        &[&oracle],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("plan-b settle should succeed");

    // Verify market is now settled with outcome=Away.
    let raw = svm.get_account(&market_key).expect("market after settle");
    let market: worldcup_settlement::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &raw.data[8..])
            .expect("deserialize market after settle");

    assert!(market.settled, "market.settled must be true after settle");
    assert_eq!(
        market.outcome,
        Some(worldcup_settlement::market::Side::Away),
        "outcome must be Away"
    );
}

// ── Test 6: Plan-B unauthorized signer rejected ─────────────────────────────

#[test]
fn test_settle_plan_b_unauthorized_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let wrong_signer = Keypair::new(); // random keypair, not the oracle
    svm.airdrop(&wrong_signer.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 201;
    let market_key = init_market_for_settle(&mut svm, match_id);

    let stat = stat_data_for(match_id, 0);
    let data = ix::SettleFromProof {
        proof_nodes: vec![],
        stat_data: stat,
    }
    .data();
    let accounts = settle_accounts(&market_key, &wrong_signer.pubkey());

    let err = send(
        &mut svm,
        &wrong_signer,
        &[&wrong_signer],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect_err("unauthorized oracle should be rejected");

    // WorldCupError::UnauthorizedOracle = index 5 → code 6005
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6005)),
        "expected UnauthorizedOracle (6005)"
    );
}

// ── Test 7: double-settle rejected (REQUIRED roadmap test) ─────────────────

#[test]
fn test_settle_double_settle_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let oracle = oracle_keypair();
    svm.airdrop(&oracle.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 202;
    let market_key = init_market_for_settle(&mut svm, match_id);

    let make_settle_ix = || {
        let stat = stat_data_for(match_id, 2); // Draw
        let data = ix::SettleFromProof {
            proof_nodes: vec![],
            stat_data: stat,
        }
        .data();
        Instruction {
            program_id: program_id(),
            accounts: settle_accounts(&market_key, &oracle.pubkey()),
            data,
        }
    };

    // First settle: must succeed.
    send(&mut svm, &oracle, &[&oracle], make_settle_ix()).expect("first settle must succeed");

    // Expire the blockhash so the second transaction gets a distinct signature.
    // Without this, LiteSVM deduplicates the transaction before hitting the program.
    svm.expire_blockhash();

    // Second settle on the same market: must fail with AlreadySettled.
    let err = send(&mut svm, &oracle, &[&oracle], make_settle_ix())
        .expect_err("double-settle must be rejected");

    // WorldCupError::AlreadySettled = index 0 → code 6000
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6000)),
        "expected AlreadySettled (6000) on double-settle"
    );
}

// ── Betting-lock tests (PRD S193 Amendment 1 / ticket T1c) ─────────────────
// lock_ts closes the betting window: open_position rejects at/after lock_ts
// (closed interval -- AT lock_ts is already locked, not just strictly after
// it), settle_from_proof rejects before lock_ts (settle-vs-lock ordering).
// litesvm's Clock sysvar defaults to Clock::default() (unix_timestamp == 0)
// and stays frozen until explicitly warped via common::set_clock_timestamp.

fn init_market_with_lock(svm: &mut LiteSVM, match_id: u64, lock_ts: u64) -> Pubkey {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let epoch_day: u16 = 1;
    let (market_key, _) = market_pda(match_id);
    let system_id = SYSTEM_PROGRAM_ID;
    let accounts = vec![
        AccountMeta::new(market_key, false),
        AccountMeta::new(authority.pubkey(), true),
        AccountMeta::new_readonly(system_id, false),
    ];
    let data = ix::InitMarket {
        match_id,
        epoch_day,
        lock_ts,
    }
    .data();
    send(
        svm,
        &authority,
        &[&authority],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("init_market for lock test");
    market_key
}

fn open_position_ix(market: &Pubkey, bettor: &Pubkey, stake: u64) -> (Pubkey, Instruction) {
    let (position_key, _) = position_pda(market, bettor);
    let accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new(position_key, false),
        AccountMeta::new(*bettor, true),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    let data = ix::OpenPosition {
        stake_lamports: stake,
        side: worldcup_settlement::market::Side::Home,
    }
    .data();
    (
        position_key,
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
}

// ── Test 8: open_position before lock succeeds (user story 16, zero regression) ──

#[test]
fn test_open_position_before_lock_succeeds() {
    let mut svm = svm();
    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 300;
    let lock_ts: u64 = 100;
    let market_key = init_market_with_lock(&mut svm, match_id, lock_ts);

    // litesvm's Clock is frozen at unix_timestamp == 0 by default, strictly
    // before lock_ts == 100 -- no warp needed for the "before lock" case.
    let (position_key, ix_obj) = open_position_ix(&market_key, &bettor.pubkey(), 500_000);
    send(&mut svm, &bettor, &[&bettor], ix_obj).expect("open_position before lock should succeed");

    let raw = svm
        .get_account(&position_key)
        .expect("position account not found");
    let pos: worldcup_settlement::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &raw.data[8..])
            .expect("deserialize position");
    assert_eq!(pos.stake_lamports, 500_000, "stake mismatch");
}

// ── Test 9: open_position after lock rejected (user story 15) ──────────────

#[test]
fn test_open_position_after_lock_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 301;
    let lock_ts: u64 = 100;
    let market_key = init_market_with_lock(&mut svm, match_id, lock_ts);

    // Warp strictly past the lock boundary.
    set_clock_timestamp(&mut svm, lock_ts as i64 + 1);

    let (_position_key, ix_obj) = open_position_ix(&market_key, &bettor.pubkey(), 500_000);
    let err = send(&mut svm, &bettor, &[&bettor], ix_obj)
        .expect_err("open_position after lock_ts must be rejected");

    // WorldCupError::BettingClosed = index 12 → code 6012
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6012)),
        "expected BettingClosed (6012)"
    );
}

// ── Test 10: open_position at the exact lock boundary rejected (closed interval, user story 17) ──

#[test]
fn test_open_position_at_lock_boundary_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 302;
    let lock_ts: u64 = 100;
    let market_key = init_market_with_lock(&mut svm, match_id, lock_ts);

    // Warp to EXACTLY lock_ts, not past it -- the closed-interval guard must
    // reject at unix_timestamp == lock_ts (PRD Amendment 1 story 17: lock
    // takes effect AT lock_ts, so a betting tx cannot race a market-
    // observation tx landing on the same clock tick).
    set_clock_timestamp(&mut svm, lock_ts as i64);

    let (_position_key, ix_obj) = open_position_ix(&market_key, &bettor.pubkey(), 500_000);
    let err = send(&mut svm, &bettor, &[&bettor], ix_obj)
        .expect_err("open_position at exactly lock_ts must be rejected (closed interval)");

    // WorldCupError::BettingClosed = index 12 → code 6012
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6012)),
        "expected BettingClosed (6012) at the exact lock_ts boundary"
    );
}

// ── Test 11: settle_from_proof before lock rejected (user story 18) ────────

#[test]
fn test_settle_before_lock_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let oracle = oracle_keypair();
    svm.airdrop(&oracle.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 303;
    let lock_ts: u64 = 100;
    let market_key = init_market_with_lock(&mut svm, match_id, lock_ts);

    // litesvm's Clock stays frozen at the default unix_timestamp == 0,
    // strictly before lock_ts == 100 -- settle must be rejected without
    // needing an explicit warp.
    let stat = stat_data_for(match_id, 0);
    let data = ix::SettleFromProof {
        proof_nodes: vec![],
        stat_data: stat,
    }
    .data();
    let accounts = settle_accounts(&market_key, &oracle.pubkey());

    let err = send(
        &mut svm,
        &oracle,
        &[&oracle],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect_err("settle_from_proof before lock_ts must be rejected");

    // WorldCupError::MarketNotYetLocked = index 13 → code 6013
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6013)),
        "expected MarketNotYetLocked (6013)"
    );
}

// ── Test 12: init_market with lock_ts above i64::MAX rejected (Kent review S193) ──
// Guards the u64->i64 cast: a value above i64::MAX would wrap negative and
// silently brick the market or no-op the settle guard.

#[test]
fn test_init_market_lock_ts_above_i64_max_rejected() {
    use solana_instruction::error::InstructionError;
    use solana_transaction::TransactionError;

    let mut svm = svm();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let match_id: u64 = 900;
    let epoch_day: u16 = 1;
    let lock_ts: u64 = (i64::MAX as u64) + 1; // wraps negative on the `as i64` cast

    let (market_key, _) = market_pda(match_id);
    let accounts = vec![
        AccountMeta::new(market_key, false),
        AccountMeta::new(authority.pubkey(), true),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    let data = ix::InitMarket {
        match_id,
        epoch_day,
        lock_ts,
    }
    .data();
    let err = send(
        &mut svm,
        &authority,
        &[&authority],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect_err("init_market with lock_ts > i64::MAX must be rejected");

    // WorldCupError::InvalidLockTs = index 14 → code 6014
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(6014)),
        "expected InvalidLockTs (6014)"
    );
}
