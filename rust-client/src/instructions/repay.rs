use crate::KlendClient;
use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::Signature,
    sysvar::{instructions::ID as INSTRUCTIONS_ID, Sysvar},
};
use anchor_lang::prelude::*;
use anyhow::Result;
use klend::{self, utils::seeds};

impl KlendClient {
    pub fn repay_obligation_liquidity(
        &self,
        obligation: &Pubkey,
        repay_reserve: &Pubkey,
        liquidity_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*repay_reserve)?;
        let repay_reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_destination_liquidity = reserve_data.liquidity.supply_vault;

        // Get user's token account for the liquidity
        let user_source_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &repay_reserve_liquidity_mint,
        );

        let accounts = klend::accounts::RepayObligationLiquidity {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            repay_reserve: *repay_reserve,
            user_source_liquidity,
            reserve_destination_liquidity,
            token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::RepayObligationLiquidity { liquidity_amount })
            .send()?;

        self.send_and_confirm("repay_obligation_liquidity", signature)
    }
} 