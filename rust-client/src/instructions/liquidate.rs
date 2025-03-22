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
    pub fn liquidate_obligation_and_redeem_reserve_collateral(
        &self,
        obligation: &Pubkey,
        repay_reserve: &Pubkey,
        withdraw_reserve: &Pubkey,
        liquidity_amount: u64,
        min_acceptable_received_liquidity_amount: u64,
        max_allowed_ltv_override_percent: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let repay_reserve_data = self.program().account::<klend::Reserve>(*repay_reserve)?;
        let repay_reserve_liquidity_mint = repay_reserve_data.liquidity.mint_pubkey;
        let repay_reserve_liquidity_supply = repay_reserve_data.liquidity.supply_vault;

        let withdraw_reserve_data = self.program().account::<klend::Reserve>(*withdraw_reserve)?;
        let withdraw_reserve_liquidity_mint = withdraw_reserve_data.liquidity.mint_pubkey;
        let withdraw_reserve_collateral_mint = withdraw_reserve_data.collateral.mint_pubkey;
        let withdraw_reserve_collateral_supply = withdraw_reserve_data.collateral.supply_vault;
        let withdraw_reserve_liquidity_supply = withdraw_reserve_data.liquidity.supply_vault;
        let withdraw_reserve_liquidity_fee_receiver = withdraw_reserve_data.liquidity.fee_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token accounts
        let user_source_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &repay_reserve_liquidity_mint,
        );
        let user_destination_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &withdraw_reserve_collateral_mint,
        );
        let user_destination_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &withdraw_reserve_liquidity_mint,
        );

        let accounts = klend::accounts::LiquidateObligationAndRedeemReserveCollateral {
            liquidator: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            lending_market_authority,
            repay_reserve: *repay_reserve,
            repay_reserve_liquidity_mint,
            repay_reserve_liquidity_supply,
            withdraw_reserve: *withdraw_reserve,
            withdraw_reserve_liquidity_mint,
            withdraw_reserve_collateral_mint,
            withdraw_reserve_collateral_supply,
            withdraw_reserve_liquidity_supply,
            withdraw_reserve_liquidity_fee_receiver,
            user_source_liquidity,
            user_destination_collateral,
            user_destination_liquidity,
            collateral_token_program: anchor_spl::token::ID,
            repay_liquidity_token_program: anchor_spl::token_interface::ID,
            withdraw_liquidity_token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        // Get all deposit reserves for remaining accounts
        let mut remaining_accounts = Vec::new();
        for deposit in obligation_data.deposits.iter() {
            if deposit.deposit_reserve != Pubkey::default() {
                remaining_accounts.push(AccountMeta::new(deposit.deposit_reserve, false));
            }
        }

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::LiquidateObligationAndRedeemReserveCollateral {
                liquidity_amount,
                min_acceptable_received_liquidity_amount,
                max_allowed_ltv_override_percent,
            })
            .accounts(remaining_accounts)
            .send()?;

        self.send_and_confirm("liquidate_obligation_and_redeem_reserve_collateral", signature)
    }
} 