use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn withdraw_obligation_collateral(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    withdraw_reserve: &Pubkey,
    user_destination_collateral: &Pubkey,
    collateral_amount: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, withdraw_reserve).unwrap();
    let reserve_source_collateral = reserve_data.collateral.supply_vault;

    let accounts = klend::accounts::WithdrawObligationCollateral {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        lending_market_authority,
        withdraw_reserve: *withdraw_reserve,
        reserve_source_collateral,
        user_destination_collateral: *user_destination_collateral,
        token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::WithdrawObligationCollateral { collateral_amount }.data(),
    }
}

pub fn withdraw_obligation_collateral_and_redeem_reserve_collateral(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    withdraw_reserve: &Pubkey,
    user_destination_liquidity: &Pubkey,
    collateral_amount: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, withdraw_reserve).unwrap();
    
    let withdraw_reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
    let withdraw_reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_source_collateral = reserve_data.collateral.supply_vault;
    let reserve_destination_liquidity = reserve_data.liquidity.supply_vault;
    let user_destination_collateral = Pubkey::find_associated_token_address(
        owner,
        &withdraw_reserve_collateral_mint,
    );

    let accounts = klend::accounts::WithdrawObligationCollateralAndRedeemReserveCollateral {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        lending_market_authority,
        withdraw_reserve: *withdraw_reserve,
        withdraw_reserve_collateral_mint,
        withdraw_reserve_liquidity_mint,
        reserve_source_collateral,
        user_destination_collateral,
        reserve_destination_liquidity,
        user_destination_liquidity: *user_destination_liquidity,
        collateral_token_program: anchor_spl::token::ID,
        liquidity_token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::WithdrawObligationCollateralAndRedeemReserveCollateral { 
            collateral_amount,
            ltv_max_withdrawal_check: klend::LtvMaxWithdrawalCheck::LiquidationThreshold,
        }.data(),
    }
} 