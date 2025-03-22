use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn repay_obligation_liquidity(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    repay_reserve: &Pubkey,
    user_source_liquidity: &Pubkey,
    liquidity_amount: u64,
) -> Instruction {
    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, repay_reserve).unwrap();
    
    let repay_reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_destination_liquidity = reserve_data.liquidity.supply_vault;

    let accounts = klend::accounts::RepayObligationLiquidity {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        repay_reserve: *repay_reserve,
        repay_reserve_liquidity_mint,
        reserve_destination_liquidity,
        user_source_liquidity: *user_source_liquidity,
        token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::RepayObligationLiquidity { liquidity_amount }.data(),
    }
} 