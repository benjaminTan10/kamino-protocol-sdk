use crate::KlendClient;
use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::Signature,
    sysvar::{instructions::ID as INSTRUCTIONS_ID, Sysvar},
};
use anchor_lang::prelude::*;
use anyhow::Result;
use klend::{self, utils::seeds, LtvMaxWithdrawalCheck};

impl KlendClient {
    pub fn withdraw_obligation_collateral(
        &self,
        obligation: &Pubkey,
        withdraw_reserve: &Pubkey,
        collateral_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*withdraw_reserve)?;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
        let reserve_source_collateral = reserve_data.collateral.supply_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token account for the collateral
        let user_destination_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_collateral_mint,
        );

        let accounts = klend::accounts::WithdrawObligationCollateral {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            lending_market_authority,
            withdraw_reserve: *withdraw_reserve,
            reserve_source_collateral,
            user_destination_collateral,
            token_program: anchor_spl::token::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::WithdrawObligationCollateral {
                collateral_amount,
                ltv_max_withdrawal_check: LtvMaxWithdrawalCheck::Perform,
            })
            .send()?;

        self.send_and_confirm("withdraw_obligation_collateral", signature)
    }

    pub fn withdraw_obligation_collateral_and_redeem_reserve_collateral(
        &self,
        obligation: &Pubkey,
        withdraw_reserve: &Pubkey,
        collateral_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*withdraw_reserve)?;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
        let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_source_collateral = reserve_data.collateral.supply_vault;
        let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token accounts
        let user_destination_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_collateral_mint,
        );
        let user_destination_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_liquidity_mint,
        );

        let accounts = klend::accounts::WithdrawObligationCollateralAndRedeemReserveCollateral {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            lending_market_authority,
            withdraw_reserve: *withdraw_reserve,
            reserve_collateral_mint,
            reserve_source_collateral,
            reserve_liquidity_supply,
            user_destination_collateral,
            user_destination_liquidity,
            collateral_token_program: anchor_spl::token::ID,
            liquidity_token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::WithdrawObligationCollateralAndRedeemReserveCollateral {
                collateral_amount,
                ltv_max_withdrawal_check: LtvMaxWithdrawalCheck::Perform,
            })
            .send()?;

        self.send_and_confirm("withdraw_obligation_collateral_and_redeem_reserve_collateral", signature)
    }
} 