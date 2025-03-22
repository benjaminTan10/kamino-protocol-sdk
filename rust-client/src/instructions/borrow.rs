use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    utils::seeds,
};

pub fn borrow_obligation_liquidity(
    program_id: &Pubkey,
    owner: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    borrow_reserve: &Pubkey,
    user_destination_liquidity: &Pubkey,
    liquidity_amount: u64,
    referrer_token_state: Option<Pubkey>,
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let reserve_data = klend::state::Reserve::load_from_pubkey(program_id, borrow_reserve).unwrap();
    
    let borrow_reserve_liquidity_mint = reserve_data.liquidity.mint_pubkey;
    let reserve_source_liquidity = reserve_data.liquidity.supply_vault;
    let borrow_reserve_liquidity_fee_receiver = reserve_data.liquidity.fee_vault;

    let mut accounts = klend::accounts::BorrowObligationLiquidity {
        owner: *owner,
        obligation: *obligation,
        lending_market: *lending_market,
        lending_market_authority,
        borrow_reserve: *borrow_reserve,
        borrow_reserve_liquidity_mint,
        reserve_source_liquidity,
        borrow_reserve_liquidity_fee_receiver,
        user_destination_liquidity: *user_destination_liquidity,
        referrer_token_state: None,
        token_program: anchor_spl::token::ID,
        instruction_sysvar_account: anchor_lang::solana_program::sysvar::instructions::ID,
    };

    if let Some(referrer) = referrer_token_state {
        accounts.referrer_token_state = Some(referrer);
    }

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::BorrowObligationLiquidity { liquidity_amount }.data(),
    }
} 