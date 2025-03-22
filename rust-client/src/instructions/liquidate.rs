use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn liquidate_obligation_and_redeem_reserve_collateral(
    program_id: &Pubkey,
    liquidator: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    repay_reserve: &Pubkey,
    withdraw_reserve: &Pubkey,
    user_source_liquidity: &Pubkey,
    user_destination_collateral: &Pubkey,
    user_destination_liquidity: &Pubkey,
    liquidity_amount: u64,
    min_acceptable_received_liquidity_amount: u64,
    max_allowed_ltv_override_percent: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let repay_reserve_data = klend::state::Reserve::load_from_pubkey(program_id, repay_reserve).unwrap();
    let withdraw_reserve_data = klend::state::Reserve::load_from_pubkey(program_id, withdraw_reserve).unwrap();
    
    let repay_reserve_liquidity_mint = repay_reserve_data.liquidity.mint_pubkey;
    let repay_reserve_liquidity_supply = repay_reserve_data.liquidity.supply_vault;
    
    let withdraw_reserve_liquidity_mint = withdraw_reserve_data.liquidity.mint_pubkey;
    let withdraw_reserve_collateral_mint = withdraw_reserve_data.collateral.mint_pubkey;
    let withdraw_reserve_collateral_supply = withdraw_reserve_data.collateral.supply_vault;
    let withdraw_reserve_liquidity_supply = withdraw_reserve_data.liquidity.supply_vault;
    let withdraw_reserve_liquidity_fee_receiver = withdraw_reserve_data.liquidity.fee_vault;

    let accounts = klend::accounts::LiquidateObligationAndRedeemReserveCollateral {
        liquidator: *liquidator,
        obligation: *obligation,
        lending_market: *lending_market,
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
        user_source_liquidity: *user_source_liquidity,
        user_destination_collateral: *user_destination_collateral,
        user_destination_liquidity: *user_destination_liquidity,
        collateral_token_program: anchor_spl::token::ID,
        repay_liquidity_token_program: anchor_spl::token::ID,
        withdraw_liquidity_token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::LiquidateObligationAndRedeemReserveCollateral { 
            liquidity_amount,
            min_acceptable_received_liquidity_amount,
            max_allowed_ltv_override_percent,
        }.data(),
    }
} 