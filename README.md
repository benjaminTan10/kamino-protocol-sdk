# KLend Client Libraries

This repository contains client libraries for interacting with the KLend lending protocol on Solana. It includes both Rust and TypeScript implementations, as well as the core lending program.

## Repository Structure
- **rust-client**: Rust implementation of the KLend client
- **ts-client**: TypeScript implementation of the KLend client
- **programs/klend**: The core KLend lending program

## Rust Client
The Rust client provides a programmatic way to interact with the KLend protocol from Rust applications. It's built using the Anchor framework and provides methods for all the core lending operations.

### Features
- Initialize lending markets and reserves
- Deposit and withdraw collateral
- Borrow and repay loans
- Liquidate underwater positions
- Refresh obligations and reserves

## TypeScript Client
The TypeScript client provides a JavaScript/TypeScript interface for interacting with the KLend protocol. It's designed for use in web applications and Node.js environments.

### Features
- Full support for all KLend operations
- Examples for common lending operations
- Support for multiply (leveraged) positions
- Fee estimation and transaction building utilities

### Usage Example
```
import {
  KaminoAction,
  PROGRAM_ID,
  buildVersionedTransaction,
  sendAndConfirmVersionedTransaction,
} from '@kamino-finance/klend-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';

// Initialize connection
const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.generate();

// Deposit collateral
const depositAction = await KaminoAction.buildDepositTxns(
  market,
  new BN('1000000000'), // 1 USDC
  usdcReserve.address,
  wallet.publicKey
);

const tx = await buildVersionedTransaction(connection, wallet.publicKey, [
  ...depositAction.setupIxs,
  ...depositAction.lendingIxs,
  ...depositAction.cleanupIxs,
]);

tx.sign([wallet]);
const txHash = await sendAndConfirmVersionedTransaction(connection, tx, 'processed');

```

## Core Program
The programs/klend directory contains the core Solana program that implements the KLend lending protocol. This is the on-chain code that the client libraries interact with.

### Key Features
- Lending markets and reserves
- Collateralized borrowing
- Interest rate models
- Liquidation mechanisms
- Flash loans
- Referral system

## Development

### Prerequisites
- Rust 1.70+ with Solana BPF toolchain
- Node.js 16+ and npm/yarn
- Solana CLI tools

### Building

```
# Build the Rust client
cd rust-client
cargo build

# Build the TypeScript client
cd ts-client
npm install
npm run build
```