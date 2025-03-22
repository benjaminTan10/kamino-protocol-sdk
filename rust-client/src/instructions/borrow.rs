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
    pub fn borrow_obligation_liquidity(
        &self,
        obligation: &Pubkey,
        borrow_reserve: &Pubkey,
        liquidity_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*borrow_reserve)?;
        let borrow_reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_source_liquidity = reserve_data.liquidity.supply_vault;
        let borrow_reserve_liquidity_fee_receiver = reserve_data.liquidity.fee_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token account for the liquidity
        let user_destination_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &borrow_reserve_liquidity_mint,
        );

        let accounts = klend::accounts::BorrowObligationLiquidity {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            lending_market_authority,
            borrow_reserve: *borrow_reserve,
            borrow_reserve_liquidity_mint,
            reserve_source_liquidity,
            borrow_reserve_liquidity_fee_receiver,
            user_destination_liquidity,
            referrer_token_state: None,
            token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::BorrowObligationLiquidity { liquidity_amount })
            .send()?;

        self.send_and_confirm("borrow_obligation_liquidity", signature)
    }
} 