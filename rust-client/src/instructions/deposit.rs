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
    pub fn deposit_reserve_liquidity(
        &self,
        reserve: &Pubkey,
        liquidity_amount: u64,
    ) -> Result<Signature> {
        let reserve_data = self.program().account::<klend::Reserve>(*reserve)?;
        let lending_market = reserve_data.lending_market;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;

        // Get user's token accounts
        let user_source_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_liquidity_mint,
        );
        let user_destination_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_collateral_mint,
        );

        let accounts = klend::accounts::DepositReserveLiquidity {
            owner: self.payer_pubkey(),
            reserve: *reserve,
            lending_market,
            lending_market_authority,
            reserve_liquidity_mint,
            reserve_liquidity_supply,
            reserve_collateral_mint,
            user_source_liquidity,
            user_destination_collateral,
            collateral_token_program: anchor_spl::token::ID,
            liquidity_token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::DepositReserveLiquidity { liquidity_amount })
            .send()?;

        self.send_and_confirm("deposit_reserve_liquidity", signature)
    }

    pub fn deposit_obligation_collateral(
        &self,
        obligation: &Pubkey,
        deposit_reserve: &Pubkey,
        collateral_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*deposit_reserve)?;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
        let reserve_destination_collateral = reserve_data.collateral.supply_vault;

        // Get user's token account for the collateral
        let user_source_collateral = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_collateral_mint,
        );

        let accounts = klend::accounts::DepositObligationCollateral {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            deposit_reserve: *deposit_reserve,
            reserve_destination_collateral,
            user_source_collateral,
            token_program: anchor_spl::token::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::DepositObligationCollateral { collateral_amount })
            .send()?;

        self.send_and_confirm("deposit_obligation_collateral", signature)
    }

    pub fn deposit_reserve_liquidity_and_obligation_collateral(
        &self,
        obligation: &Pubkey,
        reserve: &Pubkey,
        liquidity_amount: u64,
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let reserve_data = self.program().account::<klend::Reserve>(*reserve)?;
        let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
        let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;
        let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
        let reserve_destination_deposit_collateral = reserve_data.collateral.supply_vault;

        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        // Get user's token account for the liquidity
        let user_source_liquidity = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            &reserve_liquidity_mint,
        );

        let accounts = klend::accounts::DepositReserveLiquidityAndObligationCollateral {
            owner: self.payer_pubkey(),
            obligation: *obligation,
            lending_market,
            lending_market_authority,
            reserve: *reserve,
            reserve_liquidity_mint,
            reserve_liquidity_supply,
            reserve_collateral_mint,
            reserve_destination_deposit_collateral,
            user_source_liquidity,
            placeholder_user_destination_collateral: None,
            collateral_token_program: anchor_spl::token::ID,
            liquidity_token_program: anchor_spl::token_interface::ID,
            instruction_sysvar_account: INSTRUCTIONS_ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::DepositReserveLiquidityAndObligationCollateral {
                liquidity_amount,
            })
            .send()?;

        self.send_and_confirm("deposit_reserve_liquidity_and_obligation_collateral", signature)
    }
} 