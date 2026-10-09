import { FinancialDecimal, checkedDecimal, parseRate } from '../domain/numeric.js';
import { parseEngineVersion, parseIssuerId, parseTickNo } from '../domain/identifiers.js';
import type { EconomyRandom, MacroState, PolicyExpectation, Regime } from './types.js';

export const ECONOMY_ENGINE_VERSION = 'economy-v1' as const;
const D = FinancialDecimal;
const engineVersion = parseEngineVersion(ECONOMY_ENGINE_VERSION);
const PHI = new Map(['12', '42', '63', '84', '126'].map((halfLife) => [halfLife, new D('2').pow(new D('-1').div(halfLife))]));
export const INITIAL_MACRO: MacroState = Object.freeze({
  policyRate: '0.03', inflation: '0.02', outputGap: '0', industrialDemand: '100', consumerDemand: '100',
  metals: '100', energy: '100', fx: '100', creditStress: '0.2', riskAppetite: '0',
  regime: 'EXPANSION', regimeSinceTick: 0,
});
function text(value: InstanceType<typeof D>): string { return parseRate(checkedDecimal(value).toString()); }
function clamp(value: InstanceType<typeof D>, minimum: string, maximum: string): InstanceType<typeof D> {
  return D.max(minimum, D.min(maximum, value));
}
/** A bounded 12-uniform innovation with variance one; no stateful draw cursor. */
export function normalInnovation(random: EconomyRandom, tick: number, issuerId: string, channel: string): InstanceType<typeof D> {
  let total = new D('0');
  for (let drawIndex = 0; drawIndex < 12; drawIndex++) {
    const input = random.uniform({ engineVersion, tick: parseTickNo(tick), issuerId: parseIssuerId(issuerId), eventChannel: channel, drawIndex });
    if (typeof input !== 'string' || input.length > 300 || !/^(?:0(?:\.\d+)?|0)$/.test(input)) throw new Error('Invalid deterministic random output');
    const draw = new D(input);
    if (!draw.isFinite() || draw.lt('0') || draw.gte('1')) throw new Error('Invalid deterministic random range');
    total = total.plus(draw);
  }
  return total.minus('6');
}
function draw(random: EconomyRandom, tick: number, channel: string): InstanceType<typeof D> {
  const input = random.uniform({ engineVersion, tick: parseTickNo(tick), issuerId: parseIssuerId('economy_macro'), eventChannel: channel, drawIndex: 0 });
  if (typeof input !== 'string' || input.length > 300 || !/^0(?:\.\d+)?$/.test(input)) throw new Error('Invalid deterministic random output');
  const value = new D(input);
  if (value.lt('0') || value.gte('1')) throw new Error('Invalid deterministic random range');
  return value;
}
function revert(old: string, target: string, halfLife: string, noise: string, shock: InstanceType<typeof D>): InstanceType<typeof D> {
  const phi = PHI.get(halfLife);
  if (!phi) throw new Error('Unversioned macro half-life');
  return new D(target).plus(new D(old).minus(target).mul(phi)).plus(shock.mul(noise));
}
function nextRegime(previous: MacroState, tick: number, random: EconomyRandom): Regime {
  if (tick - previous.regimeSinceTick < 21) return previous.regime;
  const stress = new D(previous.creditStress);
  const inflation = new D(previous.inflation);
  const chance = new D('0.008').plus(stress.mul('0.015')).plus(new D(previous.outputGap).abs().mul('0.06'));
  if (draw(random, tick, 'regime-transition').gte(chance)) return previous.regime;
  if (stress.gt('0.65')) return 'RECESSION';
  if (inflation.gt('0.06') && new D(previous.energy).gt('125')) return 'SUPPLY_SHOCK';
  const next: Record<Regime, Regime> = { EXPANSION: 'SLOWDOWN', SLOWDOWN: 'RECESSION', RECESSION: 'RECOVERY', RECOVERY: 'EXPANSION', SUPPLY_SHOCK: 'SLOWDOWN' };
  return next[previous.regime];
}
/** Expectations are computed only from an explicitly published observation. */
export function policyExpectation(observation: MacroState, meetingTick: number): PolicyExpectation {
  const target = new D('0.03').plus(new D(observation.inflation).minus('0.02').mul('1.5'))
    .plus(new D(observation.outputGap).mul('0.4')).minus(new D(observation.creditStress).minus('0.2').mul('0.02'));
  const gap = target.minus(observation.policyRate);
  const up = clamp(new D('0.2').plus(gap.mul('45')), '0.02', '0.78');
  const down = clamp(new D('0.2').minus(gap.mul('45')), '0.02', '0.78');
  const unchanged = new D('1').minus(up).minus(down);
  return { meetingTick, decreaseProbability: text(down), unchangedProbability: text(unchanged), increaseProbability: text(up),
    expectedRate: text(clamp(new D(observation.policyRate).plus(up.minus(down).mul('0.0025')), '0', '0.15')) };
}
export function advanceMacro(previous: MacroState, tick: number, random: EconomyRandom): MacroState {
  const regime = nextRegime(previous, tick, random);
  const demandTarget: Record<Regime, string> = { EXPANSION: '106', SLOWDOWN: '97', RECESSION: '86', RECOVERY: '102', SUPPLY_SHOCK: '93' };
  const inflationTarget: Record<Regime, string> = { EXPANSION: '0.025', SLOWDOWN: '0.018', RECESSION: '0.005', RECOVERY: '0.02', SUPPLY_SHOCK: '0.075' };
  const stressTarget: Record<Regime, string> = { EXPANSION: '0.15', SLOWDOWN: '0.3', RECESSION: '0.7', RECOVERY: '0.3', SUPPLY_SHOCK: '0.5' };
  const n = (channel: string) => normalInnovation(random, tick, 'economy_macro', channel);
  const rateDrag = new D(previous.policyRate).minus('0.03').mul('25');
  const industrial = clamp(revert(previous.industrialDemand, demandTarget[regime], '63', '0.6', n('industrial')).minus(rateDrag), '30', '180');
  const consumer = clamp(revert(previous.consumerDemand, demandTarget[regime], '84', '0.35', n('consumer')).minus(rateDrag.mul('0.4')), '40', '160');
  const output = clamp(new D(industrial).plus(consumer).div('200').minus('1'), '-0.35', '0.35');
  const inflation = clamp(revert(previous.inflation, inflationTarget[regime], '84', '0.00035', n('inflation')).plus(output.mul('0.00015')), '-0.05', '0.2');
  const credit = clamp(revert(previous.creditStress, stressTarget[regime], '42', '0.008', n('credit')), '0', '1');
  const appetiteTarget = new D('0.2').minus(credit.mul('0.7')).toString();
  const appetite = clamp(revert(previous.riskAppetite, appetiteTarget, '12', '0.035', n('appetite')), '-1', '1');
  let rate = previous.policyRate;
  if (tick % 21 === 0) {
    const expected = policyExpectation({ ...previous, inflation: text(inflation), outputGap: text(output), creditStress: text(credit) }, tick);
    const decision = draw(random, tick, 'policy-meeting');
    const delta = decision.lt(expected.decreaseProbability) ? '-0.0025'
      : decision.lt(new D(expected.decreaseProbability).plus(expected.unchangedProbability)) ? '0' : '0.0025';
    rate = text(clamp(new D(previous.policyRate).plus(delta), '0', '0.15'));
  }
  return {
    policyRate: rate, inflation: text(inflation), outputGap: text(output), industrialDemand: text(industrial), consumerDemand: text(consumer),
    metals: text(clamp(revert(previous.metals, regime === 'SUPPLY_SHOCK' ? '125' : '100', '63', '0.9', n('metals')), '20', '250')),
    energy: text(clamp(revert(previous.energy, regime === 'SUPPLY_SHOCK' ? '145' : '100', '42', '1.1', n('energy')), '20', '300')),
    fx: text(clamp(revert(previous.fx, '100', '126', '0.45', n('fx')).plus(new D(previous.policyRate).minus(rate).mul('25')), '40', '220')),
    creditStress: text(credit), riskAppetite: text(appetite), regime,
    regimeSinceTick: regime === previous.regime ? previous.regimeSinceTick : tick,
  };
}

/** Statistical releases include an independently keyed measurement error, never a hidden-state answer. */
export function observeMacro(actual: MacroState, tick: number, random: EconomyRandom): MacroState {
  const observation = {
    ...actual,
    inflation: text(clamp(new D(actual.inflation).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-inflation').mul('0.0015')), '-0.05', '0.2')),
    outputGap: text(clamp(new D(actual.outputGap).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-output-gap').mul('0.003')), '-0.35', '0.35')),
    industrialDemand: text(clamp(new D(actual.industrialDemand).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-industrial').mul('0.35')), '30', '180')),
    consumerDemand: text(clamp(new D(actual.consumerDemand).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-consumer').mul('0.25')), '40', '160')),
    creditStress: text(clamp(new D(actual.creditStress).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-credit').mul('0.01')), '0', '1')),
    riskAppetite: text(clamp(new D(actual.riskAppetite).plus(normalInnovation(random, tick, 'economy_macro', 'measurement-appetite').mul('0.02')), '-1', '1')),
  };
  const regime: Regime = new D(observation.inflation).gt('0.06') && new D(observation.energy).gt('125') ? 'SUPPLY_SHOCK'
    : new D(observation.creditStress).gt('0.6') || new D(observation.industrialDemand).lt('90') ? 'RECESSION'
    : new D(observation.industrialDemand).gt('103') && new D(observation.consumerDemand).gt('101') ? 'EXPANSION'
    : new D(observation.outputGap).lt('-0.015') ? 'SLOWDOWN' : 'RECOVERY';
  return { ...observation, regime, regimeSinceTick: tick };
}
