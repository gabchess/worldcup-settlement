use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use crate::constants::{DAILY_BATCH_ROOTS_SEED, TXODDS_PROGRAM_ID};
use crate::errors::WorldCupError;
use crate::market::Side;

/// A single node in a portable Merkle proof path.
///
/// Mirrors @srivtx/sports-workbench subTreeProof / mainTreeProof shape
/// from schema-spike.json oddsValidationResponse.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    /// SHA-256 hash of the sibling node.
    pub hash: [u8; 32],
    /// If true, this node is the right sibling (leaf goes left in the hash pair).
    pub is_right_sibling: bool,
}

/// Derives the PDA address for the TxODDS daily_batch_roots account.
///
/// seeds: [b"daily_batch_roots", epoch_day.to_le_bytes()]
/// owner: TXODDS_PROGRAM_ID (from constants)
pub fn derive_daily_batch_roots_pda(
    epoch_day: u16,
    txodds_program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[DAILY_BATCH_ROOTS_SEED, &epoch_day.to_le_bytes()],
        txodds_program_id,
    )
}

/// SHA-256 two-argument combine: sha256(left ++ right).
/// Hash fn: SHA-256.
/// TODO(C6): confirm hash fn + leaf encoding against live TxODDS data.
#[inline]
fn sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// SHA-256 of arbitrary bytes (used for the leaf).
#[inline]
fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Pure Merkle-proof verifier — no on-chain PDA dependency.
///
/// Hashes `leaf` (sha256), walks `proof_nodes` applying left/right order
/// by `is_right_sibling`, and returns true if the computed root equals
/// `expected_root`.
///
/// Hash fn: SHA-256.
/// TODO(C6): confirm hash fn + leaf encoding against live TxODDS data.
///
/// # Arguments
/// * `leaf`          - raw stat_data bytes; will be sha256-hashed as the leaf.
/// * `proof_nodes`   - the proof path (subTreeProof ++ mainTreeProof concatenated).
/// * `expected_root` - the root read from the daily_batch_roots PDA.
pub fn verify_merkle_proof(
    leaf: &[u8],
    proof_nodes: &[ProofNode],
    expected_root: &[u8; 32],
) -> bool {
    // Leaf = sha256(stat_data)
    let mut current: [u8; 32] = sha256_bytes(leaf);

    for node in proof_nodes {
        // Combine: if node is the right sibling, current is on the left.
        current = if node.is_right_sibling {
            sha256_pair(&current, &node.hash)
        } else {
            sha256_pair(&node.hash, &current)
        };
    }

    &current == expected_root
}

/// Reads the 32-byte root from the first 32 bytes of a daily_batch_roots PDA account.
///
/// Owner check (Dayo council-4a): rejects any System-owned account squatted at the
/// correct PDA address, preventing forged-proof injection via PDA squatting.
///
/// TODO(C6): confirm the exact byte offset in the real TxODDS PDA layout.
/// ponytail: no anchor discriminator skip; adjust offset if TxODDS uses one.
fn read_root_from_pda(pda: &AccountInfo) -> Result<[u8; 32]> {
    // Security: verify the PDA is owned by the TxODDS program, not System or an
    // attacker-controlled account squatted at the same address.
    require_keys_eq!(
        *pda.owner,
        TXODDS_PROGRAM_ID,
        WorldCupError::InvalidRootAccountOwner
    );
    let data = pda.try_borrow_data()?;
    if data.len() < 32 {
        return Err(WorldCupError::ProofVerificationFailed.into());
    }
    let mut root = [0u8; 32];
    root.copy_from_slice(&data[..32]);
    Ok(root)
}

/// Decodes match_id from stat_data.
///
/// Encoding (C5): bytes 0..8 = match_id as u64 LE.
/// TODO(C6): confirm against live TxODDS stat_data schema.
pub fn decode_match_id(stat_data: &[u8]) -> Option<u64> {
    if stat_data.len() < 8 {
        return None;
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&stat_data[..8]);
    Some(u64::from_le_bytes(buf))
}

/// Decodes outcome from stat_data.
///
/// Encoding (C5): byte 8 = outcome (0=Home, 1=Away, 2=Draw).
/// TODO(C6): confirm against live TxODDS stat_data schema.
pub fn decode_outcome(stat_data: &[u8]) -> Option<Side> {
    match stat_data.get(8) {
        Some(0) => Some(Side::Home),
        Some(1) => Some(Side::Away),
        Some(2) => Some(Side::Draw),
        _ => None,
    }
}

/// Verifies that stat_data is included in the Merkle tree whose root
/// is stored in the TxODDS daily_batch_roots PDA account.
///
/// Reads the root from the PDA, walks proof_nodes via sha256, and returns
/// WorldCupError::ProofVerificationFailed on any mismatch.
pub fn verify_proof_against_pda(
    stat_data: &[u8],
    proof_nodes: &[ProofNode],
    daily_batch_roots_pda: &AccountInfo,
) -> Result<()> {
    let root = read_root_from_pda(daily_batch_roots_pda)?;
    if !verify_merkle_proof(stat_data, proof_nodes, &root) {
        return Err(WorldCupError::ProofVerificationFailed.into());
    }
    Ok(())
}

// ── Unit tests for the pure Merkle verifier ────────────────────────────────
// These run in regular Rust (no .so, no LiteSVM).
// They build a synthetic 2-leaf tree, verify the happy path, and confirm
// that tampering with a node hash causes rejection.

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 2-leaf Merkle tree and return (leaf0_data, proof_for_leaf0, root).
    ///
    /// Tree layout:
    ///   leaf0 = sha256(b"leaf0")
    ///   leaf1 = sha256(b"leaf1")
    ///   root  = sha256(leaf0 ++ leaf1)   (leaf1 is the right sibling of leaf0)
    fn synthetic_tree() -> (Vec<u8>, Vec<ProofNode>, [u8; 32]) {
        let leaf0_data = b"leaf0".to_vec();
        let leaf0_hash: [u8; 32] = Sha256::digest(&leaf0_data).into();
        let leaf1_hash: [u8; 32] = Sha256::digest(b"leaf1").into();

        // root = sha256(leaf0 ++ leaf1)
        let root: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(leaf0_hash);
            h.update(leaf1_hash);
            h.finalize().into()
        };

        // Proof for leaf0: single node = leaf1 (right sibling).
        let proof = vec![ProofNode {
            hash: leaf1_hash,
            is_right_sibling: true,
        }];

        (leaf0_data, proof, root)
    }

    #[test]
    fn test_verify_merkle_proof_valid() {
        let (leaf_data, proof, root) = synthetic_tree();
        assert!(
            verify_merkle_proof(&leaf_data, &proof, &root),
            "valid proof must verify"
        );
    }

    #[test]
    fn test_verify_merkle_proof_tampered_node_rejected() {
        let (leaf_data, mut proof, root) = synthetic_tree();
        // Flip one byte in the sibling hash.
        proof[0].hash[0] ^= 0xFF;
        assert!(
            !verify_merkle_proof(&leaf_data, &proof, &root),
            "tampered proof must not verify"
        );
    }

    #[test]
    fn test_verify_merkle_proof_wrong_leaf_rejected() {
        let (_leaf_data, proof, root) = synthetic_tree();
        // Different data — produces a different leaf hash.
        assert!(
            !verify_merkle_proof(b"wrong_data", &proof, &root),
            "wrong leaf data must not verify"
        );
    }

    #[test]
    fn test_decode_match_id_and_outcome() {
        // stat_data: match_id=42 (u64 LE) + outcome=0 (Home)
        let mut stat_data = vec![0u8; 9];
        stat_data[..8].copy_from_slice(&42u64.to_le_bytes());
        stat_data[8] = 0; // Home

        assert_eq!(decode_match_id(&stat_data), Some(42u64));
        assert!(matches!(decode_outcome(&stat_data), Some(Side::Home)));

        // Outcome byte 1 = Away
        stat_data[8] = 1;
        assert!(matches!(decode_outcome(&stat_data), Some(Side::Away)));

        // Outcome byte 2 = Draw
        stat_data[8] = 2;
        assert!(matches!(decode_outcome(&stat_data), Some(Side::Draw)));

        // Unknown outcome byte
        stat_data[8] = 99;
        assert!(decode_outcome(&stat_data).is_none());
    }

    #[test]
    fn test_decode_match_id_too_short() {
        assert_eq!(decode_match_id(b"short"), None);
    }

    // ── C5 owner-check coverage (Dayo council-4a PDA-squatting defense) ──────
    // Tests that `read_root_from_pda` enforces owner == TXODDS_PROGRAM_ID and
    // rejects any account whose owner is a different program (e.g. System Program).
    //
    // Builds a hand-crafted AccountInfo with chosen owner + data.
    // No .so required — runs under `cargo test --lib --features test-oracle`.

    /// Helper: build an `AccountInfo` with the given owner and 32-byte data.
    ///
    /// All backing storage is owned by the caller's frame; the AccountInfo
    /// borrows from it for lifetime `'a`.
    fn mock_pda_account<'a>(
        key: &'a Pubkey,
        owner: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut [u8],
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, false, lamports, data, owner, false)
    }

    #[test]
    fn test_owner_check_accepts_txodds_owner() {
        // Arm (a): owner == TXODDS_PROGRAM_ID with valid 32-byte root.
        let root_bytes: [u8; 32] = [0xAB; 32];
        let key = Pubkey::default();
        let owner = TXODDS_PROGRAM_ID;
        let mut lamports: u64 = 0;
        let mut data: Vec<u8> = root_bytes.to_vec();

        let pda = mock_pda_account(&key, &owner, &mut lamports, &mut data);
        let result = read_root_from_pda(&pda);

        assert!(result.is_ok(), "valid TxODDS-owned PDA must succeed");
        assert_eq!(result.unwrap(), root_bytes, "returned root must match data[..32]");
    }

    #[test]
    fn test_owner_check_rejects_non_txodds_owner() {
        // Arm (b): owner == System Program → must return InvalidRootAccountOwner.
        // Uses Pubkey::default() (all-zeros / System Program) as the squatted owner.
        let root_bytes: [u8; 32] = [0xAB; 32];
        let key = Pubkey::default();
        let attacker_owner = Pubkey::default(); // any non-TXODDS pubkey
        let mut lamports: u64 = 0;
        let mut data: Vec<u8> = root_bytes.to_vec();

        let pda = mock_pda_account(&key, &attacker_owner, &mut lamports, &mut data);
        let result = read_root_from_pda(&pda);

        assert!(result.is_err(), "non-TxODDS-owned PDA must be rejected");
        let expected_err: anchor_lang::error::Error =
            WorldCupError::InvalidRootAccountOwner.into();
        assert_eq!(
            result.unwrap_err(),
            expected_err,
            "error must be InvalidRootAccountOwner"
        );
    }
}
