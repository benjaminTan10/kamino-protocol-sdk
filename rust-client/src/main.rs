use anyhow::Result;
use clap::{Parser, Subcommand};
use klend_client::{KlendClient, klend};
use solana_sdk::{
    signature::{read_keypair_file, Keypair},
    pubkey::Pubkey,
};
use std::str::FromStr;

#[derive(Parser)]
#[clap(author, version, about)]
struct Cli {
    #[clap(short, long, default_value = "https://api.mainnet-beta.solana.com")]
    rpc_url: String,
    
    #[clap(short, long)]
    keypair_path: String,
    
    #[clap(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new lending market
    InitLendingMarket {
        #[clap(long)]
        quote_currency: String,
    },
    
    /// Initialize a new reserve
    InitReserve {
        #[clap(long)]
        lending_market: String,
        
        #[clap(long)]
        liquidity_mint: String,
        
        #[clap(long)]
        liquidity_amount: u64,
    },
    
    /// Initialize a new obligation
    InitObligation {
        #[clap(long)]
        lending_market: String,
        
        #[clap(long)]
        owner: Option<String>,
        
        #[clap(long, default_value = "0")]
        tag: u8,
        
        #[clap(long, default_value = "0")]
        id: u8,
        
        #[clap(long)]
        seed1: Option<String>,
        
        #[clap(long)]
        seed2: Option<String>,
    },
    
    /// Deposit liquidity into a reserve
    DepositReserveLiquidity {
        #[clap(long)]
        reserve: String,
        
        #[clap(long)]
        amount: u64,
    },
    
    /// Borrow liquidity from a reserve
    BorrowObligationLiquidity {
        #[clap(long)]
        obligation: String,
        
        #[clap(long)]
        reserve: String,
        
        #[clap(long)]
        amount: u64,
    },
    
    /// Repay borrowed liquidity
    RepayObligationLiquidity {
        #[clap(long)]
        obligation: String,
        
        #[clap(long)]
        reserve: String,
        
        #[clap(long)]
        amount: u64,
    },
    
    /// Refresh a reserve
    RefreshReserve {
        #[clap(long)]
        reserve: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    
    let keypair = read_keypair_file(&cli.keypair_path)?;
    let client = KlendClient::new(&cli.rpc_url, keypair);
    
    match cli.command {
        Commands::InitLendingMarket { quote_currency } => {
            let quote_currency_bytes = if quote_currency.len() <= 32 {
                let mut bytes = [0u8; 32];
                bytes[..quote_currency.len()].copy_from_slice(quote_currency.as_bytes());
                bytes
            } else {
                return Err(anyhow::anyhow!("Quote currency string too long"));
            };
            
            let signature = client.init_lending_market(quote_currency_bytes)?;
            println!("Initialized lending market: {}", signature);
        },
        
        Commands::InitReserve { lending_market, liquidity_mint, liquidity_amount } => {
            let lending_market = Pubkey::from_str(&lending_market)?;
            let liquidity_mint = Pubkey::from_str(&liquidity_mint)?;
            
            let signature = client.init_reserve(&lending_market, &liquidity_mint, liquidity_amount)?;
            println!("Initialized reserve: {}", signature);
        },
        
        Commands::InitObligation { lending_market, owner, tag, id, seed1, seed2 } => {
            let lending_market = Pubkey::from_str(&lending_market)?;
            let owner = match owner {
                Some(owner) => Pubkey::from_str(&owner)?,
                None => client.payer_pubkey(),
            };
            
            let seed1 = match seed1 {
                Some(seed) => Pubkey::from_str(&seed)?,
                None => Pubkey::default(),
            };
            
            let seed2 = match seed2 {
                Some(seed) => Pubkey::from_str(&seed)?,
                None => Pubkey::default(),
            };
            
            let signature = client.init_obligation(&lending_market, &owner, tag, id, &seed1, &seed2)?;
            println!("Initialized obligation: {}", signature);
        },
        
        Commands::DepositReserveLiquidity { reserve, amount } => {
            let reserve = Pubkey::from_str(&reserve)?;
            
            let signature = client.deposit_reserve_liquidity(&reserve, amount)?;
            println!("Deposited liquidity: {}", signature);
        },
        
        Commands::BorrowObligationLiquidity { obligation, reserve, amount } => {
            let obligation = Pubkey::from_str(&obligation)?;
            let reserve = Pubkey::from_str(&reserve)?;
            
            let signature = client.borrow_obligation_liquidity(&obligation, &reserve, amount)?;
            println!("Borrowed liquidity: {}", signature);
        },
        
        Commands::RepayObligationLiquidity { obligation, reserve, amount } => {
            let obligation = Pubkey::from_str(&obligation)?;
            let reserve = Pubkey::from_str(&reserve)?;
            
            let signature = client.repay_obligation_liquidity(&obligation, &reserve, amount)?;
            println!("Repaid liquidity: {}", signature);
        },
        
        Commands::RefreshReserve { reserve } => {
            let reserve = Pubkey::from_str(&reserve)?;
            
            let signature = client.refresh_reserve(&reserve)?;
            println!("Refreshed reserve: {}", signature);
        },
    }
    
    Ok(())
}
