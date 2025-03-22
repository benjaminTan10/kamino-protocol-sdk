use anchor_client::solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    pubkey::Pubkey,
};
use spl_associated_token_account::get_associated_token_address;

pub fn create_compute_budget_ix(compute_unit_limit: u32, compute_unit_price: u64) -> Vec<Instruction> {
    let mut ixs = Vec::new();
    
    if compute_unit_limit > 0 {
        ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit));
    }
    
    if compute_unit_price > 0 {
        ixs.push(ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price));
    }
    
    ixs
}

pub fn get_or_create_ata_ix(
    wallet: &Pubkey,
    mint: &Pubkey,
    payer: &Pubkey,
) -> (Pubkey, Option<Instruction>) {
    let ata = get_associated_token_address(wallet, mint);
    
    // Note: In a real implementation, you would check if the ATA exists
    // and only create it if it doesn't. For simplicity, we're returning
    // the creation instruction unconditionally.
    let create_ix = spl_associated_token_account::instruction::create_associated_token_account(
        payer,
        wallet,
        mint,
        &anchor_spl::token::ID,
    );
    
    (ata, Some(create_ix))
}

pub fn format_token_amount(amount: u64, decimals: u8) -> String {
    let decimal_factor = 10u64.pow(decimals as u32);
    let whole_part = amount / decimal_factor;
    let fractional_part = amount % decimal_factor;
    
    format!("{}.{:0width$}", whole_part, fractional_part, width = decimals as usize)
} 