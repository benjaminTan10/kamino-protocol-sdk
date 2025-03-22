use anchor_client::solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
};
use anchor_lang::{InstructionData, ToAccountMetas};

pub fn refresh_reserve(
    program_id: &Pubkey,
    reserve: &Pubkey,
    lending_market: &Pubkey,
    pyth_oracle: Option<&Pubkey>,
    switchboard_price_oracle: Option<&Pubkey>,
    switchboard_twap_oracle: Option<&Pubkey>,
    scope_prices: Option<&Pubkey>,
) -> Instruction {
    let mut accounts = klend::accounts::RefreshReserve {
        reserve: *reserve,
        lending_market: *lending_market,
        pyth_oracle: None,
        switchboard_price_oracle: None,
        switchboard_twap_oracle: None,
        scope_prices: None,
    };

    if let Some(oracle) = pyth_oracle {
        accounts.pyth_oracle = Some(*oracle);
    }

    if let Some(oracle) = switchboard_price_oracle {
        accounts.switchboard_price_oracle = Some(*oracle);
    }

    if let Some(oracle) = switchboard_twap_oracle {
        accounts.switchboard_twap_oracle = Some(*oracle);
    }

    if let Some(oracle) = scope_prices {
        accounts.scope_prices = Some(*oracle);
    }

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::RefreshReserve {}.data(),
    }
}

pub fn refresh_obligation(
    program_id: &Pubkey,
    obligation: &Pubkey,
    lending_market: &Pubkey,
    deposit_reserves: &[Pubkey],
    borrow_reserves: &[Pubkey],
    referrer_token_states: &[Pubkey],
) -> Instruction {
    let accounts = klend::accounts::RefreshObligation {
        lending_market: *lending_market,
        obligation: *obligation,
    };

    let mut remaining_accounts = Vec::new();
    
    // Add deposit reserves
    for reserve in deposit_reserves {
        remaining_accounts.push(anchor_lang::solana_program::instruction::AccountMeta {
            pubkey: *reserve,
            is_signer: false,
            is_writable: false,
        });
    }
    
    // Add borrow reserves
    for reserve in borrow_reserves {
        remaining_accounts.push(anchor_lang::solana_program::instruction::AccountMeta {
            pubkey: *reserve,
            is_signer: false,
            is_writable: false,
        });
    }
    
    // Add referrer token states if any
    for state in referrer_token_states {
        remaining_accounts.push(anchor_lang::solana_program::instruction::AccountMeta {
            pubkey: *state,
            is_signer: false,
            is_writable: false,
        });
    }

    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: klend::instruction::RefreshObligation {
            max_reserves_as_collateral_check: klend::MaxReservesAsCollateralCheck::Perform,
        }.data(),
    }
} 