use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn deposit_reserve_liquidity(
    program_id: &Pubkey,
    owner: &Pubkey,
    reserve: &Pubkey,
    lending_market: &Pubkey,
    user_source_liquidity: &Pubkey,
    user_destination_collateral: &Pubkey,
    liquidity_amount: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    // These accounts would typically be loaded from the reserve state
    // For simplicity, we're assuming they would be passed in or derived
    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, reserve).unwrap();
    
    let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;
    let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;

    let accounts = klend::accounts::DepositReserveLiquidity {
        owner: *owner,
        reserve: *reserve,
        lending_market: *lending_market,
        lending_market_authority,
        reserve_liquidity_mint,
        reserve_liquidity_supply,
        reserve_collateral_mint,
        user_source_liquidity: *user_source_liquidity,
        user_destination_collateral: *user_destination_collateral,
        collateral_token_program: anchor_spl::token::ID,
        liquidity_token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::DepositReserveLiquidity { liquidity_amount }.data(),
    }
}

pub fn deposit_obligation_collateral(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    deposit_reserve: &Pubkey,
    user_source_collateral: &Pubkey,
    collateral_amount: u64,
) -> Instruction {
    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, deposit_reserve).unwrap();
    let reserve_destination_collateral = reserve_data.collateral.supply_vault;

    let accounts = klend::accounts::DepositObligationCollateral {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        deposit_reserve: *deposit_reserve,
        reserve_destination_collateral,
        user_source_collateral: *user_source_collateral,
        token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::DepositObligationCollateral { collateral_amount }.data(),
    }
}

pub fn deposit_reserve_liquidity_and_obligation_collateral(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    reserve: &Pubkey,
    user_source_liquidity: &Pubkey,
    liquidity_amount: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, reserve).unwrap();
    
    let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;
    let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
    let reserve_destination_deposit_collateral = reserve_data.collateral.supply_vault;

    let accounts = klend::accounts::DepositReserveLiquidityAndObligationCollateral {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        lending_market_authority,
        reserve: *reserve,
        reserve_liquidity_mint,
        reserve_liquidity_supply,
        reserve_collateral_mint,
        reserve_destination_deposit_collateral,
        user_source_liquidity: *user_source_liquidity,
        placeholder_user_destination_collateral: None,
        collateral_token_program: anchor_spl::token::ID,
        liquidity_token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::DepositReserveLiquidityAndObligationCollateral { liquidity_amount }.data(),
    }
} 