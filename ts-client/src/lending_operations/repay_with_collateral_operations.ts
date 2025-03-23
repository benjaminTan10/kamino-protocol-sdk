import { KaminoAction, KaminoMarket, KaminoObligation, KaminoReserve } from '../classes';
import {
  getFlashLoanInstructions,
  SwapInputs,
  SwapQuote,
  SwapIxs,
  SwapIxsProvider,
  SwapQuoteProvider,
  getScopeRefreshIx,
  LeverageIxnsOutput,
  FlashLoanInfo,
} from '../leverage';
import {
  createAtasIdempotent,
  getComputeBudgetAndPriorityFeeIxns,
  removeBudgetAndAtaIxns,
  ScopePriceRefreshConfig,
  U64_MAX,
  uniqueAccounts,
} from '../utils';
import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { calcMaxWithdrawCollateral, calcRepayAmountWithSlippage } from './repay_with_collateral_calcs';

export type RepayWithCollIxsResponse<QuoteResponse> = {
  ixs: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  flashLoanInfo: FlashLoanInfo;
  swapInputs: SwapInputs;
  initialInputs: RepayWithCollInitialInputs<QuoteResponse>;
};

export type RepayWithCollInitialInputs<QuoteResponse> = {
  debtRepayAmountLamports: Decimal;
  flashRepayAmountLamports: Decimal;
  /**
   * The amount of collateral available to withdraw, if this is less than the swap input amount, then the swap may fail due to slippage, or tokens may be debited from the user's ATA, so the caller needs to check this
   */
  maxCollateralWithdrawLamports: Decimal;
  /**
   * The quote from the provided quoter
   */
  swapQuote: SwapQuote<QuoteResponse>;
  currentSlot: number;
  klendAccounts: Array<PublicKey>;
};

interface RepayWithCollSwapInputsProps<QuoteResponse> {
  kaminoMarket: KaminoMarket;
  debtTokenMint: PublicKey;
  collTokenMint: PublicKey;
  obligation: KaminoObligation;
  referrer: PublicKey;
  currentSlot: number;
  repayAmount: Decimal;
  isClosingPosition: boolean;
  budgetAndPriorityFeeIxs?: TransactionInstruction[];
  scopeRefreshConfig?: ScopePriceRefreshConfig;
  useV2Ixs: boolean;
  quoter: SwapQuoteProvider<QuoteResponse>;
}

export enum MaxWithdrawLtvCheck {
  MAX_LTV,
  LIQUIDATION_THRESHOLD,
}

export async function getRepayWithCollSwapInputs<QuoteResponse>({
  collTokenMint,
  currentSlot,
  debtTokenMint,
  kaminoMarket,
  obligation,
  quoter,
  referrer,
  repayAmount,
  isClosingPosition,
  budgetAndPriorityFeeIxs,
  scopeRefreshConfig,
  useV2Ixs,
}: RepayWithCollSwapInputsProps<QuoteResponse>): Promise<{
  swapInputs: SwapInputs;
  flashLoanInfo: FlashLoanInfo;
  initialInputs: RepayWithCollInitialInputs<QuoteResponse>;
}> {
  const collReserve = kaminoMarket.getReserveByMint(collTokenMint);
  const debtReserve = kaminoMarket.getReserveByMint(debtTokenMint);
  if (!collReserve) {
    throw new Error(`Collateral reserve with mint ${collTokenMint} not found in market ${kaminoMarket.getAddress()}`);
  }
  if (!debtReserve) {
    throw new Error(`Debt reserve with mint ${debtTokenMint} not found in market ${kaminoMarket.getAddress()}`);
  }

  const {
    repayAmountLamports,
    flashRepayAmountLamports,
    repayAmount: finalRepayAmount,
  } = calcRepayAmountWithSlippage(kaminoMarket, debtReserve, currentSlot, obligation, repayAmount, referrer);

  const debtPosition = obligation.getBorrowByReserve(debtReserve.address);
  const collPosition = obligation.getDepositByReserve(collReserve.address);
  if (!debtPosition) {
    throw new Error(
      `Debt position not found for ${debtReserve.stats.symbol} reserve ${debtReserve.address} in obligation ${obligation.obligationAddress}`
    );
  }
  if (!collPosition) {
    throw new Error(
      `Collateral position not found for ${collReserve.stats.symbol} reserve ${collReserve.address} in obligation ${obligation.obligationAddress}`
    );
  }
  const { withdrawableCollLamports } = calcMaxWithdrawCollateral(
    kaminoMarket,
    obligation,
    collReserve.address,
    debtReserve.address,
    repayAmountLamports
  );

  // sanity check: we have extra collateral to swap, but we want to ensure we don't quote for way more than needed and get a bad px
  const maxCollNeededFromOracle = finalRepayAmount
    .mul(debtReserve.getOracleMarketPrice())
    .div(collReserve.getOracleMarketPrice())
    .mul('1.1')
    .mul(collReserve.getMintFactor())
    .ceil();
  const inputAmountLamports = Decimal.min(withdrawableCollLamports, maxCollNeededFromOracle);

  // Build the repay & withdraw collateral tx to get the number of accounts
  const klendIxs: LeverageIxnsOutput = await buildRepayWithCollateralIxs(
    kaminoMarket,
    debtReserve,
    collReserve,
    obligation,
    referrer,
    currentSlot,
    budgetAndPriorityFeeIxs,
    scopeRefreshConfig,
    {
      preActionIxs: [],
      swapIxs: [],
      lookupTables: [],
    },
    isClosingPosition,
    repayAmountLamports,
    inputAmountLamports,
    useV2Ixs
  );
  const uniqueKlendAccounts = uniqueAccounts(klendIxs.instructions);

  const swapQuoteInputs: SwapInputs = {
    inputAmountLamports,
    inputMint: collTokenMint,
    outputMint: debtTokenMint,
    amountDebtAtaBalance: new Decimal(0), // only used for kTokens
  };

  const swapQuote = await quoter(swapQuoteInputs, uniqueKlendAccounts);

  const swapQuotePxDebtToColl = swapQuote.priceAInB;
  const collSwapInLamports = flashRepayAmountLamports
    .div(debtReserve.getMintFactor())
    .div(swapQuotePxDebtToColl)
    .mul(collReserve.getMintFactor())
    .ceil();

  return {
    swapInputs: {
      inputAmountLamports: collSwapInLamports,
      minOutAmountLamports: flashRepayAmountLamports,
      inputMint: collTokenMint,
      outputMint: debtTokenMint,
      amountDebtAtaBalance: new Decimal(0), // only used for kTokens
    },
    flashLoanInfo: klendIxs.flashLoanInfo,
    initialInputs: {
      debtRepayAmountLamports: repayAmountLamports,
      flashRepayAmountLamports,
      maxCollateralWithdrawLamports: withdrawableCollLamports,
      swapQuote,
      currentSlot,
      klendAccounts: uniqueKlendAccounts,
    },
  };
}

interface RepayWithCollIxsProps<QuoteResponse> extends RepayWithCollSwapInputsProps<QuoteResponse> {
  swapper: SwapIxsProvider<QuoteResponse>;
  logger?: (msg: string, ...extra: any[]) => void;
}

export async function getRepayWithCollIxs<QuoteResponse>({
  repayAmount,
  isClosingPosition,
  budgetAndPriorityFeeIxs,
  collTokenMint,
  currentSlot,
  debtTokenMint,
  kaminoMarket,
  obligation,
  quoter,
  swapper,
  referrer,
  scopeRefreshConfig,
  useV2Ixs,
  logger = console.log,
}: RepayWithCollIxsProps<QuoteResponse>): Promise<RepayWithCollIxsResponse<QuoteResponse>> {
  const { swapInputs, initialInputs } = await getRepayWithCollSwapInputs({
    collTokenMint,
    currentSlot,
    debtTokenMint,
    kaminoMarket,
    obligation,
    quoter,
    referrer,
    repayAmount,
    isClosingPosition,
    budgetAndPriorityFeeIxs,
    scopeRefreshConfig,
    useV2Ixs,
  });
  const { debtRepayAmountLamports, flashRepayAmountLamports, maxCollateralWithdrawLamports, swapQuote } = initialInputs;
  const { inputAmountLamports: collSwapInLamports } = swapInputs;

  const collReserve = kaminoMarket.getReserveByMint(collTokenMint);

  if (!collReserve) {
    throw new Error(`Collateral reserve with mint ${collTokenMint} not found in market ${kaminoMarket.getAddress()}`);
  }

  const debtReserve = kaminoMarket.getReserveByMint(debtTokenMint);

  if (!debtReserve) {
    throw new Error(`Debt reserve with mint ${debtTokenMint} not found in market ${kaminoMarket.getAddress()}`);
  }

  // the client should use these values to prevent this input, but the tx may succeed, so we don't want to fail
  // there is also a chance that the tx will consume debt token from the user's ata which they would not expect
  if (collSwapInLamports.greaterThan(maxCollateralWithdrawLamports)) {
    logger(
      `Collateral swap in amount ${collSwapInLamports} exceeds max withdrawable collateral ${maxCollateralWithdrawLamports}, tx may fail with slippage`
    );
    swapInputs.inputAmountLamports = maxCollateralWithdrawLamports;
  }

  const actualSwapInLamports = Decimal.min(collSwapInLamports, maxCollateralWithdrawLamports);
  logger(
    `Expected to swap in: ${actualSwapInLamports.div(collReserve.getMintFactor())} ${
      collReserve.symbol
    }, for: ${flashRepayAmountLamports.div(debtReserve.getMintFactor())} ${debtReserve.symbol}, quoter px: ${
      swapQuote.priceAInB
    } ${debtReserve.symbol}/${collReserve.symbol}, required px: ${flashRepayAmountLamports
      .div(debtReserve.getMintFactor())
      .div(actualSwapInLamports.div(collReserve.getMintFactor()))} ${debtReserve.symbol}/${collReserve.symbol}`
  );

  const swapResponse = await swapper(swapInputs, initialInputs.klendAccounts, swapQuote);
  const ixs: LeverageIxnsOutput = await buildRepayWithCollateralIxs(
    kaminoMarket,
    debtReserve,
    collReserve,
    obligation,
    referrer,
    currentSlot,
    budgetAndPriorityFeeIxs,
    scopeRefreshConfig,
    swapResponse,
    isClosingPosition,
    debtRepayAmountLamports,
    swapInputs.inputAmountLamports,
    useV2Ixs
  );

  return {
    ixs: ixs.instructions,
    lookupTables: swapResponse.lookupTables,
    swapInputs,
    flashLoanInfo: ixs.flashLoanInfo,
    initialInputs,
  };
}

async function buildRepayWithCollateralIxs(
  market: KaminoMarket,
  debtReserve: KaminoReserve,
  collReserve: KaminoReserve,
  obligation: KaminoObligation,
  referrer: PublicKey,
  currentSlot: number,
  budgetAndPriorityFeeIxs: TransactionInstruction[] | undefined,
  scopeRefreshConfig: ScopePriceRefreshConfig | undefined,
  swapQuoteIxs: SwapIxs,
  isClosingPosition: boolean,
  debtRepayAmountLamports: Decimal,
  collWithdrawLamports: Decimal,
  useV2Ixs: boolean
): Promise<LeverageIxnsOutput> {
  // 1. Create atas & budget txns
  const budgetIxns = budgetAndPriorityFeeIxs || getComputeBudgetAndPriorityFeeIxns(1_400_000);

  const atas = [
    { mint: collReserve.getLiquidityMint(), tokenProgram: collReserve.getLiquidityTokenProgram() },
    { mint: debtReserve.getLiquidityMint(), tokenProgram: debtReserve.getLiquidityTokenProgram() },
  ];

  const atasAndIxs = createAtasIdempotent(obligation.state.owner, atas);
  const [, { ata: debtTokenAta }] = atasAndIxs;

  const scopeRefreshIxn = await getScopeRefreshIx(market, collReserve, debtReserve, obligation, scopeRefreshConfig);

  // 2. Flash borrow & repay the debt to repay amount needed
  const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
    borrowIxnIndex: budgetIxns.length + atasAndIxs.length + (scopeRefreshIxn.length > 0 ? 1 : 0),
    walletPublicKey: obligation.state.owner,
    lendingMarketAuthority: market.getLendingMarketAuthority(),
    lendingMarketAddress: market.getAddress(),
    reserve: debtReserve,
    amountLamports: debtRepayAmountLamports,
    destinationAta: debtTokenAta,
    // TODO(referrals): once we support referrals, we will have to replace the placeholder args below:
    referrerAccount: market.programId,
    referrerTokenState: market.programId,
    programId: market.programId,
  });

  const requestElevationGroup = !isClosingPosition && obligation.state.elevationGroup !== 0;

  const maxWithdrawLtvCheck = getMaxWithdrawLtvCheck(obligation);

  // 3. Repay using the flash borrowed funds & withdraw collateral to swap and pay the flash loan
  let repayAndWithdrawAction;
  if (maxWithdrawLtvCheck === MaxWithdrawLtvCheck.MAX_LTV) {
    repayAndWithdrawAction = await KaminoAction.buildRepayAndWithdrawTxns(
      market,
      isClosingPosition ? U64_MAX : debtRepayAmountLamports.toString(),
      debtReserve.getLiquidityMint(),
      isClosingPosition ? U64_MAX : collWithdrawLamports.toString(),
      collReserve.getLiquidityMint(),
      obligation.state.owner,
      currentSlot,
      obligation,
      useV2Ixs,
      undefined,
      0,
      false,
      requestElevationGroup,
      undefined,
      undefined,
      referrer
    );
  } else {
    repayAndWithdrawAction = await KaminoAction.buildRepayAndWithdrawV2Txns(
      market,
      isClosingPosition ? U64_MAX : debtRepayAmountLamports.toString(),
      debtReserve.getLiquidityMint(),
      isClosingPosition ? U64_MAX : collWithdrawLamports.toString(),
      collReserve.getLiquidityMint(),
      obligation.state.owner,
      currentSlot,
      obligation,
      undefined,
      0,
      false,
      requestElevationGroup,
      undefined,
      undefined,
      referrer
    );
  }

  // 4. Swap collateral to debt to repay flash loan
  const { preActionIxs, swapIxs } = swapQuoteIxs;
  const swapInstructions = removeBudgetAndAtaIxns(swapIxs, []);

  const ixns = [
    ...scopeRefreshIxn,
    ...budgetIxns,
    ...atasAndIxs.map((x) => x.createAtaIx),
    flashBorrowIxn,
    ...preActionIxs,
    ...KaminoAction.actionToIxs(repayAndWithdrawAction),
    ...swapInstructions,
    flashRepayIxn,
  ];

  const res: LeverageIxnsOutput = {
    flashLoanInfo: {
      flashBorrowReserve: debtReserve.address,
      flashLoanFee: debtReserve.getFlashLoanFee(),
    },
    instructions: ixns,
  };

  return res;
}

export const getMaxWithdrawLtvCheck = (obligation: KaminoObligation) => {
  return obligation.refreshedStats.userTotalBorrowBorrowFactorAdjusted.gte(obligation.refreshedStats.borrowLimit)
    ? MaxWithdrawLtvCheck.LIQUIDATION_THRESHOLD
    : MaxWithdrawLtvCheck.MAX_LTV;
};
