/// Integration tests for worldcup-settlement instructions.
///
/// Uses litesvm (in-process SVM) — no local validator, no devnet.
/// The compiled .so is loaded from target/deploy/worldcup_settlement.so.
///
/// settle_from_proof tests require `--features test-oracle` so PLAN_B_ORACLE_AUTHORITY
/// in the .so matches the TEST_ORACLE_SECRET keypair used here.
use anchor_lang::InstructionData;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use worldcup_settlement::{self, instruction as ix};

// Re-export for PDA derivation convenience.
use worldcup_settlement::constants::MARKET_SEED;

const SYSTEM_PROGRAM_ID: solana_pubkey::Pubkey =
    solana_pubkey::Pubkey::from_str_const("11111111111111111111111111111111");

// ── Test oracle keypair (test-oracle feature only) ─────────────────────────
// Ed25519 secret = [1u8; 32] → pubkey AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9
// Must match PLAN_B_ORACLE_AUTHORITY in constants.rs when compiled with `test-oracle`.
const TEST_ORACLE_SECRET: [u8; 32] = [1u8; 32];

fn oracle_keypair() -> Keypair {
    Keypair::new_from_array(TEST_ORACLE_SECRET)
}

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
fn settle_accounts(
    market_key: &Pubkey,
    authority: &Pubkey,
) -> Vec<AccountMeta> {
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

// ponytail: helpers inline; extract only if tests multiply past 10+
fn program_id() -> Pubkey {
    worldcup_settlement::ID
}

fn market_pda(match_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MARKET_SEED, &match_id.to_le_bytes()],
        &program_id(),
    )
}

fn position_pda(market: &Pubkey, bettor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"position", market.as_ref(), bettor.as_ref()],
        &program_id(),
    )
}

/// Build an SVM with the program loaded. The .so is produced by `anchor build`.
fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    // CARGO_MANIFEST_DIR = programs/worldcup-settlement/; workspace root is two levels up.
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let so = format!("{manifest_dir}/../../target/deploy/worldcup_settlement.so");
    svm.add_program_from_file(program_id(), &so)
        .unwrap_or_else(|e| panic!("failed to load {so}: {e}"));
    svm
}

fn send(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], instruction: Instruction) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
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
    let data = ix::InitMarket { match_id, epoch_day }.data();
    let ix_obj = Instruction { program_id: program_id(), accounts, data };

    send(&mut svm, &authority, &[&authority], ix_obj).expect("init_market failed");

    // Read back Market account and verify fields.
    let raw = svm.get_account(&market_pda).expect("market account not found");
    // Skip the 8-byte anchor discriminator, then borsh-deserialize Market fields.
    // Offsets: discriminator(8) + match_id(8) + epoch_day(2) + authority(32) + settled(1) + ...
    let data = &raw.data[8..]; // skip discriminator
    let deserialized: worldcup_settlement::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &data[..]).expect("deserialize market");

    assert_eq!(deserialized.match_id, match_id, "match_id mismatch");
    assert_eq!(deserialized.epoch_day, epoch_day, "epoch_day mismatch");
    assert_eq!(deserialized.authority, authority.pubkey(), "authority mismatch");
    assert!(!deserialized.settled, "market should not be settled at init");
    assert!(deserialized.outcome.is_none(), "outcome should be None at init");
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
            data: ix::InitMarket { match_id, epoch_day }.data(),
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
        let data = ix::InitMarket { match_id, epoch_day }.data();
        send(&mut svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data })
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
        send(&mut svm, &bettor, &[&bettor], Instruction { program_id: program_id(), accounts, data })
            .expect("open_position");
    }

    // Verify lamport transfer: bettor paid stake + rent (position account), market received stake.
    let bettor_lamports_after = svm.get_account(&bettor.pubkey()).unwrap().lamports;
    let market_lamports_after = svm.get_account(&market_key).unwrap().lamports;

    assert!(bettor_lamports_after < bettor_lamports_before, "bettor should have fewer lamports");
    assert_eq!(
        market_lamports_after,
        market_lamports_before + stake,
        "market should have received exactly stake_lamports"
    );

    // Verify Position account fields.
    let raw = svm.get_account(&position_key).expect("position account not found");
    let data = &raw.data[8..]; // skip discriminator
    let pos: worldcup_settlement::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &data[..]).expect("deserialize position");

    assert_eq!(pos.market, market_key, "position.market mismatch");
    assert_eq!(pos.bettor, bettor.pubkey(), "position.bettor mismatch");
    assert_eq!(pos.stake_lamports, stake, "position.stake_lamports mismatch");
    assert_eq!(pos.side, worldcup_settlement::market::Side::Home, "position.side mismatch");
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
        let data = ix::InitMarket { match_id, epoch_day }.data();
        send(&mut svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data })
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
        let updated = svm.get_account(&market_key).expect("market account after poke");
        let market: worldcup_settlement::market::Market =
            anchor_lang::AnchorDeserialize::deserialize(&mut &updated.data[8..])
                .expect("deserialize market after poke");
        assert!(market.settled, "offset-50 poke must set market.settled = true; layout may have changed");
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

    let err = send(&mut svm, &bettor, &[&bettor], Instruction { program_id: program_id(), accounts, data })
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
    let data = ix::InitMarket { match_id, epoch_day }.data();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data })
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
    }.data();
    let accounts = settle_accounts(&market_key, &oracle.pubkey());

    send(&mut svm, &oracle, &[&oracle], Instruction { program_id: program_id(), accounts, data })
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
    }.data();
    let accounts = settle_accounts(&market_key, &wrong_signer.pubkey());

    let err = send(&mut svm, &wrong_signer, &[&wrong_signer], Instruction { program_id: program_id(), accounts, data })
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
        }.data();
        Instruction {
            program_id: program_id(),
            accounts: settle_accounts(&market_key, &oracle.pubkey()),
            data,
        }
    };

    // First settle: must succeed.
    send(&mut svm, &oracle, &[&oracle], make_settle_ix())
        .expect("first settle must succeed");

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
