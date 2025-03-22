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
    pub fn redeem_reserve_collateral(
        &self,
        reserve: &Pubkey,
        collateral_amount: u64,
    ) -> Result<Signature> {
        let reserve_data = self.program().account::<klend::Reserve>(*reserve)?;
        let lending_market = reserve_data.lending_market;
        let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
        let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token accounts
        let user_source_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_collateral_mint,
        );
        let user_destination_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_liquidity_mint,
        );

        let accounts = klend::accounts::RedeemReserveCollateral {
            owner: self.payer_pubkey(),
            lending_market,
            reserve: *reserve,
            lending_market_authority,
            reserve_liquidity_mint,
            reserve_collateral_mint,
            reserve_liquidity_supply,
            user_source_collateral,
            user_destination_liquidity,
            collateral_token_program: anchor_spl::token::ID,
            liquidity_token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::RedeemReserveCollateral { collateral_amount })
            .send()?;

        self.send_and_confirm("redeem_reserve_collateral", signature)
    }

    pub fn redeem_fees(&self, reserve: &Pubkey) -> Result<Signature> {
        let reserve_data = self.program().account::<klend::Reserve>(*reserve)?;
        let lending_market = reserve_data.lending_market;
        let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_liquidity_fee_receiver = reserve_data.liquidity.fee_vault;
        let reserve_supply_liquidity = reserve_data.liquidity.supply_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        let accounts = klend::accounts::RedeemFees {
            reserve: *reserve,
            reserve_liquidity_mint,
            reserve_liquidity_fee_receiver,
            reserve_supply_liquidity,
            lending_market,
            lending_market_authority,
            token_program: anchor_spl::token_interface::ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::RedeemFees {})
            .send()?;

        self.send_and_confirm("redeem_fees", signature)
    }
} 