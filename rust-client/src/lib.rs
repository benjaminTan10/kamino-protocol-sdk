pub mod instructions;
pub mod rpc;
pub mod utils;

use anchor_client::solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use anyhow::Result;
use rpc::RpcArgs;
use solana_sdk::commitment_config::CommitmentConfig;

pub struct KlendClient {
    pub program_id: Pubkey,
    pub rpc_args: RpcArgs,
    pub payer: Keypair,
}

impl KlendClient {
    pub fn new(program_id: Pubkey, rpc_url: String, payer: Keypair) -> Self {
        Self {
            program_id,
            rpc_args: RpcArgs {
                rpc_url,
                priority_fee: 0,
                tx_action: rpc::TX_ACTION_SENT_TX,
                keypair_path: None,
            },
            payer,
        }
    }

    pub fn with_priority_fee(mut self, priority_fee: u64) -> Self {
        self.rpc_args.priority_fee = priority_fee;
        self
    }

    pub fn with_tx_action(mut self, tx_action: u8) -> Self {
        self.rpc_args.tx_action = tx_action;
        self
    }

    pub fn send_transaction(&self, transaction: Transaction, max_retries: u64) -> Result<solana_sdk::signature::Signature> {
        Ok(self.rpc_args.send_transaction(&transaction, max_retries)?)
    }
} 