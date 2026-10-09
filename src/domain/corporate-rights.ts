import { z } from 'zod';
import { FinancialDecimal as D, checkedDecimal, parsePrice, parseRate } from './numeric.js';

const nonnegative = z.string().max(96).refine((value) => {
  try { return new D(parseRate(value)).gte(0); } catch { return false; }
});
const rightSchema = z.strictObject({
  dividendId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  nominalPerShare: nonnegative, markPerShare: nonnegative, detach: z.boolean(),
}).refine((right) => new D(right.markPerShare).lte(right.nominalPerShare), 'A right mark cannot exceed its nominal claim');

export interface CorporateRightMark {
  readonly dividendId: string; readonly nominalPerShare: string;
  readonly markPerShare: string; readonly detach: boolean;
}
export interface CorporateRightsTransformation {
  readonly continuationMark: string; readonly attachedRightsMark: string;
  readonly detachedRights: readonly Omit<CorporateRightMark, 'detach'>[];
  /** Zero is a terminal reference, never an ordinary active quote. */
  readonly referencePrice: string;
  /** Change before detachment, separately attributed to the corporate action. */
  readonly referenceAdjustment: string;
  readonly priceMode: 'ORDINARY' | 'RIGHTS_ONLY' | 'EXTINGUISHED';
}

/**
 * Reclassify the same cum-right value into stock and a separate claim. A new
 * declaration uses existing stock value rather than adding its cash twice.
 * Public changes in recovery/discount update the right component independently.
 */
export function transformCorporateRights(input: Readonly<{
  previousPrice: string; previousAttachedRightsMark: string;
  nextRights: readonly CorporateRightMark[]; declaration?: boolean;
  modelContinuationMark?: string;
}>): CorporateRightsTransformation {
  const checked = z.strictObject({ previousPrice: nonnegative, previousAttachedRightsMark: nonnegative,
    nextRights: z.array(rightSchema).max(256), declaration: z.boolean().optional(), modelContinuationMark: nonnegative.optional(),
  }).parse(input);
  const previous = new D(checked.previousPrice); const previousRights = new D(checked.previousAttachedRightsMark);
  if (previousRights.gt(previous)) throw new Error('INCONSISTENT_ATTACHED_RIGHT_MARK');
  if (new Set(checked.nextRights.map((right) => right.dividendId)).size !== checked.nextRights.length) throw new Error('DUPLICATE_CORPORATE_RIGHT');
  const nextTotal = checked.nextRights.reduce((sum, right) => sum.plus(right.markPerShare), new D(0));
  // On announcement an obligation and its attached claim are one transfer.
  let continuation = checked.declaration ? previous.minus(nextTotal) : previous.minus(previousRights);
  let adjustment = new D(0);
  if (continuation.lt(0) || (continuation.isZero() && checked.modelContinuationMark !== undefined
    && new D(checked.modelContinuationMark).gt(0))) {
    // A quote below a fully valued entitlement is inconsistent. Reconcile both
    // marks in this corporate-action version; there is no fixed price floor.
    if (checked.modelContinuationMark === undefined) throw new Error('CORPORATE_REFERENCE_RECONCILIATION_REQUIRED');
    continuation = new D(checked.modelContinuationMark);
    adjustment = continuation.plus(nextTotal).minus(previous);
  } else if (!checked.declaration) adjustment = continuation.plus(nextTotal).minus(previous);
  const detached = checked.nextRights.filter((right) => right.detach).map(({ detach: _detach, ...right }) => Object.freeze(right));
  const attached = checked.nextRights.filter((right) => !right.detach).reduce((sum, right) => sum.plus(right.markPerShare), new D(0));
  const reference = continuation.plus(attached);
  const text = (value: InstanceType<typeof D>) => parseRate(checkedDecimal(value).toString());
  if (reference.gt(0)) parsePrice(text(reference));
  return Object.freeze({ continuationMark: text(continuation), attachedRightsMark: text(attached),
    detachedRights: Object.freeze(detached), referencePrice: text(reference), referenceAdjustment: text(adjustment),
    priceMode: reference.isZero() ? 'EXTINGUISHED' : continuation.isZero() ? 'RIGHTS_ONLY' : 'ORDINARY' });
}

/** A publicly estimated dividend claim, discounted to the same tick as its stock. */
export function dividendRightMark(dps: string, recoveryRatio: string, annualRate: string, remainingTicks: number): string {
  const nominal = new D(nonnegative.parse(dps)); const recovery = new D(nonnegative.parse(recoveryRatio));
  const rate = new D(nonnegative.parse(annualRate));
  if (recovery.gt(1) || rate.gt(1) || !Number.isSafeInteger(remainingTicks) || remainingTicks < 0 || remainingTicks > 1_000_000) throw new Error('INVALID_DIVIDEND_RIGHT_MARK');
  return parseRate(checkedDecimal(nominal.mul(recovery).div(new D(1).plus(rate).pow(new D(remainingTicks).div(252)))).toString());
}
