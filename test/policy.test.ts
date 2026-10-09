import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpeningAcknowledgementsError, POLICY_VERSION, PRIVACY_VERSION, TERMS_VERSION,
  renderAccountClosureNotice, renderPolicyNotice, renderPrivacyNotice, renderTermsNotice,
  validateOpeningAcknowledgements, validatePolicyOperator,
} from '../src/policy/index.js';

const operator = { operatorName: 'PaperMarket 시험 담당', supportContact: 'support@example.test' };

test('opening requires two explicit true booleans and injects document versions on the server', () => {
  for (const input of [
    null, undefined, {}, { age14Plus: true }, { age14Plus: false, agreeTerms: true },
    { age14Plus: true, agreeTerms: false }, { age14Plus: 'true', agreeTerms: true },
    { age14Plus: true, agreeTerms: true, termsVersion: 'forged' },
    { age14Plus: true, agreeTerms: true, acceptPrivacy: true },
  ]) assert.throws(() => validateOpeningAcknowledgements(input), OpeningAcknowledgementsError);
  const acknowledgements = validateOpeningAcknowledgements({ age14Plus: true, agreeTerms: true });
  assert.deepEqual(acknowledgements, { age14Plus: true, agreeTerms: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
  assert.equal(Object.isFrozen(acknowledgements), true);
  assert.equal(POLICY_VERSION, 'trial-v6');
});

test('operator configuration rejects mentions, invisible controls, unsafe links and excessive lengths', () => {
  assert.deepEqual(validatePolicyOperator(operator), operator);
  assert.equal(validatePolicyOperator({ ...operator, supportContact: 'https://example.test/privacy' }).supportContact, 'https://example.test/privacy');
  for (const operatorName of ['', '@everyone', '<@10000000000000001>', '[operator](https://bad.test)', '담당\u202e자', 'x'.repeat(81)]) {
    assert.throws(() => validatePolicyOperator({ ...operator, operatorName }), /POLICY_OPERATOR_CONFIGURATION_INVALID/);
  }
  for (const supportContact of ['', 'javascript:alert(1)', 'http://example.test', 'https://user:password@example.test', 'https://example.test/#fragment', '@everyone', 'support@example.test\n@everyone', 'x'.repeat(255)]) {
    assert.throws(() => validatePolicyOperator({ ...operator, supportContact }), /POLICY_OPERATOR_CONFIGURATION_INVALID/);
  }
});

test('notices fit a Discord message and describe the implemented trial without invented identity or deletion promises', () => {
  const longestOperator = { operatorName: '가'.repeat(80), supportContact: `https://example.test/${'a'.repeat(233)}` };
  assert.equal(longestOperator.supportContact.length, 254);
  for (const render of [renderAccountClosureNotice, renderPolicyNotice, renderPrivacyNotice, renderTermsNotice]) {
    const text = render(operator);
    assert.ok(text.length <= 2_000, `Discord notice exceeds the content limit: ${text.length}`);
    assert.ok(render(longestOperator).length <= 2_000);
    assert.match(text, /PaperMarket/);
    assert.match(text, /support@example\.test/);
    assert.throws(() => render({ ...operator, operatorName: '@everyone' }), /POLICY_OPERATOR_CONFIGURATION_INVALID/);
  }
  assert.match(renderPrivacyNotice(operator), /시장 존속기간/);
  assert.match(renderPrivacyNotice(operator), /익명정보가 아니며 가명정보/);
  assert.match(renderAccountClosureNotice(operator), /confirmed:true/);
  assert.match(renderAccountClosureNotice(operator), /전체 삭제가 아닙니다/);
  assert.match(renderPrivacyNotice(operator), /초안/);
  assert.match(renderTermsNotice(operator), /한 번만 지급/);
  assert.match(renderPolicyNotice(operator), /각각 명시적으로 선택/);
  assert.match(renderTermsNotice(operator), /지정가·스톱/);
  assert.match(renderTermsNotice(operator), /스톱은 갭 하락 시 손실액을 보장하지/);
  assert.match(renderTermsNotice(operator), /만료 틱에는 체결하지/);
  assert.match(renderPrivacyNotice(operator), /조건가격·유효기간/);
  assert.match(renderPrivacyNotice(operator), /조건주문과 예약 전표/);
  assert.match(renderAccountClosureNotice(operator), /미체결 조건주문을 취소·예약 해제/);
  assert.match(renderTermsNotice(operator), /단계 5/);
  assert.match(renderPrivacyNotice(operator), /DM은 기본 꺼짐/);
  assert.match(renderPrivacyNotice(operator), /최근 1,000건/);
  assert.match(renderPrivacyNotice(operator), /CSV\/JSON/);
  assert.match(renderPrivacyNotice(operator), /디스크에 저장하지/);
  assert.match(renderPrivacyNotice(operator), /켜고 끕니다/);
  assert.match(renderAccountClosureNotice(operator), /알림함·발송 상태/);
  assert.match(renderPrivacyNotice(operator), /성과·기준전략 기록/);
  assert.match(renderTermsNotice(operator), /PM8은 도입 시점/);
  assert.match(renderPrivacyNotice(operator), /암호화 백업/);
  assert.match(renderPrivacyNotice(operator), /24개·7일별·4주별/);
  assert.match(renderPrivacyNotice(operator), /수동 대조/);
  assert.match(renderPrivacyNotice(operator), /Windows ACL/);
  assert.match(renderAccountClosureNotice(operator), /종료 전 개인정보/);
});
