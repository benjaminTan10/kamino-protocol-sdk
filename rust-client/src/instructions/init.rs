use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    system_program,
};
use anchor_lang::{InstructionData, ToAccountMetas};
use klend::{
    instruction::InitLendingMarket,
    state::{LendingMarket, UserMetadata},
    utils::seeds,
};

pub fn init_lending_market(
    program_id: &Pubkey,
    lending_market: &Pubkey,
    lending_market_owner: &Pubkey,
    quote_currency: [u8; 32],
) -> Instruction {
    let (lending_market_authority, _) = Pubkey::find_program_address(
        &[seeds::LENDING_MARKET_AUTH, lending_market.as_ref()],
        program_id,
    );

    let accounts = klend::accounts::InitLendingMarket {
        lending_market_owner: *lending_market_owner,
        lending_market: *lending_market,
        lending_market_authority,
        system_program: system_program::ID,
        rent: anchor_lang::solana_program::sysvar::rent::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::InitLendingMarket { quote_currency }.data(),
    }
}

pub fn init_user_metadata(
    program_id: &Pubkey,
    owner: &Pubkey,
    fee_payer: &Pubkey,
    user_lookup_table: Pubkey,
    referrer_user_metadata: Option<Pubkey>,
) -> Instruction {
    let (user_metadata, _) = Pubkey::find_program_address(
        &[seeds::BASE_SEED_USER_METADATA, owner.as_ref()],
        program_id,
    );

    let mut accounts = klend::accounts::InitUserMetadata {
        owner: *owner,
        fee_payer: *fee_payer,
        user_metadata,
        referrer_user_metadata: None,
        rent: anchor_lang::solana_program::sysvar::rent::ID,
        system_program: system_program::ID,
    };

    if let Some(referrer) = referrer_user_metadata {
        accounts.referrer_user_metadata = Some(referrer);
    }

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::InitUserMetadata { user_lookup_table }.data(),
    }
}

pub fn init_obligation(
    program_id: &Pubkey,
    obligation_owner: &Pubkey,
    fee_payer: &Pubkey,
    lending_market: &Pubkey,
    seed1_account: &Pubkey,
    seed2_account: &Pubkey,
    tag: u8,
    id: u8,
) -> Instruction {
    let seeds = &[
        &[tag],
        &[id],
        obligation_owner.as_ref(),
        lending_market.as_ref(),
        seed1_account.as_ref(),
        seed2_account.as_ref(),
    ];
    
    let (obligation, _) = Pubkey::find_program_address(seeds, program_id);
    
    let (owner_user_metadata, _) = Pubkey::find_program_address(
        &[seeds::BASE_SEED_USER_METADATA, obligation_owner.as_ref()],
        program_id,
    );

    let accounts = klend::accounts::InitObligation {
        obligation_owner: *obligation_owner,
        fee_payer: *fee_payer,
        obligation,
        lending_market: *lending_market,
        seed1_account: *seed1_account,
        seed2_account: *seed2_account,
        owner_user_metadata,
        rent: anchor_lang::solana_program::sysvar::rent::ID,
        system_program: system_program::ID,
    };

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::InitObligation { args: klend::InitObligationArgs { tag, id } }.data(),
    }
} 