use crate::KlendClient;
use anchor_client::solana_sdk::{instruction::Instruction, pubkey::Pubkey, signature::Signature};
use anchor_lang::prelude::*;
use anyhow::Result;
use klend::{self, MaxReservesAsCollateralCheck};

impl KlendClient {
    pub fn refresh_reserve(&self, reserve: &Pubkey) -> Result<Signature> {
        let reserve_data = self.program().account::<klend::Reserve>(*reserve)?;
        let lending_market = reserve_data.lending_market;
        let token_info = reserve_data.config.token_info;

        // Determine which price oracles to include based on token_info
        let pyth_oracle = token_info.pyth_oracle;
        let switchboard_price_oracle = token_info.switchboard_price_oracle;
        let switchboard_twap_oracle = token_info.switchboard_twap_oracle;
        let scope_prices = token_info.scope_price_id;

        let mut accounts = klend::accounts::RefreshReserve {
            reserve: *reserve,
            lending_market,
            pyth_oracle: None,
            switchboard_price_oracle: None,
            switchboard_twap_oracle: None,
            scope_prices: None,
        };

        // Add the price oracles that are configured
        if pyth_oracle != Pubkey::default() {
            accounts.pyth_oracle = Some(pyth_oracle);
        }
        if switchboard_price_oracle != Pubkey::default() {
            accounts.switchboard_price_oracle = Some(switchboard_price_oracle);
        }
        if switchboard_twap_oracle != Pubkey::default() {
            accounts.switchboard_twap_oracle = Some(switchboard_twap_oracle);
        }
        if scope_prices != Pubkey::default() {
            accounts.scope_prices = Some(scope_prices);
        }

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::RefreshReserve {})
            .send()?;

        self.send_and_confirm("refresh_reserve", signature)
    }

    pub fn refresh_obligation(
        &self,
        obligation: &Pubkey,
        deposit_reserves: &[Pubkey],
        borrow_reserves: &[Pubkey],
    ) -> Result<Signature> {
        let obligation_data = self.program().account::<klend::Obligation>(*obligation)?;
        let lending_market = obligation_data.lending_market;

        let accounts = klend::accounts::RefreshObligation {
            obligation: *obligation,
            lending_market,
        };

        // Combine deposit and borrow reserves for remaining accounts
        let mut remaining_accounts = Vec::new();
        for reserve in deposit_reserves.iter().chain(borrow_reserves.iter()) {
            remaining_accounts.push(AccountMeta::new(*reserve, false));
        }

        let signature = self
            .program()
            .request()
            .accounts(accounts)
            .args(klend::instruction::RefreshObligation {
                max_reserves_as_collateral_check: MaxReservesAsCollateralCheck::Perform,
            })
            .accounts(remaining_accounts)
            .send()?;

        self.send_and_confirm("refresh_obligation", signature)
    }
} 