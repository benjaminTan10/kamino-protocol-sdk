# Kamino Lending SDK Typescript examples

### Table of contents

- [How to run](#how-to-run)
  - [Setup](#setup)
- [Examples](#examples)
  - [Get loan LTV](#get-loan-ltv)
  - [Get loan value (deposited/borrowed/net value)](#get-loan-value-depositedborrowednet-value)
  - [Get user loans](#get-user-loans)
  - [Get list of market reserves](#get-list-of-market-reserves)
  - [Get reserve APY (supply/borrow/rewards APY)](#get-reserve-apy-supplyborrowrewards-apy)
  - [Get reserve rewards APY](#get-reserve-rewards-apy)
  - [Get reserve APY history](#get-reserve-apy-history)
  - [Get reserve caps](#get-reserve-caps)les
  - [Get reserve total supplied and borrowed](#get-reserve-total-supplied-and-borrowed)
  - [Deposit in reserve to mint ctokens](#deposit-in-reserve-to-mint-ctokens)
  - [Burn ctokens to redeem tokens from reserve](#burn-ctokens-to-redeem-tokens-from-reserve)
  - [Deposit in obligation](#deposit-in-obligation)
  - [Borrow tokens from reserve](#borrow-from-single-reserve)
  - [Harvest farm rewards](#harvest-farm-rewards)
  - [Get obligations based on reserve filter](#get-obligations-based-on-reserve-filter)

## How to run

Make sure to define the `RPC_ENDPOINT` environment variable with your RPC URL.

### Setup

```bash
cd klend-sdk/examples
yarn install
export RPC_ENDPOINT=YOUR_RPC_URL_HERE
```

## Examples

### Get loan info deposits / borrows

```bash
yarn tsx-node ./example_loan_info.ts
```

### Get loan value (deposited/borrowed/net value)

```bash
yarn run loan-value
```

### Get loan LTV

```bash
yarn run loan-ltv
```

### Get user loans

```bash
yarn run user-loans
```

### Get list of market reserves

```bash
yarn run market-reserves
```

### Get reserve APY (supply/borrow/rewards APY)

```bash
yarn run reserve-apy
```

### Get reserve rewards APY

```bash
yarn run reserve-rewards-apy
```

### Get reserve APY history

```bash
yarn run reserve-apy-history
```

### Get reserve caps

```bash
yarn run reserve-caps
```

### Get reserve total supplied and borrowed

```bash
yarn run reserve-supply-borrow
```

### Deposit in reserve to mint ctokens

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn run deposit-mint-ctokens
```

### Burn ctokens to redeem tokens from reserve

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn run burn-ctokens-redeem
```

### Deposit in obligation

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn run deposit-obligation
```

### Borrow from single reserve
```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn run borrow-tokens
```

### Harvest farm rewards

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn run harvest-farm-reward
```

### Deposit multiply/leverage

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn multiply-deposit
```

### Withdraw multiply/leverage

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn multiply-withdraw
```

### Adjust multiply/leverage

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
yarn multiply-adjust
```

### Get multiply/leverage Loan info and PNL

```bash
yarn multiply-loan-info-and-pnl
```

### Get obligations based on reserve filter

```bash
yarn run get-obligations-based-on-reserve-filter
```

### Swap collateral from one token to another (print simulation)

```bash
export KEYPAIR_FILE=YOUR_PATH_TO_YOUR_KEYPAIR_FILE
tsx example_swap_coll_simulation.ts
```
