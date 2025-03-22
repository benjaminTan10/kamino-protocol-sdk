use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn redeem_reserve_collateral(
    program_id: &Pubkey,
    owner: &Pubkey,
    lending_market: &Pubkey,
    reserve: &Pubkey,
    user_source_collateral: &Pubkey,
    user_destination_liquidity: &Pubkey,
    collateral_amount: u64,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, reserve).unwrap();
    
    let reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_collateral_mint = reserve_data.collateral.mint_pubkey;
    let reserve_liquidity_supply = reserve_data.liquidity.supply_vault;

    let accounts = klend::accounts::RedeemReserveCollateral {
        owner: *owner,
        lending_market: *lending_market,
        reserve: *reserve,
        lending_market_authority,
        reserve_liquidity_mint,
        reserve_collateral_mint,
        reserve_liquidity_supply,
        user_source_collateral: *user_source_collateral,
        user_destination_liquidity: *user_destination_liquidity,
        collateral_token_program: anchor_spl::token::ID,
        liquidity_token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::RedeemReserveCollateral { collateral_amount }.data(),
    }
} 