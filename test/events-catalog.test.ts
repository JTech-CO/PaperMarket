import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { FinancialDecimal as D } from '../src/domain/numeric.js';
import { APPENDIX_CATALOG_ROWS } from '../src/events/catalog-data.js';
import { CATALOG_RULES } from '../src/events/catalog-rules.js';
import { EVENT_CATALOG, EVENT_CATALOG_VERSION, getEventTemplate } from '../src/events/catalog.js';
import { EVENT_PROFILES } from '../src/events/types.js';
import { eventTemplateSchema, validateEventCatalog } from '../src/events/validator.js';

test('catalog preserves all 240 appendix IDs, titles, profiles and observed targets verbatim', () => {
  const source = readFileSync(resolve('docs/PaperMarket_Technical_Whitepaper_KR.md'), 'utf8');
  const rows = [...source.matchAll(/^\| ((?:HGI|DNL|TLR|NXC|VTR|AUR|LMB|RVI|MAC|XCO)-\d{2}) \| (.*?) \| (.*?) \| (.*?) \|$/gm)]
    .map(match => ({ id: match[1], title: match[2], profile: match[3], observedTarget: match[4] }));
  assert.equal(rows.length, 240);
  assert.deepEqual(EVENT_CATALOG.map(({ id, title, profile, observedTarget }) => ({ id, title, profile, observedTarget })), rows);
  assert.deepEqual(APPENDIX_CATALOG_ROWS.map(({ id, title, profile, observedTarget }) => ({ id, title, profile, observedTarget })), rows);
  for (const group of ['HGI', 'DNL', 'TLR', 'NXC', 'VTR', 'AUR', 'LMB', 'RVI', 'MAC', 'XCO']) {
    assert.deepEqual(EVENT_CATALOG.filter(item => item.id.startsWith(`${group}-`)).map(item => item.id),
      Array.from({ length: 24 }, (_, index) => `${group}-${String(index + 1).padStart(2, '0')}`));
  }
});

test('all 240 executable definitions pass the strict engine validator', () => {
  const validated = validateEventCatalog(EVENT_CATALOG);
  assert.equal(validated.length, 240);
  assert.equal(CATALOG_RULES.length, 240);
  assert.equal(new Set(CATALOG_RULES.map(rule => rule.id)).size, 240);
  assert.equal(EVENT_CATALOG_VERSION, 1);
  assert.deepEqual(new Set(validated.map(item => item.profile)), new Set(EVENT_PROFILES));
  assert.throws(() => getEventTemplate('HGI-25'), RangeError);
});

test('each definition carries bounded units, eligibility, accounting channel and publication detail', () => {
  for (const item of EVENT_CATALOG) {
    assert.ok(item.eligibilityNotes.length >= 40, item.id);
    assert.ok(item.effectNotes.length >= 45, item.id);
    assert.ok(item.sector.length >= 4, item.id);
    assert.ok(new D(item.sectorExposure).gt(0) && new D(item.sectorExposure).lte(1), item.id);
    assert.ok(new D(item.magnitude.min).lte(item.magnitude.max), item.id);
    assert.ok(item.duration.min >= 1 && item.duration.max <= 252, item.id);
    assert.equal(item.outcomes.reduce((sum, outcome) => sum.plus(outcome.probability), new D(0)).toString(), '1', item.id);
    for (const placeholder of ['{subject}', '{actual}', '{expected}', '{previous}', '{effectiveTick}', '{publishTick}', '{duration}', '{unit}']) assert.ok(item.publicCopy.includes(placeholder), item.id);
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.outcomes), item.id);
    for (const successorId of item.successors) {
      assert.notEqual(getEventTemplate(successorId).id, item.id, `${item.id}->${successorId}`);
    }
    assert.equal(Object.keys(item).some(key => /priceShock|priceReturn|priceMultiplier|futureTruth/.test(key)), false, item.id);
  }
});

test('NEW denotes independent hazard eligibility and can also confirm a parent cause without a second budget draw', () => {
  // A genuine quality incident can arise independently, or confirm an existing quality rumor.
  const rumor = getEventTemplate('DNL-15');
  assert.deepEqual(rumor.successors, ['DNL-11', 'DNL-16']);
  for (const id of rumor.successors) assert.equal(getEventTemplate(id).mode, 'NEW');
  assert.equal(validateEventCatalog(EVENT_CATALOG).length, 240);
  assert.throws(() => validateEventCatalog(EVENT_CATALOG.map(item => item.id === rumor.id ? { ...item, successors: [item.id] } : item)));
  assert.throws(() => validateEventCatalog(EVENT_CATALOG.map(item => item.id === rumor.id ? { ...item, successors: ['DNL-99'] } : item)));
});

test('disclosures and regular macro results derive from domain results with zero hazard', () => {
  const observed = EVENT_CATALOG.filter(item => item.profile === 'DISCLOSURE' || /^MAC-0[1-9]$/.test(item.id));
  assert.ok(observed.length > 9);
  for (const item of observed) {
    assert.equal(item.mode, 'DOMAIN_ONLY', item.id);
    assert.equal(item.hazardWeight, '0', item.id);
    assert.ok(item.eligibility.includes('DOMAIN_RESULT'), item.id);
    assert.deepEqual(item.outcomes, [{ id: 'domainResult', probability: '1', magnitudeMultiplier: '0' }], item.id);
  }
  for (const id of ['RVI-10', 'RVI-20']) {
    assert.equal(getEventTemplate(id).profile, 'DISCLOSURE');
    assert.deepEqual(getEventTemplate(id).magnitude, { min: '0', max: '0' });
  }
});

test('financial events distinguish equity, AR timing, support, disposal and debt repayment', () => {
  const expected = {
    'NXC-21': 'EQUITY_ISSUE', 'VTR-23': 'EQUITY_ISSUE', 'LMB-23': 'EQUITY_ISSUE',
    'VTR-20': 'COLLECTION_DELAY', 'LMB-19': 'COLLECTION_DELAY', 'RVI-16': 'COLLECTION_DELAY',
    'XCO-21': 'PAYMENT_EXTENSION', 'TLR-24': 'ASSET_DISPOSAL', 'RVI-22': 'ASSET_DISPOSAL',
    'RVI-07': 'DEBT_REPAYMENT', 'RVI-23': 'DEBT_REPAYMENT', 'AUR-09': 'CONDITIONAL_SUPPORT',
    'LMB-09': 'CONDITIONAL_SUPPORT', 'MAC-22': 'CONDITIONAL_SUPPORT', 'AUR-13': 'SUPPORT_WITHDRAWAL',
    'MAC-23': 'SUPPORT_WITHDRAWAL', 'AUR-19': 'FAILED_FUNDING', 'LMB-20': 'FAILED_FUNDING',
  };
  for (const [id, action] of Object.entries(expected)) assert.equal(getEventTemplate(id).financeAction, action, id);
  for (const id of ['TLR-08', 'TLR-19', 'RVI-03', 'RVI-08', 'RVI-13', 'RVI-17']) {
    const item = getEventTemplate(id);
    assert.equal(item.financeAction, 'SPREAD', id);
    assert.equal(item.unit, 'PERCENTAGE_POINTS', id);
    assert.ok(item.eligibility.includes('MATURE_DEBT'), id);
  }
});

test('investments preserve research/marketing expense and physical commissioning conditions', () => {
  for (const id of ['NXC-22', 'VTR-21', 'XCO-23', 'XCO-24']) assert.equal(getEventTemplate(id).investmentAccounting, 'RESEARCH_EXPENSE', id);
  assert.equal(getEventTemplate('DNL-21').investmentAccounting, 'MARKETING_EXPENSE');
  for (const id of ['HGI-21', 'VTR-22', 'RVI-21', 'XCO-09', 'XCO-11', 'XCO-19']) assert.equal(getEventTemplate(id).investmentAccounting, 'CAPITALIZE', id);
  assert.equal(getEventTemplate('XCO-19').investmentOwner, 'SUPPLIER');
  assert.equal(getEventTemplate('XCO-09').investmentOwner, 'CUSTOMER');
  assert.equal(getEventTemplate('HGI-24').investmentPurpose, 'RELOCATION');
  assert.equal(getEventTemplate('RVI-12').investmentPurpose, 'MAINTENANCE');
  assert.equal(getEventTemplate('LMB-21').investmentPurpose, 'ACQUISITION');
  for (const id of ['HGI-05', 'VTR-05', 'RVI-05']) {
    assert.ok(getEventTemplate(id).eligibility.includes('COMPLETED_INVESTMENT'), id);
    assert.equal(getEventTemplate(id).mode, 'FOLLOWUP', id);
  }
  assert.equal(getEventTemplate('HGI-08').target, 'productMix');
  assert.equal(getEventTemplate('HGI-09').target, 'inventoryTurnover');
  assert.equal(getEventTemplate('VTR-10').contractRole, 'CUSTOMER');
  assert.equal(getEventTemplate('VTR-10').target, 'rawMaterials');
});

test('project failure and success share cause locks while new pipelines keep a new project key', () => {
  for (const [failure, success] of [['LMB-13', 'LMB-01'], ['AUR-11', 'AUR-02']] as const) {
    assert.equal(getEventTemplate(failure).projectKey, getEventTemplate(success).projectKey);
    assert.equal(getEventTemplate(failure).operation, 'CANCEL');
    assert.ok(getEventTemplate(failure).eligibility.includes('ACTIVE_PROJECT'));
    assert.ok(getEventTemplate(success).eligibility.includes('ACTIVE_PROJECT'));
    assert.equal(getEventTemplate(failure).hazardWeight, '0');
  }
  assert.notEqual(getEventTemplate('LMB-21').projectKey, getEventTemplate('LMB-13').projectKey);
  assert.equal(getEventTemplate('AUR-09').projectKey, getEventTemplate('AUR-13').projectKey);
});

test('all relation events name two distinct real transaction roles and matching followup projects', () => {
  for (const item of EVENT_CATALOG.filter(item => item.scope === 'RELATION')) {
    assert.equal(item.subjects.length, 2, item.id);
    assert.notEqual(item.subjects[0], item.subjects[1], item.id);
    assert.ok(item.projectKey, item.id);
    for (const successorId of item.successors) {
      assert.deepEqual(getEventTemplate(successorId).subjects, item.subjects, `${item.id}->${successorId}`);
      assert.equal(getEventTemplate(successorId).projectKey, item.projectKey, `${item.id}->${successorId}`);
    }
  }
  assert.deepEqual(getEventTemplate('XCO-21').subjects, ['HGI', 'VTR']);
  assert.deepEqual(getEventTemplate('XCO-22').subjects, ['VTR', 'DNL']);
  assert.deepEqual(getEventTemplate('XCO-23').subjects, ['NXC', 'LMB']);
});

test('unconfirmed information is public belief and cannot run as a confirmed transaction', () => {
  for (const id of ['DNL-15', 'AUR-22']) {
    const item = getEventTemplate(id);
    assert.equal(item.profile, 'BELIEF');
    assert.equal(item.certainty, 'RUMOR');
    assert.equal(item.target, 'sentiment');
    assert.equal(item.decay, 'HALF_LIFE');
    assert.ok(item.halfLifeTicks !== null && item.halfLifeTicks >= 3 && item.halfLifeTicks <= 12);
  }
  for (const id of ['HGI-22', 'NXC-23', 'DNL-24']) assert.match(getEventTemplate(id).effectNotes, /주식.*교환|주식교환/);
});

test('strict schema rejects unknown price commands, malformed outcomes and invalid sector exposure', () => {
  const item = getEventTemplate('HGI-02');
  assert.equal(eventTemplateSchema.safeParse({ ...item, priceReturn: '-0.1' }).success, false);
  assert.equal(eventTemplateSchema.safeParse({ ...item, sectorExposure: '1.01' }).success, false);
  assert.equal(eventTemplateSchema.safeParse({ ...item, publicCopy: '숨겨진 값 {privateCash}' }).success, false);
  assert.equal(eventTemplateSchema.safeParse({ ...item, outcomes: [{ id: 'bad', probability: '0.9', magnitudeMultiplier: '1' }] }).success, false);
  assert.throws(() => validateEventCatalog(EVENT_CATALOG.slice(1)));
});
