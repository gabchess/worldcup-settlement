use anchor_lang::prelude::*;

// TxODDS devnet program (the program whose PDAs we read and CPI into)
pub const TXODDS_PROGRAM_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// PDA seeds (used in seeds constraints and manual derivation)
pub const MARKET_SEED: &[u8] = b"market";
pub const DAILY_BATCH_ROOTS_SEED: &[u8] = b"daily_batch_roots";

// Plan-B toggle — flip to false when live TxODDS data confirms the proof encoding (C6).
// C3-C5 devnet PoC: USE_PLAN_B = true.
pub const USE_PLAN_B: bool = true;

// Plan-B oracle authority.
// Plan-B = a trusted oracle posts the result, NO Merkle verification.
// PoC shortcut, NOT trustless; replaced by Model-2 once live data confirms the
// proof encoding (C6).
// This is a PUBKEY only — the wallet secret is never read here.
//
// `test-oracle` feature: use a fixed test keypair pubkey so integration tests
// can sign without needing the devnet burner wallet's private key.
// The test keypair (ed25519 secret = [1u8; 32]) has pubkey:
// AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9
// See tests/settlement.rs TEST_ORACLE_SECRET for the matching secret bytes.
#[cfg(feature = "test-oracle")]
pub const PLAN_B_ORACLE_AUTHORITY: Pubkey =
    pubkey!("AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9");

// Devnet burner wallet (we control it; the secret key lives in the deployer's keystore,
// never in this repo).
#[cfg(not(feature = "test-oracle"))]
pub const PLAN_B_ORACLE_AUTHORITY: Pubkey =
    pubkey!("8gbaJEfM5VDs9BpFLgwMTq7s2FkVpEri8ZnPbxn4HPqY");
