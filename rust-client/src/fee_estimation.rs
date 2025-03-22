pub const DEFAULT_SIGNATURE_FEE: u64 = 5000;
pub const DEFAULT_COMPUTE_UNIT_LIMIT: u64 = 200_000;
pub const DEFAULT_COMPUTE_UNIT_PRICE: u64 = 1_000;

pub fn estimate_transaction_fee(num_signatures: usize, compute_unit_price: Option<u64>) -> u64 {
    let signature_fee = (num_signatures as u64) * DEFAULT_SIGNATURE_FEE;
    let compute_unit_price = compute_unit_price.unwrap_or(DEFAULT_COMPUTE_UNIT_PRICE);
    let compute_budget_fee = DEFAULT_COMPUTE_UNIT_LIMIT * compute_unit_price;
    
    signature_fee + compute_budget_fee
} 