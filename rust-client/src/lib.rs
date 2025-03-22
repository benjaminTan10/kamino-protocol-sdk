pub mod fee_estimation;
pub mod instructions;
pub mod rpc;
pub mod utils;

use anchor_client::solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    signer::Signer,
};
use anchor_client::{Client as AnchorClient, Cluster, Program};
use anyhow::Result;
use std::rc::Rc;

pub use klend;

pub struct KlendClient {
    program: Program<Rc<Keypair>>,
    payer: Rc<Keypair>,
}

impl KlendClient {
    pub fn new(rpc_url: &str, payer: Keypair) -> Self {
        let payer = Rc::new(payer);
        let client = AnchorClient::new_with_options(
            Cluster::Custom(rpc_url.to_string(), rpc_url.to_string()),
            payer.clone(),
            CommitmentConfig::confirmed(),
        );
        let program = client.program(klend::ID).unwrap();

        Self { program, payer }
    }

    pub fn program(&self) -> &Program<Rc<Keypair>> {
        &self.program
    }

    pub fn payer(&self) -> &Keypair {
        &self.payer
    }

    pub fn payer_pubkey(&self) -> Pubkey {
        self.payer.pubkey()
    }

    pub fn send_and_confirm(&self, tx_name: &str, signature: Signature) -> Result<Signature> {
        println!("Sending transaction: {}", tx_name);
        let signature = self.program.rpc().confirm_transaction(&signature)?;
        println!("Transaction confirmed: {}", signature);
        Ok(signature)
    }
} 