use crate::KlendClient;
use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::Signature,
    system_program,
    sysvar::{rent, Sysvar},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use anyhow::Result;
use klend::{
    self,
    state::{LendingMarket, Reserve, UserMetadata},
    utils::seeds,
    InitObligationArgs,
};

impl KlendClient {
    pub fn init_lending_market(&self, quote_currency: [u8; 32]) -> Result<Signature> {
        let lending_market = Keypair::new();
        let (lending_market_authority, _bump) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.pubkey().as_ref()],
            &klend::ID,
        );

        let accounts = klend::accounts::InitLendingMarket {
            lending_market_owner: self.payer_pubkey(),
            lending_market: lending_market.pubkey(),
            lending_market_authority,
            system_program: system_program::ID,
            rent: rent::ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::InitLendingMarket { quote_currency })
            .signer(&lending_market)
            .send()?;

        self.send_and_confirm("init_lending_market", signature)
    }

    pub fn init_user_metadata(
        &self,
        owner: &Pubkey,
        user_lookup_table: Pubkey,
        referrer_user_metadata: Option<Pubkey>,
    ) -> Result<Signature> {
        let (user_metadata, _) = Pubkey::find_program_address(
            &[klend::utils::seeds::BASE_SEED_USER_METADATA, owner.as_ref()],
            &klend::ID,
        );

        let mut accounts = klend::accounts::InitUserMetadata {
            owner: *owner,
            fee_payer: self.payer_pubkey(),
            user_metadata,
            referrer_user_metadata: None,
            rent: rent::ID,
            system_program: system_program::ID,
        };

        if let Some(referrer) = referrer_user_metadata {
            accounts.referrer_user_metadata = Some(referrer);
        }

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::InitUserMetadata { user_lookup_table })
            .send()?;

        self.send_and_confirm("init_user_metadata", signature)
    }

    pub fn init_obligation(
        &self,
        lending_market: &Pubkey,
        obligation_owner: &Pubkey,
        tag: u8,
        id: u8,
        seed1_account: &Pubkey,
        seed2_account: &Pubkey,
    ) -> Result<Signature> {
        let (owner_user_metadata, _) = Pubkey::find_program_address(
            &[
                klend::utils::seeds::BASE_SEED_USER_METADATA,
                obligation_owner.as_ref(),
            ],
            &klend::ID,
        );

        let (obligation, _) = Pubkey::find_program_address(
            &[
                &[tag],
                &[id],
                obligation_owner.as_ref(),
                lending_market.as_ref(),
                seed1_account.as_ref(),
                seed2_account.as_ref(),
            ],
            &klend::ID,
        );

        let accounts = klend::accounts::InitObligation {
            obligation_owner: *obligation_owner,
            fee_payer: self.payer_pubkey(),
            obligation,
            lending_market: *lending_market,
            seed1_account: *seed1_account,
            seed2_account: *seed2_account,
            owner_user_metadata,
            rent: rent::ID,
            system_program: system_program::ID,
        };

        let args = InitObligationArgs { tag, id };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::InitObligation { args })
            .send()?;

        self.send_and_confirm("init_obligation", signature)
    }

    pub fn init_reserve(
        &self,
        lending_market: &Pubkey,
        reserve_liquidity_mint: &Pubkey,
        initial_liquidity_amount: u64,
    ) -> Result<Signature> {
        let (lending_market_authority, _) = Pubkey::find_program_address(
            &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
            &klend::ID,
        );

        let reserve = Keypair::new();

        let (reserve_liquidity_supply, _) = Pubkey::find_program_address(
            &[
                seeds::RESERVE_LIQ_SUPPLY,
                lending_market.as_ref(),
                reserve_liquidity_mint.as_ref(),
            ],
            &klend::ID,
        );

        let (fee_receiver, _) = Pubkey::find_program_address(
            &[
                seeds::FEE_RECEIVER,
                lending_market.as_ref(),
                reserve_liquidity_mint.as_ref(),
            ],
            &klend::ID,
        );

        let (reserve_collateral_mint, _) = Pubkey::find_program_address(
            &[
                seeds::RESERVE_COLL_MINT,
                lending_market.as_ref(),
                reserve_liquidity_mint.as_ref(),
            ],
            &klend::ID,
        );

        let (reserve_collateral_supply, _) = Pubkey::find_program_address(
            &[
                seeds::RESERVE_COLL_SUPPLY,
                lending_market.as_ref(),
                reserve_liquidity_mint.as_ref(),
            ],
            &klend::ID,
        );

        // Get user's token account for the liquidity mint
        let initial_liquidity_source = spl_associated_token_account::get_associated_token_address(
            &self.payer_pubkey(),
            reserve_liquidity_mint,
        );

        let accounts = klend::accounts::InitReserve {
            lending_market_owner: self.payer_pubkey(),
            lending_market: *lending_market,
            lending_market_authority,
            reserve: reserve.pubkey(),
            reserve_liquidity_mint: *reserve_liquidity_mint,
            reserve_liquidity_supply,
            fee_receiver,
            reserve_collateral_mint,
            reserve_collateral_supply,
            initial_liquidity_source,
            rent: rent::ID,
            liquidity_token_program: anchor_spl::token_interface::ID,
            collateral_token_program: anchor_spl::token::ID,
            system_program: system_program::ID,
        };

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .signer(&reserve)
            .send()?;

        self.send_and_confirm("init_reserve", signature)
    }
} 