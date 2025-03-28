/* eslint-disable max-classes-per-file */
import {
  AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import Decimal from 'decimal.js';
import {
  INITIAL_COLLATERAL_RATE,
  lendingMarketAuthPda,
  MarketWithAddress,
  MIN_INITIAL_DEPOSIT,
  ONE_HUNDRED_PCT_IN_BPS,
  reservePdas,
  SLOTS_PER_DAY,
  SLOTS_PER_SECOND,
  SLOTS_PER_YEAR,
  TokenOracleData,
  U64_MAX,
} from '../utils';
import { FeeCalculation, Fees, ReserveDataType, ReserveFarmInfo, ReserveRewardYield, ReserveStatus } from './shared';
import { Reserve, ReserveFields } from '../idl_codegen/accounts';
import { BorrowRateCurve, CurvePointFields, ReserveConfig, UpdateConfigMode } from '../idl_codegen/types';
import {
  assertNever,
  calculateAPYFromAPR,
  getBorrowRate,
  lamportsToNumberDecimal,
  parseTokenSymbol,
  positiveOrZero,
  sameLengthArrayEquals,
} from './utils';
import { Fraction } from './fraction';
import BN from 'bn.js';
import { ActionType } from './action';
import { BorrowCapsAndCounters, ElevationGroupDescription, KaminoMarket } from './market';
import {
  initReserve,
  InitReserveAccounts,
  updateReserveConfig,
  UpdateReserveConfigAccounts,
  UpdateReserveConfigArgs,
} from '../lib';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { UpdateBorrowRateCurve } from '../idl_codegen/types/UpdateConfigMode';
import { aprToApy, KaminoPrices } from '@kamino-finance/kliquidity-sdk';
import { FarmState, RewardInfo } from '@kamino-finance/farms-sdk';

export const DEFAULT_RECENT_SLOT_DURATION_MS = 450;

export class KaminoReserve {
  state: Reserve;
  address: PublicKey;
  symbol: string;

  tokenOraclePrice: TokenOracleData;
  stats: ReserveDataType;
  private farmData: ReserveFarmInfo = { fetched: false, farmStates: [] };

  private buffer: AccountInfo<Buffer> | null;
  private connection: Connection;
  private readonly recentSlotDurationMs: number;

  constructor(
    state: Reserve,
    address: PublicKey,
    tokenOraclePrice: TokenOracleData,
    connection: Connection,
    recentSlotDurationMs: number
  ) {
    this.state = state;
    this.address = address;
    this.buffer = null;
    this.tokenOraclePrice = tokenOraclePrice;
    this.stats = {} as ReserveDataType;
    this.connection = connection;
    this.symbol = parseTokenSymbol(state.config.tokenInfo.name);
    this.recentSlotDurationMs = recentSlotDurationMs;
  }

  static initialize(
    accountData: AccountInfo<Buffer>,
    address: PublicKey,
    state: Reserve,
    tokenOraclePrice: TokenOracleData,
    connection: Connection,
    recentSlotDurationMs: number
  ) {
    const reserve = new KaminoReserve(state, address, tokenOraclePrice, connection, recentSlotDurationMs);
    reserve.setBuffer(accountData);
    reserve.stats = reserve.formatReserveData(state);
    return reserve;
  }

  /// GETTERS

  /**
   * @returns the parsed token symbol of the reserve
   */
  getTokenSymbol(): string {
    return parseTokenSymbol(this.state.config.tokenInfo.name);
  }

  /**
   * @returns the total borrowed amount of the reserve in lamports
   */
  getBorrowedAmount(): Decimal {
    return new Fraction(this.state.liquidity.borrowedAmountSf).toDecimal();
  }

  /**
   * @returns the available liquidity amount of the reserve in lamports
   */
  getLiquidityAvailableAmount(): Decimal {
    return new Decimal(this.state.liquidity.availableAmount.toString());
  }

  /**
   *
   * @returns the last cached price stored in the reserve in USD
   */
  getReserveMarketPrice(): Decimal {
    return new Fraction(this.state.liquidity.marketPriceSf).toDecimal();
  }

  /**
   * @returns the current market price of the reserve in USD
   */
  getOracleMarketPrice(): Decimal {
    return this.tokenOraclePrice.price;
  }

  /**
   * @returns the total accumulated protocol fees of the reserve
   */
  getAccumulatedProtocolFees(): Decimal {
    return new Fraction(this.state.liquidity.accumulatedProtocolFeesSf).toDecimal();
  }

  /**
   * @returns the total accumulated referrer fees of the reserve
   */
  getAccumulatedReferrerFees(): Decimal {
    return new Fraction(this.state.liquidity.accumulatedReferrerFeesSf).toDecimal();
  }

  /**
   * @returns the total pending referrer fees of the reserve
   */
  getPendingReferrerFees(): Decimal {
    return new Fraction(this.state.liquidity.pendingReferrerFeesSf).toDecimal();
  }

  /**
   *
   * @returns the flash loan fee percentage of the reserve
   */
  getFlashLoanFee = (): Decimal => {
    if (this.state.config.fees.flashLoanFeeSf.toString() === U64_MAX) {
      return new Decimal('0');
    }
    return new Fraction(this.state.config.fees.flashLoanFeeSf).toDecimal();
  };

  /**
   *
   * @returns the origination fee percentage of the reserve
   */
  getBorrowFee = (): Decimal => {
    return new Fraction(this.state.config.fees.borrowFeeSf).toDecimal();
  };

  /**
   *
   * @returns the fixed interest rate allocated to the host
   */
  getFixedHostInterestRate = (): Decimal => {
    return new Decimal(this.state.config.hostFixedInterestRateBps).div(10_000);
  };

  /**
   * Use getEstimatedTotalSupply() for the most accurate value
   * @returns the stale total liquidity supply of the reserve from the last refresh
   */
  getTotalSupply(): Decimal {
    return this.getLiquidityAvailableAmount()
      .add(this.getBorrowedAmount())
      .sub(this.getAccumulatedProtocolFees())
      .sub(this.getAccumulatedReferrerFees())
      .sub(this.getPendingReferrerFees());
  }

  /**
   * Calculates the total liquidity supply of the reserve
   */
  getEstimatedTotalSupply(slot: number, referralFeeBps: number): Decimal {
    const { totalSupply } = this.getEstimatedDebtAndSupply(slot, referralFeeBps);
    return totalSupply;
  }

  /**
   * Use getEstimatedCumulativeBorrowRate() for the most accurate value
   * @returns the stale cumulative borrow rate of the reserve from the last refresh
   */
  getCumulativeBorrowRate(): Decimal {
    const cumulativeBorrowRateBsf = this.state.liquidity.cumulativeBorrowRateBsf.value;
    const accSf = cumulativeBorrowRateBsf.reduce((prev, curr, i) => prev.add(curr.shln(i * 64)), new BN(0));
    return new Fraction(accSf).toDecimal();
  }

  /**
   * @Returns estimated cumulative borrow rate of the reserve
   */
  getEstimatedCumulativeBorrowRate(currentSlot: number, referralFeeBps: number): Decimal {
    const currentBorrowRate = new Decimal(this.calculateBorrowAPR(currentSlot, referralFeeBps));
    const slotsElapsed = Math.max(currentSlot - this.state.lastUpdate.slot.toNumber(), 0);

    const compoundInterest = this.approximateCompoundedInterest(currentBorrowRate, slotsElapsed);

    const previousCumulativeBorrowRate = this.getCumulativeBorrowRate();

    return previousCumulativeBorrowRate.mul(compoundInterest);
  }

  /**
   * Use getEstimatedCollateralExchangeRate() for the most accurate value
   * @returns the stale exchange rate between the collateral tokens and the liquidity - this is a decimal number scaled by 1e18
   */
  getCollateralExchangeRate(): Decimal {
    const totalSupply = this.getTotalSupply();
    const mintTotalSupply = this.state.collateral.mintTotalSupply;
    if (mintTotalSupply.isZero() || totalSupply.isZero()) {
      return INITIAL_COLLATERAL_RATE;
    } else {
      return new Decimal(mintTotalSupply.toString()).dividedBy(totalSupply.toString());
    }
  }

  /**
   *
   * @returns the estimated exchange rate between the collateral tokens and the liquidity - this is a decimal number scaled by 1e18
   */
  getEstimatedCollateralExchangeRate(slot: number, referralFeeBps: number): Decimal {
    const totalSupply = this.getEstimatedTotalSupply(slot, referralFeeBps);
    const mintTotalSupply = this.state.collateral.mintTotalSupply;
    if (mintTotalSupply.isZero() || totalSupply.isZero()) {
      return INITIAL_COLLATERAL_RATE;
    } else {
      return new Decimal(mintTotalSupply.toString()).dividedBy(totalSupply.toString());
    }
  }

  /**
   *
   * @returns the total USD value of the existing collateral in the reserve
   */
  getDepositTvl = (): Decimal => {
    return new Decimal(this.getTotalSupply().toString()).mul(this.getOracleMarketPrice()).div(this.getMintFactor());
  };

  /**
   *
   * Get the total USD value of the borrowed assets from the reserve
   */
  getBorrowTvl = (): Decimal => {
    return this.getBorrowedAmount().mul(this.getOracleMarketPrice()).div(this.getMintFactor());
  };

  /**
   * @returns 10^mint_decimals
   */
  getMintFactor(): Decimal {
    return new Decimal(10).pow(this.state.liquidity.mintDecimals.toNumber());
  }

  /**
   * @Returns true if the total liquidity supply of the reserve is greater than the deposit limit
   */
  depositLimitCrossed(): boolean {
    return this.getTotalSupply().gt(new Decimal(this.state.config.depositLimit.toString()));
  }

  /**
   * @Returns true if the total borrowed amount of the reserve is greater than the borrow limit
   */
  borrowLimitCrossed(): boolean {
    return this.getBorrowedAmount().gt(new Decimal(this.state.config.borrowLimit.toString()));
  }

  /**
   *
   * @returns the max capacity of the daily deposit withdrawal cap
   */
  getDepositWithdrawalCapCapacity(): Decimal {
    return new Decimal(this.state.config.depositWithdrawalCap.configCapacity.toString());
  }

  /**
   *
   * @returns the current capacity of the daily deposit withdrawal cap
   */
  getDepositWithdrawalCapCurrent(slot: number): Decimal {
    const slotsElapsed = Math.max(slot - this.state.lastUpdate.slot.toNumber(), 0);
    if (slotsElapsed > SLOTS_PER_DAY) {
      return new Decimal(0);
    } else {
      return new Decimal(this.state.config.depositWithdrawalCap.currentTotal.toString());
    }
  }

  /**
   *
   * @returns the max capacity of the daily debt withdrawal cap
   */
  getDebtWithdrawalCapCapacity(): Decimal {
    return new Decimal(this.state.config.debtWithdrawalCap.configCapacity.toString());
  }

  /**
   *
   * @returns the borrow limit of the reserve outside the elevation group
   */
  getBorrowLimitOutsideElevationGroup(): Decimal {
    return new Decimal(this.state.config.borrowLimitOutsideElevationGroup.toString());
  }

  /**
   *
   * @returns the borrowed amount of the reserve outside the elevation group
   */
  getBorrowedAmountOutsideElevationGroup(): Decimal {
    return new Decimal(this.state.borrowedAmountOutsideElevationGroup.toString());
  }

  /**
   *
   * @returns the borrow limit against the collateral reserve in the elevation group
   */
  getBorrowLimitAgainstCollateralInElevationGroup(elevationGroupIndex: number): Decimal {
    return new Decimal(
      this.state.config.borrowLimitAgainstThisCollateralInElevationGroup[elevationGroupIndex].toString()
    );
  }

  /**
   *
   * @returns the borrowed amount against the collateral reserve in the elevation group
   */
  getBorrowedAmountAgainstCollateralInElevationGroup(elevationGroupIndex: number): Decimal {
    return new Decimal(this.state.borrowedAmountsAgainstThisReserveInElevationGroups[elevationGroupIndex].toString());
  }

  /**
   *
   * @returns the current capacity of the daily debt withdrawal cap
   */
  getDebtWithdrawalCapCurrent(slot: number): Decimal {
    const slotsElapsed = Math.max(slot - this.state.lastUpdate.slot.toNumber(), 0);
    if (slotsElapsed > SLOTS_PER_DAY) {
      return new Decimal(0);
    } else {
      return new Decimal(this.state.config.debtWithdrawalCap.currentTotal.toString());
    }
  }

  getBorrowFactor(): Decimal {
    return new Decimal(this.state.config.borrowFactorPct.toString()).div(100);
  }

  calculateSupplyAPR(slot: number, referralFeeBps: number) {
    const currentUtilization = this.calculateUtilizationRatio();

    const borrowRate = this.calculateEstimatedBorrowRate(slot, referralFeeBps);
    const protocolTakeRatePct = 1 - this.state.config.protocolTakeRatePct / 100;
    return currentUtilization * borrowRate * protocolTakeRatePct;
  }

  getEstimatedDebtAndSupply(slot: number, referralFeeBps: number): { totalBorrow: Decimal; totalSupply: Decimal } {
    const slotsElapsed = Math.max(slot - this.state.lastUpdate.slot.toNumber(), 0);
    let totalBorrow: Decimal;
    let totalSupply: Decimal;
    if (slotsElapsed === 0) {
      totalBorrow = this.getBorrowedAmount();
      totalSupply = this.getTotalSupply();
    } else {
      const { newDebt, newAccProtocolFees, pendingReferralFees } = this.compoundInterest(slotsElapsed, referralFeeBps);
      const newTotalSupply = this.getLiquidityAvailableAmount()
        .add(newDebt)
        .sub(newAccProtocolFees)
        .sub(this.getAccumulatedReferrerFees())
        .sub(pendingReferralFees);
      totalBorrow = newDebt;
      totalSupply = newTotalSupply;
    }
    return { totalBorrow, totalSupply };
  }

  getEstimatedAccumulatedProtocolFees(
    slot: number,
    referralFeeBps: number
  ): { accumulatedProtocolFees: Decimal; compoundedVariableProtocolFee: Decimal; compoundedFixedHostFee: Decimal } {
    const slotsElapsed = Math.max(slot - this.state.lastUpdate.slot.toNumber(), 0);
    let accumulatedProtocolFees: Decimal;
    let compoundedVariableProtocolFee: Decimal;
    let compoundedFixedHostFee: Decimal;
    if (slotsElapsed === 0) {
      accumulatedProtocolFees = this.getAccumulatedProtocolFees();
      compoundedVariableProtocolFee = new Decimal(0);
      compoundedFixedHostFee = new Decimal(0);
    } else {
      const { newAccProtocolFees, variableProtocolFee, fixedHostFee } = this.compoundInterest(
        slotsElapsed,
        referralFeeBps
      );
      accumulatedProtocolFees = newAccProtocolFees;
      compoundedVariableProtocolFee = variableProtocolFee;
      compoundedFixedHostFee = fixedHostFee;
    }
    return { accumulatedProtocolFees, compoundedVariableProtocolFee, compoundedFixedHostFee };
  }

  calculateUtilizationRatio(): number {
    const totalBorrows = this.getBorrowedAmount();
    const totalSupply = this.getTotalSupply();
    if (totalSupply.eq(0)) {
      return 0;
    }
    return totalBorrows.dividedBy(totalSupply).toNumber();
  }

  getEstimatedUtilizationRatio(slot: number, referralFeeBps: number): number {
    const { totalBorrow: estimatedTotalBorrowed, totalSupply: estimatedTotalSupply } = this.getEstimatedDebtAndSupply(
      slot,
      referralFeeBps
    );
    if (estimatedTotalSupply.eq(0)) {
      return 0;
    }

    return estimatedTotalBorrowed.dividedBy(estimatedTotalSupply).toNumber();
  }

  calcSimulatedUtilizationRatio(
    amount: Decimal,
    action: ActionType,
    slot: number,
    referralFeeBps: number,
    outflowAmount?: Decimal
  ): number {
    const { totalBorrow: previousTotalBorrowed, totalSupply: previousTotalSupply } = this.getEstimatedDebtAndSupply(
      slot,
      referralFeeBps
    );

    switch (action) {
      case 'deposit': {
        const newTotalSupply = previousTotalSupply.add(amount);
        return previousTotalBorrowed.dividedBy(newTotalSupply).toNumber();
      }
      case 'withdraw': {
        const newTotalSupply = previousTotalSupply.sub(amount);
        if (newTotalSupply.eq(0)) {
          return 0;
        } else {
          return previousTotalBorrowed.dividedBy(newTotalSupply).toNumber();
        }
      }
      case 'borrow': {
        const newTotalBorrowed = previousTotalBorrowed.add(amount);
        return newTotalBorrowed.dividedBy(previousTotalSupply).toNumber();
      }
      case 'repay': {
        const newTotalBorrowed = previousTotalBorrowed.sub(amount);
        return newTotalBorrowed.dividedBy(previousTotalSupply).toNumber();
      }
      case 'depositAndBorrow': {
        const newTotalSupply = previousTotalSupply.add(amount);
        const newTotalBorrowed = previousTotalBorrowed.add(outflowAmount!);
        return newTotalBorrowed.dividedBy(newTotalSupply).toNumber();
      }
      case 'repayAndWithdraw': {
        const newTotalBorrowed = previousTotalBorrowed.sub(amount);
        const newTotalSupply = previousTotalSupply.sub(outflowAmount!);
        if (newTotalSupply.eq(0)) {
          return 0;
        }
        return newTotalBorrowed.dividedBy(newTotalSupply).toNumber();
      }
      case 'mint': {
        const newTotalSupply = previousTotalSupply.add(amount);
        return previousTotalBorrowed.dividedBy(newTotalSupply).toNumber();
      }
      case 'redeem': {
        const newTotalSupply = previousTotalSupply.sub(amount);
        return previousTotalBorrowed.dividedBy(newTotalSupply).toNumber();
      }
      default:
        throw Error(`Invalid action type ${action} for simulatedUtilizationRatio`);
    }
  }

  getMaxBorrowAmountWithCollReserve(market: KaminoMarket, collReserve: KaminoReserve, slot: number): Decimal {
    const groupsColl = collReserve.state.config.elevationGroups;
    const groupsDebt = this.state.config.elevationGroups;
    const groups = market.state.elevationGroups;
    const commonElevationGroups = [...groupsColl].filter(
      (item) => groupsDebt.includes(item) && item !== 0 && groups[item - 1].debtReserve.equals(this.address)
    );

    let eModeGroup = 0;

    if (commonElevationGroups.length !== 0) {
      const eModeGroupWithMaxLtvAndDebtReserve = commonElevationGroups.reduce((prev, curr) => {
        const prevGroup = groups.find((group) => group.id === prev);
        const currGroup = groups.find((group) => group.id === curr);
        return prevGroup!.ltvPct > currGroup!.ltvPct ? prev : curr;
      });

      eModeGroup = groups.find((group) => group.id === eModeGroupWithMaxLtvAndDebtReserve)!.id;
    }

    const elevationGroupActivated = this.state.config.elevationGroups.includes(eModeGroup) && eModeGroup !== 0;

    const reserveAvailableAmount = this.getLiquidityAvailableAmount();
    const reserveBorrowCapRemained = this.stats.reserveBorrowLimit.sub(this.getBorrowedAmount());

    let maxBorrowAmount = Decimal.min(reserveAvailableAmount, reserveBorrowCapRemained);

    const debtWithdrawalCap = this.getDebtWithdrawalCapCapacity().sub(this.getDebtWithdrawalCapCurrent(slot));
    maxBorrowAmount = this.getDebtWithdrawalCapCapacity().gt(0)
      ? Decimal.min(maxBorrowAmount, debtWithdrawalCap)
      : maxBorrowAmount;

    let originationFeeRate = this.getBorrowFee();

    // Inclusive fee rate
    originationFeeRate = originationFeeRate.div(originationFeeRate.add(new Decimal(1)));
    const borrowFee = maxBorrowAmount.mul(originationFeeRate);

    maxBorrowAmount = maxBorrowAmount.sub(borrowFee);

    const utilizationRatioLimit = this.state.config.utilizationLimitBlockBorrowingAbovePct / 100;
    const currentUtilizationRatio = this.calculateUtilizationRatio();

    if (utilizationRatioLimit > 0 && currentUtilizationRatio > utilizationRatioLimit) {
      return new Decimal(0);
    } else if (utilizationRatioLimit > 0 && currentUtilizationRatio < utilizationRatioLimit) {
      const maxBorrowBasedOnUtilization = new Decimal(utilizationRatioLimit - currentUtilizationRatio).mul(
        this.getTotalSupply()
      );
      maxBorrowAmount = Decimal.min(maxBorrowAmount, maxBorrowBasedOnUtilization);
    }

    let borrowLimitDependentOnElevationGroup = new Decimal(U64_MAX);

    if (!elevationGroupActivated) {
      borrowLimitDependentOnElevationGroup = this.getBorrowLimitOutsideElevationGroup().sub(
        this.getBorrowedAmountOutsideElevationGroup()
      );
    } else {
      let maxDebtTakenAgainstCollaterals = new Decimal(U64_MAX);
      const maxDebtAllowedAgainstCollateral = collReserve
        .getBorrowLimitAgainstCollateralInElevationGroup(eModeGroup - 1)
        .sub(collReserve.getBorrowedAmountAgainstCollateralInElevationGroup(eModeGroup - 1));

      maxDebtTakenAgainstCollaterals = Decimal.max(
        new Decimal(0),
        Decimal.min(maxDebtAllowedAgainstCollateral, maxDebtTakenAgainstCollaterals)
      );
      borrowLimitDependentOnElevationGroup = maxDebtTakenAgainstCollaterals;
    }

    maxBorrowAmount = Decimal.min(maxBorrowAmount, borrowLimitDependentOnElevationGroup);

    return Decimal.max(new Decimal(0), maxBorrowAmount);
  }

  calcSimulatedBorrowRate(
    amount: Decimal,
    action: ActionType,
    slot: number,
    referralFeeBps: number,
    outflowAmount?: Decimal
  ) {
    const slotAdjustmentFactor = this.slotAdjustmentFactor();
    const newUtilization = this.calcSimulatedUtilizationRatio(amount, action, slot, referralFeeBps, outflowAmount);
    const curve = truncateBorrowCurve(this.state.config.borrowRateCurve.points);
    return getBorrowRate(newUtilization, curve) * slotAdjustmentFactor;
  }

  calcSimulatedBorrowAPR(
    amount: Decimal,
    action: ActionType,
    slot: number,
    referralFeeBps: number,
    outflowAmount?: Decimal
  ) {
    return (
      this.calcSimulatedBorrowRate(amount, action, slot, referralFeeBps, outflowAmount) +
      this.getFixedHostInterestRate().toNumber()
    );
  }

  calcSimulatedSupplyAPR(
    amount: Decimal,
    action: ActionType,
    slot: number,
    referralFeeBps: number,
    outflowAmount?: Decimal
  ) {
    const newUtilization = this.calcSimulatedUtilizationRatio(amount, action, slot, referralFeeBps, outflowAmount);
    const simulatedBorrowAPR = this.calcSimulatedBorrowRate(amount, action, slot, referralFeeBps, outflowAmount);
    const protocolTakeRatePct = 1 - this.state.config.protocolTakeRatePct / 100;

    return newUtilization * simulatedBorrowAPR * protocolTakeRatePct;
  }

  slotAdjustmentFactor(): number {
    return 1000 / SLOTS_PER_SECOND / this.recentSlotDurationMs;
  }

  calculateBorrowRate() {
    const slotAdjustmentFactor = this.slotAdjustmentFactor();
    const currentUtilization = this.calculateUtilizationRatio();
    const curve = truncateBorrowCurve(this.state.config.borrowRateCurve.points);

    return getBorrowRate(currentUtilization, curve) * slotAdjustmentFactor;
  }

  calculateEstimatedBorrowRate(slot: number, referralFeeBps: number) {
    const slotAdjustmentFactor = this.slotAdjustmentFactor();
    const estimatedCurrentUtilization = this.getEstimatedUtilizationRatio(slot, referralFeeBps);
    const curve = truncateBorrowCurve(this.state.config.borrowRateCurve.points);
    return getBorrowRate(estimatedCurrentUtilization, curve) * slotAdjustmentFactor;
  }

  calculateBorrowAPR(slot: number, referralFeeBps: number) {
    const borrowRate = this.calculateEstimatedBorrowRate(slot, referralFeeBps);
    return borrowRate + this.getFixedHostInterestRate().toNumber();
  }

  /**
   * @returns the mint of the reserve liquidity token
   */
  getLiquidityMint(): PublicKey {
    return this.state.liquidity.mintPubkey;
  }

  /**
   * @returns the token program of the reserve liquidity mint
   */
  getLiquidityTokenProgram(): PublicKey {
    return this.state.liquidity.tokenProgram;
  }

  /**
   * @returns the mint of the reserve collateral token , i.e. the cToken minted for depositing the liquidity token
   */
  getCTokenMint(): PublicKey {
    return this.state.collateral.mintPubkey;
  }

  calculateFees(
    amountLamports: Decimal,
    borrowFeeRate: Decimal,
    feeCalculation: FeeCalculation,
    referralFeeBps: number,
    hasReferrer: boolean
  ): Fees {
    const referralFeeRate = new Decimal(referralFeeBps).div(ONE_HUNDRED_PCT_IN_BPS);
    if (borrowFeeRate.gt('0') && amountLamports.gt('0')) {
      const needToAssessReferralFee = referralFeeRate.gt('0') && hasReferrer;
      const minimumFee = new Decimal('1'); // 1 token to market owner, nothing to referrer

      let borrowFeeAmount: Decimal;
      if (feeCalculation === FeeCalculation.Exclusive) {
        borrowFeeAmount = amountLamports.mul(borrowFeeRate);
      } else {
        const borrowFeeFactor = borrowFeeRate.div(borrowFeeRate.add('1'));
        borrowFeeAmount = amountLamports.mul(borrowFeeFactor);
      }
      const borrowFee = Decimal.max(borrowFeeAmount, minimumFee);
      if (borrowFee.gte(amountLamports)) {
        throw Error('Borrow amount is too small to receive liquidity after fees');
      }
      const referralFee = needToAssessReferralFee
        ? referralFeeRate.eq(1)
          ? borrowFee
          : borrowFee.mul(referralFeeRate).floor()
        : new Decimal(0);

      const protocolFee = borrowFee.sub(referralFee);

      return { protocolFees: protocolFee, referrerFees: referralFee };
    } else {
      return { protocolFees: new Decimal(0), referrerFees: new Decimal(0) };
    }
  }

  calculateFlashLoanFees(flashLoanAmountLamports: Decimal, referralFeeBps: number, hasReferrer: boolean): Fees {
    return this.calculateFees(
      flashLoanAmountLamports,
      this.getFlashLoanFee(),
      FeeCalculation.Exclusive,
      referralFeeBps,
      hasReferrer
    );
  }

  setBuffer(buffer: AccountInfo<Buffer> | null) {
    this.buffer = buffer;
  }

  async load(tokenOraclePrice: TokenOracleData) {
    if (!this.buffer) {
      this.setBuffer(await this.connection.getAccountInfo(this.address, 'processed'));
    }

    if (!this.buffer) {
      throw Error(`Error requesting account info for ${this.symbol}`);
    }

    const parsedData = await Reserve.fetch(this.connection, this.address);
    if (!parsedData) {
      throw Error(`Unable to parse data of reserve ${this.symbol}`);
    }
    this.state = parsedData;
    this.tokenOraclePrice = tokenOraclePrice;
    this.stats = this.formatReserveData(parsedData);
  }

  totalSupplyAPY(currentSlot: number) {
    const { stats } = this;
    if (!stats) {
      throw Error('KaminoMarket must call loadRewards.');
    }

    return calculateAPYFromAPR(this.calculateSupplyAPR(currentSlot, 0));
  }

  totalBorrowAPY(currentSlot: number) {
    const { stats } = this;
    if (!stats) {
      throw Error('KaminoMarket must call loadRewards.');
    }

    return calculateAPYFromAPR(this.calculateBorrowAPR(currentSlot, 0));
  }

  async loadFarmStates() {
    if (!this.farmData.fetched) {
      const farmStates: FarmState[] = [];
      if (!this.state.farmDebt.equals(PublicKey.default)) {
        const farmState = await FarmState.fetch(this.connection, this.state.farmDebt);
        if (farmState !== null) {
          farmStates.push(farmState);
        }
      }
      if (!this.state.farmCollateral.equals(PublicKey.default)) {
        const farmState = await FarmState.fetch(this.connection, this.state.farmCollateral);
        if (farmState !== null) {
          farmStates.push(farmState);
        }
      }
      this.farmData.farmStates = farmStates;
      this.farmData.fetched = true;
    }
  }

  async getRewardYields(prices: KaminoPrices): Promise<ReserveRewardYield[]> {
    const { stats } = this;
    if (!stats) {
      throw Error('KaminoMarket must call loadReserves.');
    }

    const isDebtReward = this.state.farmDebt.equals(this.address);
    await this.loadFarmStates();
    const yields: ReserveRewardYield[] = [];
    for (const farmState of this.farmData.farmStates) {
      for (const rewardInfo of farmState.rewardInfos.filter(
        (x) => !x.token.mint.equals(PublicKey.default) && !x.rewardsAvailable.isZero()
      )) {
        const { apy, apr } = this.calculateRewardYield(prices, rewardInfo, isDebtReward);
        if (apy.isZero() && apr.isZero()) {
          continue;
        }
        yields.push({ apy, apr, rewardInfo });
      }
    }
    return yields;
  }

  private calculateRewardYield(prices: KaminoPrices, rewardInfo: RewardInfo, isDebtReward: boolean) {
    const mintAddress = this.getLiquidityMint();
    const rewardPerTimeUnitSecond = this.getRewardPerTimeUnitSecond(rewardInfo);
    const reserveToken = prices.spot[mintAddress.toString()];
    const rewardToken = prices.spot[rewardInfo.token.mint.toString()];

    if (rewardPerTimeUnitSecond.isZero() || reserveToken === undefined || rewardToken === undefined) {
      return { apy: new Decimal(0), apr: new Decimal(0) };
    }
    const { decimals } = this.stats;
    const totalBorrows = this.getBorrowedAmount();
    const totalSupply = this.getTotalSupply();

    const totalAmount = isDebtReward
      ? lamportsToNumberDecimal(totalBorrows, decimals)
      : lamportsToNumberDecimal(totalSupply, decimals);
    const totalValue = totalAmount.mul(reserveToken.price);
    const rewardsInYear = rewardPerTimeUnitSecond.mul(60 * 60 * 24 * 365);
    const rewardsInYearValue = rewardsInYear.mul(rewardToken.price);
    const apr = rewardsInYearValue.div(totalValue);
    return { apy: aprToApy(apr, 365), apr };
  }

  private getRewardPerTimeUnitSecond(reward: RewardInfo) {
    const now = new Decimal(new Date().getTime()).div(1000);
    let rewardPerTimeUnitSecond = new Decimal(0);
    for (let i = 0; i < reward.rewardScheduleCurve.points.length - 1; i++) {
      const { tsStart: tsStartThisPoint, rewardPerTimeUnit } = reward.rewardScheduleCurve.points[i];
      const { tsStart: tsStartNextPoint } = reward.rewardScheduleCurve.points[i + 1];

      const thisPeriodStart = new Decimal(tsStartThisPoint.toString());
      const thisPeriodEnd = new Decimal(tsStartNextPoint.toString());
      const rps = new Decimal(rewardPerTimeUnit.toString());
      if (thisPeriodStart <= now && thisPeriodEnd >= now) {
        rewardPerTimeUnitSecond = rps;
        break;
      } else if (thisPeriodStart > now && thisPeriodEnd > now) {
        rewardPerTimeUnitSecond = rps;
        break;
      }
    }

    const rewardTokenDecimals = reward.token.decimals.toNumber();
    const rewardAmountPerUnitDecimals = new Decimal(10).pow(reward.rewardsPerSecondDecimals.toString());
    const rewardAmountPerUnitLamports = new Decimal(10).pow(rewardTokenDecimals.toString());

    const rpsAdjusted = new Decimal(rewardPerTimeUnitSecond.toString())
      .div(rewardAmountPerUnitDecimals)
      .div(rewardAmountPerUnitLamports);

    return rewardPerTimeUnitSecond ? rpsAdjusted : new Decimal(0);
  }

  private formatReserveData(parsedData: ReserveFields): ReserveDataType {
    const mintTotalSupply = new Decimal(parsedData.collateral.mintTotalSupply.toString()).div(this.getMintFactor());
    let reserveStatus = ReserveStatus.Active;
    switch (parsedData.config.status) {
      case 0:
        reserveStatus = ReserveStatus.Active;
        break;
      case 1:
        reserveStatus = ReserveStatus.Obsolete;
        break;
      case 2:
        reserveStatus = ReserveStatus.Hidden;
        break;
    }
    return {
      // Reserve config

      status: reserveStatus,
      mintAddress: parsedData.liquidity.mintPubkey,
      borrowCurve: truncateBorrowCurve(parsedData.config.borrowRateCurve.points),
      loanToValue: parsedData.config.loanToValuePct / 100,
      maxLiquidationBonus: parsedData.config.maxLiquidationBonusBps / 10000,
      minLiquidationBonus: parsedData.config.minLiquidationBonusBps / 10000,
      liquidationThreshold: parsedData.config.liquidationThresholdPct / 100,
      protocolTakeRate: parsedData.config.protocolTakeRatePct / 100,
      reserveDepositLimit: new Decimal(parsedData.config.depositLimit.toString()),
      reserveBorrowLimit: new Decimal(parsedData.config.borrowLimit.toString()),

      // Reserve info
      symbol: parseTokenSymbol(parsedData.config.tokenInfo.name),
      decimals: this.state.liquidity.mintDecimals.toNumber(),
      accumulatedProtocolFees: this.getAccumulatedProtocolFees().div(this.getMintFactor()),
      mintTotalSupply,
      depositLimitCrossedTimestamp: parsedData.liquidity.depositLimitCrossedTimestamp.toNumber(),
      borrowLimitCrossedTimestamp: parsedData.liquidity.borrowLimitCrossedTimestamp.toNumber(),
      borrowFactor: parsedData.config.borrowFactorPct.toNumber(),
    };
  }

  /**
   * Compound current borrow rate over elapsed slots
   *
   * This also calculates protocol fees, which are taken for all obligations that have borrowed from current reserve.
   *
   * This also calculates referral fees, which are taken into pendingReferralFees.
   *
   * https://github.com/Kamino-Finance/klend/blob/release/1.3.0/programs/klend/src/state/reserve.rs#L517
   *
   * @param slotsElapsed
   * @param referralFeeBps
   */
  private compoundInterest(
    slotsElapsed: number,
    referralFeeBps: number
  ): {
    newDebt: Decimal;
    netNewDebt: Decimal;
    variableProtocolFee: Decimal;
    fixedHostFee: Decimal;
    absoluteReferralFee: Decimal;
    maxReferralFees: Decimal;
    newAccProtocolFees: Decimal;
    pendingReferralFees: Decimal;
  } {
    const currentBorrowRate = this.calculateBorrowRate();
    const protocolTakeRate = new Decimal(this.state.config.protocolTakeRatePct).div(100);
    const referralRate = new Decimal(referralFeeBps).div(10_000);
    const fixedHostInterestRate = this.getFixedHostInterestRate();

    const compoundedInterestRate = this.approximateCompoundedInterest(
      new Decimal(currentBorrowRate).plus(fixedHostInterestRate),
      slotsElapsed
    );
    const compoundedFixedRate = this.approximateCompoundedInterest(fixedHostInterestRate, slotsElapsed);

    const previousDebt = this.getBorrowedAmount();
    const newDebt = previousDebt.mul(compoundedInterestRate);
    const fixedHostFee = previousDebt.mul(compoundedFixedRate).sub(previousDebt);

    const netNewDebt = newDebt.sub(previousDebt).sub(fixedHostFee);

    const variableProtocolFee = netNewDebt.mul(protocolTakeRate);
    const absoluteReferralFee = protocolTakeRate.mul(referralRate);
    const maxReferralFees = netNewDebt.mul(absoluteReferralFee);

    const newAccProtocolFees = variableProtocolFee
      .add(fixedHostFee)
      .sub(maxReferralFees)
      .add(this.getAccumulatedProtocolFees());

    const pendingReferralFees = this.getPendingReferrerFees().add(maxReferralFees);

    return {
      newDebt,
      netNewDebt,
      variableProtocolFee,
      fixedHostFee,
      absoluteReferralFee,
      maxReferralFees,
      newAccProtocolFees,
      pendingReferralFees,
    };
  }

  /**
   * Approximation to match the smart contract calculation
   * https://github.com/Kamino-Finance/klend/blob/release/1.3.0/programs/klend/src/state/reserve.rs#L1026
   * @param rate
   * @param elapsedSlots
   * @private
   */
  private approximateCompoundedInterest(rate: Decimal, elapsedSlots: number): Decimal {
    const base = rate.div(SLOTS_PER_YEAR);
    switch (elapsedSlots) {
      case 0:
        return new Decimal(1);
      case 1:
        return base.add(1);
      case 2:
        return base.add(1).mul(base.add(1));
      case 3:
        return base.add(1).mul(base.add(1)).mul(base.add(1));
      case 4:
        // eslint-disable-next-line no-case-declarations
        const pow2 = base.add(1).mul(base.add(1));
        return pow2.mul(pow2);
    }
    const exp = elapsedSlots;
    const expMinus1 = exp - 1;
    const expMinus2 = exp - 2;

    const basePow2 = base.mul(base);
    const basePow3 = basePow2.mul(base);

    const firstTerm = base.mul(exp);
    const secondTerm = basePow2.mul(exp).mul(expMinus1).div(2);
    const thirdTerm = basePow3.mul(exp).mul(expMinus1).mul(expMinus2).div(6);

    return new Decimal(1).add(firstTerm).add(secondTerm).add(thirdTerm);
  }

  getBorrowCapForReserve(market: KaminoMarket): BorrowCapsAndCounters {
    // Utilization cap
    const utilizationCap = this.state.config.utilizationLimitBlockBorrowingAbovePct;
    const utilizationCurrentValue = this.calculateUtilizationRatio();

    // Daily borrow cap
    const withdrawalCap = this.state.config.debtWithdrawalCap;

    // Debt against collaterals in elevation groups
    const debtAgainstCollateralReserveCaps: {
      collateralReserve: PublicKey;
      elevationGroup: number;
      maxDebt: Decimal;
      currentValue: Decimal;
    }[] = market
      .getMarketElevationGroupDescriptions()
      .filter((x) => x.debtReserve.equals(this.address))
      .map((elevationGroupDescription: ElevationGroupDescription) =>
        elevationGroupDescription.collateralReserves.toArray().map((collateralReserveAddress) => {
          const collRes = market.reserves.get(new PublicKey(collateralReserveAddress))!;

          const debtLimitAgainstThisCollInGroup =
            collRes.state.config.borrowLimitAgainstThisCollateralInElevationGroup[
              elevationGroupDescription.elevationGroup - 1
            ].toString();

          const debtCounterAgainstThisCollInGroup =
            collRes.state.borrowedAmountsAgainstThisReserveInElevationGroups[
              elevationGroupDescription.elevationGroup - 1
            ].toString();

          return {
            collateralReserve: collRes.address,
            elevationGroup: elevationGroupDescription.elevationGroup,
            maxDebt: new Decimal(debtLimitAgainstThisCollInGroup),
            currentValue: new Decimal(debtCounterAgainstThisCollInGroup),
          };
        })
      )
      .flat();

    const caps: BorrowCapsAndCounters = {
      // Utilization cap
      utilizationCap: new Decimal(utilizationCap > 0 ? utilizationCap / 100 : 1),
      utilizationCurrentValue: new Decimal(utilizationCurrentValue),

      // Daily borrow cap
      netWithdrawalCap: new Decimal(withdrawalCap.configCapacity.toString()),
      netWithdrawalCurrentValue: new Decimal(withdrawalCap.currentTotal.toString()),
      netWithdrawalLastUpdateTs: new Decimal(withdrawalCap.lastIntervalStartTimestamp.toString()),
      netWithdrawalIntervalDurationSeconds: new Decimal(withdrawalCap.configIntervalLengthSeconds.toString()),

      // Global cap
      globalDebtCap: new Decimal(this.state.config.borrowLimit.toString()),
      globalTotalBorrowed: this.getBorrowedAmount(),

      // Debt outside emode cap
      debtOutsideEmodeCap: new Decimal(this.state.config.borrowLimitOutsideElevationGroup.toString()),
      borrowedOutsideEmode: this.getBorrowedAmountOutsideElevationGroup(),

      debtAgainstCollateralReserveCaps: debtAgainstCollateralReserveCaps,
    };

    return caps;
  }

  /* This takes into account all the caps */
  getLiquidityAvailableForDebtReserveGivenCaps(
    market: KaminoMarket,
    elevationGroups: number[],
    collateralReserves: PublicKey[] = []
  ): Decimal[] {
    const caps = this.getBorrowCapForReserve(market);

    const liquidityAvailable = this.getLiquidityAvailableAmount();

    // Cap this to utilization cap first
    const utilizationRatioLimit = caps.utilizationCap;
    const currentUtilizationRatio = this.calculateUtilizationRatio();

    const liquidityGivenUtilizationCap = this.getTotalSupply().mul(
      utilizationRatioLimit.minus(currentUtilizationRatio)
    );

    const remainingDailyCap = caps.netWithdrawalIntervalDurationSeconds.eq(new Decimal(0))
      ? new Decimal(U64_MAX)
      : caps.netWithdrawalCap.minus(caps.netWithdrawalCurrentValue);

    const remainingGlobalCap = caps.globalDebtCap.minus(caps.globalTotalBorrowed);
    const remainingOutsideEmodeCap = caps.debtOutsideEmodeCap.minus(caps.borrowedOutsideEmode);

    const available = elevationGroups.map((elevationGroup) => {
      if (elevationGroup === 0) {
        const availableInCrossMode = Decimal.min(
          positiveOrZero(liquidityAvailable),
          positiveOrZero(remainingOutsideEmodeCap),
          positiveOrZero(remainingDailyCap),
          positiveOrZero(remainingGlobalCap),
          positiveOrZero(liquidityGivenUtilizationCap)
        );
        return availableInCrossMode;
      } else {
        let remainingInsideEmodeCaps = new Decimal(0);
        const capsGivenEgroup = caps.debtAgainstCollateralReserveCaps.filter(
          (x) => x.elevationGroup === elevationGroup
        );
        if (capsGivenEgroup.length > 0) {
          remainingInsideEmodeCaps = Decimal.min(
            ...capsGivenEgroup.map((x) => {
              // check reserve is part of collReserves array
              if (collateralReserves.find((collateralReserve) => collateralReserve.equals(x.collateralReserve))) {
                return x.maxDebt.minus(x.currentValue);
              } else {
                return new Decimal(U64_MAX);
              }
            })
          );
        }
        return Decimal.min(
          positiveOrZero(liquidityAvailable),
          positiveOrZero(remainingInsideEmodeCaps),
          positiveOrZero(remainingDailyCap),
          positiveOrZero(remainingGlobalCap),
          positiveOrZero(liquidityGivenUtilizationCap)
        );
      }
    });

    return available;
  }
}

const truncateBorrowCurve = (points: CurvePointFields[]): [number, number][] => {
  const curve: [number, number][] = [];
  for (const { utilizationRateBps, borrowRateBps } of points) {
    curve.push([utilizationRateBps / ONE_HUNDRED_PCT_IN_BPS, borrowRateBps / ONE_HUNDRED_PCT_IN_BPS]);

    if (utilizationRateBps === ONE_HUNDRED_PCT_IN_BPS) {
      break;
    }
  }
  return curve;
};

export async function createReserveIxs(
  connection: Connection,
  owner: PublicKey,
  ownerLiquiditySource: PublicKey,
  lendingMarket: PublicKey,
  liquidityMint: PublicKey,
  reserveAddress: PublicKey,
  programId: PublicKey
): Promise<TransactionInstruction[]> {
  const size = Reserve.layout.span + 8;

  const createReserveIx = SystemProgram.createAccount({
    fromPubkey: owner,
    newAccountPubkey: reserveAddress,
    lamports: await connection.getMinimumBalanceForRentExemption(size),
    space: size,
    programId: programId,
  });

  const { liquiditySupplyVault, collateralMint, collateralSupplyVault, feeVault } = reservePdas(
    programId,
    lendingMarket,
    liquidityMint
  );
  const [lendingMarketAuthority, _] = lendingMarketAuthPda(lendingMarket, programId);

  const accounts: InitReserveAccounts = {
    lendingMarketOwner: owner,
    lendingMarket: lendingMarket,
    lendingMarketAuthority: lendingMarketAuthority,
    reserve: reserveAddress,
    reserveLiquidityMint: liquidityMint,
    reserveLiquiditySupply: liquiditySupplyVault,
    feeReceiver: feeVault,
    reserveCollateralMint: collateralMint,
    reserveCollateralSupply: collateralSupplyVault,
    initialLiquiditySource: ownerLiquiditySource,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    collateralTokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };

  const initReserveIx = initReserve(accounts, programId);

  return [createReserveIx, initReserveIx];
}

export function updateReserveConfigIx(
  marketWithAddress: MarketWithAddress,
  reserveAddress: PublicKey,
  modeDiscriminator: number,
  value: Uint8Array,
  programId: PublicKey,
  skipValidation: boolean = false
): TransactionInstruction {
  value;
  const args: UpdateReserveConfigArgs = {
    mode: new anchor.BN(modeDiscriminator),
    value: value,
    skipValidation,
  };

  const accounts: UpdateReserveConfigAccounts = {
    lendingMarketOwner: marketWithAddress.state.lendingMarketOwner,
    lendingMarket: marketWithAddress.address,
    reserve: reserveAddress,
  };

  const ix = updateReserveConfig(args, accounts, programId);

  return ix;
}

type BaseReserveConfigKey = keyof ReturnType<typeof ReserveConfig.toEncodable>;

// Type that excludes reserved and padding fields
type ReserveConfigKey = Exclude<BaseReserveConfigKey, ExcludedReserveConfigKey>;

const EXCLUDED_RESERVE_CONFIG_KEYS = ['reserved1', 'reserved2', 'reserved3'] as const;

export type ExcludedReserveConfigKey = (typeof EXCLUDED_RESERVE_CONFIG_KEYS)[number];

function isExcludedReserveConfigKey(value: unknown): value is ExcludedReserveConfigKey {
  return EXCLUDED_RESERVE_CONFIG_KEYS.includes(value as ExcludedReserveConfigKey);
}

function handleConfigUpdate(
  key: ReserveConfigKey,
  reserve: Reserve | undefined,
  reserveConfig: ReserveConfig,
  updateReserveIxnsArgs: UpdateReserveIxnsArgs[]
): void {
  // We add 1 to the discriminator, to account for the fact that the UpdateConfigMode
  // inside the SC starts incrementing from 1
  switch (key) {
    case 'status':
      if (reserve === undefined || reserve.config.status !== reserveConfig.status) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateReserveStatus.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateReserveStatus.discriminator,
            reserveConfig.status
          ),
        });
      }
      break;
    case 'assetTier':
      if (reserve === undefined || reserve.config.assetTier !== reserveConfig.assetTier) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateAssetTier.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateAssetTier.discriminator,
            reserveConfig.assetTier
          ),
        });
      }
      break;
    case 'hostFixedInterestRateBps':
      if (reserve === undefined || reserve.config.hostFixedInterestRateBps !== reserveConfig.hostFixedInterestRateBps) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateHostFixedInterestRateBps.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateHostFixedInterestRateBps.discriminator,
            reserveConfig.hostFixedInterestRateBps
          ),
        });
      }
      break;
    case 'protocolTakeRatePct':
      if (reserve === undefined || reserve.config.protocolTakeRatePct !== reserveConfig.protocolTakeRatePct) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateProtocolTakeRate.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateProtocolTakeRate.discriminator,
            reserveConfig.protocolTakeRatePct
          ),
        });
      }
      break;
    case 'protocolLiquidationFeePct':
      if (
        reserve === undefined ||
        reserve.config.protocolLiquidationFeePct !== reserveConfig.protocolLiquidationFeePct
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateProtocolLiquidationFee.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateProtocolLiquidationFee.discriminator,
            reserveConfig.protocolLiquidationFeePct
          ),
        });
      }
      break;
    case 'loanToValuePct':
      if (reserve === undefined || reserve.config.loanToValuePct !== reserveConfig.loanToValuePct) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateLoanToValuePct.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateLoanToValuePct.discriminator,
            reserveConfig.loanToValuePct
          ),
        });
      }
      break;
    case 'liquidationThresholdPct':
      if (reserve === undefined || reserve.config.liquidationThresholdPct !== reserveConfig.liquidationThresholdPct) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateLiquidationThresholdPct.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateLiquidationThresholdPct.discriminator,
            reserveConfig.liquidationThresholdPct
          ),
        });
      }
      break;
    case 'minLiquidationBonusBps':
      if (reserve === undefined || reserve.config.minLiquidationBonusBps !== reserveConfig.minLiquidationBonusBps) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateMinLiquidationBonusBps.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateMinLiquidationBonusBps.discriminator,
            reserveConfig.minLiquidationBonusBps
          ),
        });
      }
      break;
    case 'maxLiquidationBonusBps':
      if (reserve === undefined || reserve.config.maxLiquidationBonusBps !== reserveConfig.maxLiquidationBonusBps) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateMaxLiquidationBonusBps.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateMaxLiquidationBonusBps.discriminator,
            reserveConfig.maxLiquidationBonusBps
          ),
        });
      }
      break;
    case 'badDebtLiquidationBonusBps':
      if (
        reserve === undefined ||
        reserve.config.badDebtLiquidationBonusBps !== reserveConfig.badDebtLiquidationBonusBps
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBadDebtLiquidationBonusBps.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBadDebtLiquidationBonusBps.discriminator,
            reserveConfig.badDebtLiquidationBonusBps
          ),
        });
      }
      break;
    case 'deleveragingMarginCallPeriodSecs':
      if (
        reserve === undefined ||
        !reserve.config.deleveragingMarginCallPeriodSecs.eq(reserveConfig.deleveragingMarginCallPeriodSecs)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDeleveragingMarginCallPeriod.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDeleveragingMarginCallPeriod.discriminator,
            reserveConfig.deleveragingMarginCallPeriodSecs.toNumber()
          ),
        });
      }
      break;
    case 'deleveragingThresholdDecreaseBpsPerDay':
      if (
        reserve === undefined ||
        !reserve.config.deleveragingThresholdDecreaseBpsPerDay.eq(reserveConfig.deleveragingThresholdDecreaseBpsPerDay)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDeleveragingThresholdDecreaseBpsPerDay.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDeleveragingThresholdDecreaseBpsPerDay.discriminator,
            reserveConfig.deleveragingThresholdDecreaseBpsPerDay.toNumber()
          ),
        });
      }
      break;
    case 'fees':
      if (reserve === undefined || !reserve.config.fees.borrowFeeSf.eq(reserveConfig.fees.borrowFeeSf)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateFeesBorrowFee.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateFeesBorrowFee.discriminator,
            reserveConfig.fees.borrowFeeSf.toNumber()
          ),
        });
      }

      if (reserve === undefined || !reserve.config.fees.flashLoanFeeSf.eq(reserveConfig.fees.flashLoanFeeSf)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateFeesFlashLoanFee.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateFeesFlashLoanFee.discriminator,
            reserveConfig.fees.flashLoanFeeSf.toNumber()
          ),
        });
      }

      break;
    case 'borrowRateCurve':
      if (reserve === undefined) {
        updateReserveIxnsArgs.push({
          mode: UpdateBorrowRateCurve.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateBorrowRateCurve.discriminator, reserveConfig.borrowRateCurve),
        });
      } else {
        let shouldBorrowCurveBeUpdated = false;
        for (let i = 0; i < reserveConfig.borrowRateCurve.points.length; i++) {
          if (
            reserve.config.borrowRateCurve.points[i].utilizationRateBps !==
              reserveConfig.borrowRateCurve.points[i].utilizationRateBps ||
            reserve.config.borrowRateCurve.points[i].borrowRateBps !==
              reserveConfig.borrowRateCurve.points[i].borrowRateBps
          ) {
            shouldBorrowCurveBeUpdated = true;
            break;
          }
        }

        if (shouldBorrowCurveBeUpdated) {
          updateReserveIxnsArgs.push({
            mode: UpdateBorrowRateCurve.discriminator + 1,
            value: updateReserveConfigEncodedValue(UpdateBorrowRateCurve.discriminator, reserveConfig.borrowRateCurve),
          });
          break;
        }
      }
      break;
    case 'borrowFactorPct':
      if (reserve === undefined || !reserve.config.borrowFactorPct.eq(reserveConfig.borrowFactorPct)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBorrowFactor.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBorrowFactor.discriminator,
            reserveConfig.borrowFactorPct.toNumber()
          ),
        });
      }
      break;
    case 'depositLimit':
      if (reserve === undefined || !reserve.config.depositLimit.eq(reserveConfig.depositLimit)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDepositLimit.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDepositLimit.discriminator,
            BigInt(reserveConfig.depositLimit.toString())
          ),
        });
      }
      break;
    case 'borrowLimit':
      if (reserve === undefined || !reserve.config.borrowLimit.eq(reserveConfig.borrowLimit)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBorrowLimit.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBorrowLimit.discriminator,
            BigInt(reserveConfig.borrowLimit.toString())
          ),
        });
      }
      break;
    case 'tokenInfo':
      const tokenInfo = reserveConfig.tokenInfo;
      if (reserve === undefined) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoName.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateTokenInfoName.discriminator, tokenInfo.name),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoLowerHeuristic.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoLowerHeuristic.discriminator,
            tokenInfo.heuristic.lower.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoUpperHeuristic.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoUpperHeuristic.discriminator,
            tokenInfo.heuristic.upper.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator,
            tokenInfo.heuristic.exp.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator,
            tokenInfo.maxTwapDivergenceBps.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator,
            tokenInfo.maxAgePriceSeconds.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator,
            tokenInfo.maxAgeTwapSeconds.toNumber()
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator,
            tokenInfo.scopeConfiguration.priceChain
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator,
            tokenInfo.scopeConfiguration.twapChain
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateSwitchboardFeed.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateSwitchboardFeed.discriminator,
            tokenInfo.switchboardConfiguration.priceAggregator
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateSwitchboardTwapFeed.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateSwitchboardTwapFeed.discriminator,
            tokenInfo.switchboardConfiguration.twapAggregator
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdatePythPrice.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdatePythPrice.discriminator,
            tokenInfo.pythConfiguration.price
          ),
        });
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBlockPriceUsage.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBlockPriceUsage.discriminator,
            tokenInfo.blockPriceUsage
          ),
        });
      } else {
        if (!sameLengthArrayEquals(reserve.config.tokenInfo.name, tokenInfo.name)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoName.discriminator + 1,
            value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateTokenInfoName.discriminator, tokenInfo.name),
          });
        }
        if (!reserve.config.tokenInfo.heuristic.lower.eq(tokenInfo.heuristic.lower)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoLowerHeuristic.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoLowerHeuristic.discriminator,
              tokenInfo.heuristic.lower.toNumber()
            ),
          });
        }
        if (!reserve.config.tokenInfo.heuristic.upper.eq(tokenInfo.heuristic.upper)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoUpperHeuristic.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoUpperHeuristic.discriminator,
              tokenInfo.heuristic.upper.toNumber()
            ),
          });
        }
        if (!reserve.config.tokenInfo.heuristic.exp.eq(tokenInfo.heuristic.exp)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator,
              tokenInfo.heuristic.exp.toNumber()
            ),
          });
        }
        if (!reserve.config.tokenInfo.maxTwapDivergenceBps.eq(tokenInfo.maxTwapDivergenceBps)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator,
              tokenInfo.maxTwapDivergenceBps.toNumber()
            ),
          });
        }
        if (!reserve.config.tokenInfo.maxAgePriceSeconds.eq(tokenInfo.maxAgePriceSeconds)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator,
              tokenInfo.maxAgePriceSeconds.toNumber()
            ),
          });
        }
        if (!reserve.config.tokenInfo.maxAgeTwapSeconds.eq(tokenInfo.maxAgeTwapSeconds)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator,
              tokenInfo.maxAgeTwapSeconds.toNumber()
            ),
          });
        }
        if (
          !sameLengthArrayEquals(
            reserve.config.tokenInfo.scopeConfiguration.priceChain,
            tokenInfo.scopeConfiguration.priceChain
          )
        ) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator,
              tokenInfo.scopeConfiguration.priceChain
            ),
          });
        }
        if (
          !sameLengthArrayEquals(
            reserve.config.tokenInfo.scopeConfiguration.twapChain,
            tokenInfo.scopeConfiguration.twapChain
          )
        ) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator,
              tokenInfo.scopeConfiguration.twapChain
            ),
          });
        }
        if (
          !reserve.config.tokenInfo.switchboardConfiguration.priceAggregator.equals(
            tokenInfo.switchboardConfiguration.priceAggregator
          )
        ) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateSwitchboardFeed.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateSwitchboardFeed.discriminator,
              tokenInfo.switchboardConfiguration.priceAggregator
            ),
          });
        }
        if (
          !reserve.config.tokenInfo.switchboardConfiguration.twapAggregator.equals(
            tokenInfo.switchboardConfiguration.twapAggregator
          )
        ) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateSwitchboardTwapFeed.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateSwitchboardTwapFeed.discriminator,
              tokenInfo.switchboardConfiguration.twapAggregator
            ),
          });
        }
        if (!reserve.config.tokenInfo.pythConfiguration.price.equals(tokenInfo.pythConfiguration.price)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdatePythPrice.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdatePythPrice.discriminator,
              tokenInfo.pythConfiguration.price
            ),
          });
        }
        if (reserve.config.tokenInfo.blockPriceUsage !== tokenInfo.blockPriceUsage) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateBlockPriceUsage.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateBlockPriceUsage.discriminator,
              tokenInfo.blockPriceUsage
            ),
          });
        }
        if (!reserve.config.tokenInfo.scopeConfiguration.priceFeed.equals(tokenInfo.scopeConfiguration.priceFeed)) {
          updateReserveIxnsArgs.push({
            mode: UpdateConfigMode.UpdateScopePriceFeed.discriminator + 1,
            value: updateReserveConfigEncodedValue(
              UpdateConfigMode.UpdateScopePriceFeed.discriminator,
              tokenInfo.scopeConfiguration.priceFeed
            ),
          });
        }
      }
      break;
    case 'depositWithdrawalCap':
      if (reserve === undefined) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator, [
            reserveConfig.depositWithdrawalCap.configCapacity.toNumber(),
            reserveConfig.depositWithdrawalCap.configIntervalLengthSeconds.toNumber(),
          ]),
        });
      } else if (
        !reserve.config.depositWithdrawalCap.configCapacity.eq(reserveConfig.depositWithdrawalCap.configCapacity) ||
        !reserve.config.depositWithdrawalCap.configIntervalLengthSeconds.eq(
          reserveConfig.depositWithdrawalCap.configIntervalLengthSeconds
        )
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator, [
            reserveConfig.depositWithdrawalCap.configCapacity.toNumber(),
            reserveConfig.depositWithdrawalCap.configIntervalLengthSeconds.toNumber(),
          ]),
        });
      } else if (
        !reserve.config.depositWithdrawalCap.currentTotal.eq(reserveConfig.depositWithdrawalCap.currentTotal)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDepositWithdrawalCapCurrentTotal.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator,
            reserveConfig.depositWithdrawalCap.currentTotal.toNumber()
          ),
        });
      }
      break;
    case 'debtWithdrawalCap':
      if (reserve === undefined) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator, [
            reserveConfig.debtWithdrawalCap.configCapacity.toNumber(),
            reserveConfig.debtWithdrawalCap.configIntervalLengthSeconds.toNumber(),
          ]),
        });
      } else if (
        !reserve.config.debtWithdrawalCap.configCapacity.eq(reserveConfig.debtWithdrawalCap.configCapacity) ||
        !reserve.config.debtWithdrawalCap.configIntervalLengthSeconds.eq(
          reserveConfig.debtWithdrawalCap.configIntervalLengthSeconds
        )
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator + 1,
          value: updateReserveConfigEncodedValue(UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator, [
            reserveConfig.debtWithdrawalCap.configCapacity.toNumber(),
            reserveConfig.debtWithdrawalCap.configIntervalLengthSeconds.toNumber(),
          ]),
        });
      } else if (!reserve.config.debtWithdrawalCap.currentTotal.eq(reserveConfig.debtWithdrawalCap.currentTotal)) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDebtWithdrawalCapCurrentTotal.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator,
            reserveConfig.debtWithdrawalCap.currentTotal.toNumber()
          ),
        });
      }
      break;
    case 'elevationGroups':
      if (
        reserve === undefined ||
        !sameLengthArrayEquals(reserve.config.elevationGroups, reserveConfig.elevationGroups)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateElevationGroup.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateElevationGroup.discriminator,
            reserveConfig.elevationGroups
          ),
        });
      }
      break;
    case 'disableUsageAsCollOutsideEmode':
      if (
        reserve === undefined ||
        reserve.config.disableUsageAsCollOutsideEmode !== reserveConfig.disableUsageAsCollOutsideEmode
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDisableUsageAsCollateralOutsideEmode.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDisableUsageAsCollateralOutsideEmode.discriminator,
            reserveConfig.disableUsageAsCollOutsideEmode
          ),
        });
      }
      break;
    case 'utilizationLimitBlockBorrowingAbovePct':
      if (
        reserve === undefined ||
        reserve.config.utilizationLimitBlockBorrowingAbovePct !== reserveConfig.utilizationLimitBlockBorrowingAbovePct
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBlockBorrowingAboveUtilizationPct.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBlockBorrowingAboveUtilizationPct.discriminator,
            reserveConfig.utilizationLimitBlockBorrowingAbovePct
          ),
        });
      }
      break;
    case 'autodeleverageEnabled':
      if (reserve === undefined || reserve.config.autodeleverageEnabled !== reserveConfig.autodeleverageEnabled) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateAutodeleverageEnabled.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateAutodeleverageEnabled.discriminator,
            reserveConfig.autodeleverageEnabled
          ),
        });
      }
      break;
    case 'borrowLimitOutsideElevationGroup':
      if (
        reserve === undefined ||
        !reserve.config.borrowLimitOutsideElevationGroup.eq(reserveConfig.borrowLimitOutsideElevationGroup)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBorrowLimitOutsideElevationGroup.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBorrowLimitOutsideElevationGroup.discriminator,
            reserveConfig.borrowLimitOutsideElevationGroup.toNumber()
          ),
        });
      }
      break;
    case 'borrowLimitAgainstThisCollateralInElevationGroup':
      if (
        reserve === undefined ||
        !sameLengthArrayEquals(
          reserve.config.borrowLimitAgainstThisCollateralInElevationGroup,
          reserveConfig.borrowLimitAgainstThisCollateralInElevationGroup
        )
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateBorrowLimitsInElevationGroupAgainstThisReserve.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateBorrowLimitsInElevationGroupAgainstThisReserve.discriminator,
            reserveConfig.borrowLimitAgainstThisCollateralInElevationGroup.map((borrowLimit) => borrowLimit.toNumber())
          ),
        });
      }

      break;
    case 'deleveragingBonusIncreaseBpsPerDay':
      if (
        reserve === undefined ||
        !reserve.config.deleveragingBonusIncreaseBpsPerDay.eq(reserveConfig.deleveragingBonusIncreaseBpsPerDay)
      ) {
        updateReserveIxnsArgs.push({
          mode: UpdateConfigMode.UpdateDeleveragingBonusIncreaseBpsPerDay.discriminator + 1,
          value: updateReserveConfigEncodedValue(
            UpdateConfigMode.UpdateDeleveragingBonusIncreaseBpsPerDay.discriminator,
            reserveConfig.deleveragingBonusIncreaseBpsPerDay.toNumber()
          ),
        });
      }
      break;
    default:
      assertNever(key); // Will cause compile error if any case is missing
  }
}

export function updateEntireReserveConfigIx(
  marketWithAddress: MarketWithAddress,
  reserveAddress: PublicKey,
  reserveConfig: ReserveConfig,
  programId: PublicKey
): TransactionInstruction {
  const layout = ReserveConfig.layout();
  const data = Buffer.alloc(1000);
  const len = layout.encode(reserveConfig.toEncodable(), data);
  const value = Uint8Array.from([...data.subarray(0, len)]);

  const args: UpdateReserveConfigArgs = {
    mode: new anchor.BN(25),
    value: value,
    skipValidation: false,
  };

  const accounts: UpdateReserveConfigAccounts = {
    lendingMarketOwner: marketWithAddress.state.lendingMarketOwner,
    lendingMarket: marketWithAddress.address,
    reserve: reserveAddress,
  };

  const ix = updateReserveConfig(args, accounts, programId);

  return ix;
}

export function parseForChangesReserveConfigAndGetIxs(
  marketWithAddress: MarketWithAddress,
  reserve: Reserve | undefined,
  reserveAddress: PublicKey,
  reserveConfig: ReserveConfig,
  programId: PublicKey
) {
  let updateReserveIxnsArgs: UpdateReserveIxnsArgs[] = [];
  for (const key in reserveConfig.toEncodable()) {
    if (isExcludedReserveConfigKey(key)) {
      continue;
    }
    handleConfigUpdate(key as ReserveConfigKey, reserve, reserveConfig, updateReserveIxnsArgs);
  }

  const ixns: TransactionInstruction[] = [];

  updateReserveIxnsArgs = sortIxnsByPriority(updateReserveIxnsArgs);

  updateReserveIxnsArgs.forEach((updateReserveConfigArgs) => {
    let skipValidation = false;
    if (modeMatches(updateReserveConfigArgs.mode) && !reserve?.liquidity.availableAmount.gten(MIN_INITIAL_DEPOSIT)) {
      skipValidation = true;
    }
    ixns.push(
      updateReserveConfigIx(
        marketWithAddress,
        reserveAddress,
        updateReserveConfigArgs.mode,
        updateReserveConfigArgs.value,
        programId,
        skipValidation
      )
    );
  });

  return ixns;
}

export function updateReserveConfigEncodedValue(
  discriminator: number,
  value: number | number[] | bigint | BorrowRateCurve | PublicKey
): Uint8Array {
  let buffer: Buffer;
  let valueArray: number[] = [];

  switch (discriminator) {
    case UpdateConfigMode.UpdateLoanToValuePct.discriminator:
    case UpdateConfigMode.UpdateLiquidationThresholdPct.discriminator:
    case UpdateConfigMode.UpdateProtocolLiquidationFee.discriminator:
    case UpdateConfigMode.UpdateProtocolTakeRate.discriminator:
    case UpdateConfigMode.UpdateAssetTier.discriminator:
    case UpdateConfigMode.UpdateReserveStatus.discriminator:
    case UpdateConfigMode.UpdateDisableUsageAsCollateralOutsideEmode.discriminator:
    case UpdateConfigMode.UpdateBlockBorrowingAboveUtilizationPct.discriminator:
    case UpdateConfigMode.UpdateBlockPriceUsage.discriminator:
    case UpdateConfigMode.UpdateAutodeleverageEnabled.discriminator:
      buffer = Buffer.alloc(1);
      buffer.writeUIntLE(value as number, 0, 1);
      break;
    case UpdateConfigMode.UpdateMaxLiquidationBonusBps.discriminator:
    case UpdateConfigMode.UpdateBadDebtLiquidationBonusBps.discriminator:
    case UpdateConfigMode.UpdateMinLiquidationBonusBps.discriminator:
      buffer = Buffer.alloc(2);
      buffer.writeUInt16LE(value as number, 0);
      break;
    case UpdateConfigMode.UpdateFeesBorrowFee.discriminator:
    case UpdateConfigMode.UpdateFeesFlashLoanFee.discriminator:
    case UpdateConfigMode.UpdateTokenInfoLowerHeuristic.discriminator:
    case UpdateConfigMode.UpdateTokenInfoUpperHeuristic.discriminator:
    case UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator:
    case UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator:
    case UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator:
    case UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator:
    case UpdateConfigMode.UpdateDebtWithdrawalCapCurrentTotal.discriminator:
    case UpdateConfigMode.UpdateDepositWithdrawalCapCurrentTotal.discriminator:
    case UpdateConfigMode.UpdateDeleveragingMarginCallPeriod.discriminator:
    case UpdateConfigMode.UpdateBorrowFactor.discriminator:
    case UpdateConfigMode.UpdateDeleveragingThresholdDecreaseBpsPerDay.discriminator:
    case UpdateConfigMode.UpdateDeleveragingBonusIncreaseBpsPerDay.discriminator:
      value = value as number;
      buffer = Buffer.alloc(8);
      buffer.writeBigUint64LE(BigInt(value), 0);
      break;
    case UpdateConfigMode.UpdateDepositLimit.discriminator:
    case UpdateConfigMode.UpdateBorrowLimit.discriminator:
    case UpdateConfigMode.UpdateBorrowLimitOutsideElevationGroup.discriminator:
      buffer = Buffer.alloc(8);
      // Convert value to BigInt if it's not already
      const bigIntValue = typeof value === 'bigint' ? value : BigInt(value.toString());
      // Split into two 32-bit values
      const low = Number(bigIntValue & BigInt(0xffffffff));
      const high = Number(bigIntValue >> BigInt(32));
      buffer.writeUInt32LE(low, 0);
      buffer.writeUInt32LE(high, 4);
      break;
    case UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator:
    case UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator:
      valueArray = value as number[];
      buffer = Buffer.alloc(8);
      for (let i = 0; i < valueArray.length; i++) {
        buffer.writeUInt16LE(valueArray[i], 2 * i);
      }
      break;
    case UpdateConfigMode.UpdateTokenInfoName.discriminator:
      valueArray = value as number[];
      buffer = Buffer.alloc(32);
      for (let i = 0; i < valueArray.length; i++) {
        buffer.writeUIntLE(valueArray[i], i, 1);
      }
      break;
    case UpdateConfigMode.UpdateScopePriceFeed.discriminator:
    case UpdateConfigMode.UpdatePythPrice.discriminator:
    case UpdateConfigMode.UpdateSwitchboardFeed.discriminator:
    case UpdateConfigMode.UpdateSwitchboardTwapFeed.discriminator:
    case UpdateConfigMode.UpdateFarmCollateral.discriminator:
    case UpdateConfigMode.UpdateFarmDebt.discriminator:
      buffer = (value as PublicKey).toBuffer();
      break;
    case UpdateConfigMode.UpdateBorrowRateCurve.discriminator:
      buffer = serializeBorrowRateCurve(value as BorrowRateCurve);
      break;
    case UpdateConfigMode.UpdateDebtWithdrawalCap.discriminator:
    case UpdateConfigMode.UpdateDepositWithdrawalCap.discriminator:
      valueArray = value as number[];
      buffer = Buffer.alloc(16);
      buffer.writeBigUint64LE(BigInt(valueArray[0]), 0);
      buffer.writeBigUInt64LE(BigInt(valueArray[1]), 8);
      break;
    case UpdateConfigMode.UpdateElevationGroup.discriminator:
      valueArray = value as number[];
      buffer = Buffer.alloc(20);
      for (let i = 0; i < valueArray.length; i++) {
        buffer.writeUIntLE(valueArray[i], i, 1);
      }
      break;
    case UpdateConfigMode.UpdateBorrowLimitsInElevationGroupAgainstThisReserve.discriminator:
      valueArray = value as number[];
      buffer = Buffer.alloc(32 * 8);
      for (let i = 0; i < valueArray.length; i++) {
        buffer.writeBigUint64LE(BigInt(valueArray[i]), i * 8);
      }
      break;
    default:
      buffer = Buffer.alloc(0);
  }

  return Uint8Array.from([...buffer]);
}

export function serializeBorrowRateCurve(curve: BorrowRateCurve): Buffer {
  const buffer = Buffer.alloc(8 * curve.points.length);
  buffer.writeUInt32LE(curve.points.length, 0);
  for (let i = 0; i < curve.points.length; i++) {
    buffer.writeUInt32LE(curve.points[i].utilizationRateBps, 8 * i);
    buffer.writeUInt32LE(curve.points[i].borrowRateBps, 4 + 8 * i);
  }
  return buffer;
}

export type ReserveWithAddress = {
  address: PublicKey;
  state: Reserve;
};

export type UpdateReserveIxnsArgs = {
  mode: number;
  value: Uint8Array;
};

export const modeMatches = (mode: number): boolean => {
  const validModes = [
    UpdateConfigMode.UpdateScopePriceFeed.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoScopeChain.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoScopeTwap.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoExpHeuristic.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoTwapDivergence.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoPriceMaxAge.discriminator + 1,
    UpdateConfigMode.UpdateTokenInfoTwapMaxAge.discriminator + 1,
  ];
  return validModes.includes(mode);
};

// Sort update reserve ixns, to first have the oracle config updates first
// In order to skip the validation for the scope config updates
export const sortIxnsByPriority = (updateReserveIxnsArgs: UpdateReserveIxnsArgs[]) => {
  return updateReserveIxnsArgs.sort((a, b) => {
    const isPriorityA = a.mode === 20 || a.mode === 16;
    const isPriorityB = b.mode === 20 || b.mode === 16;
    if (isPriorityA && !isPriorityB) {
      return -1;
    }
    if (isPriorityB && !isPriorityA) {
      return 1;
    }
    return 0;
  });
};
