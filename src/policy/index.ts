import { z } from 'zod';

export const POLICY_VERSION = 'trial-v6';
export const TERMS_VERSION = 'terms-trial-v6';
export const PRIVACY_VERSION = 'privacy-trial-v6';
export const POLICY_EFFECTIVE_DATE = '2026-10-09';

/** The user supplies acknowledgements, never the accepted document versions. */
const openingAcknowledgementsSchema = z.strictObject({
  age14Plus: z.literal(true),
  agreeTerms: z.literal(true),
});

export interface OpeningAcknowledgements {
  readonly age14Plus: true;
  readonly agreeTerms: true;
  readonly termsVersion: typeof TERMS_VERSION;
  readonly privacyVersion: typeof PRIVACY_VERSION;
}

export class OpeningAcknowledgementsError extends Error {
  constructor() {
    super('만 14세 이상 확인과 이용약관 동의를 각각 명시적으로 선택해 주세요. /help와 /privacy에서 먼저 내용을 확인할 수 있습니다.');
    this.name = 'OpeningAcknowledgementsError';
  }
}

export function validateOpeningAcknowledgements(input: unknown): OpeningAcknowledgements {
  const parsed = openingAcknowledgementsSchema.safeParse(input);
  if (!parsed.success) throw new OpeningAcknowledgementsError();
  return Object.freeze({
    age14Plus: true, agreeTerms: true,
    termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION,
  });
}

// These strings are inserted into Discord plain text. Mentions, Markdown and
// invisible direction/control characters are rejected before any response.
const operatorNameSchema = z.string().trim().min(1).max(80)
  .regex(/^[\p{L}\p{N} .,'&-]+$/u);
const supportEmailSchema = z.string().trim().min(3).max(254)
  .email().regex(/^[A-Za-z0-9.!#$%&'+/=^{}-]+@[A-Za-z0-9.-]+$/);
const supportHttpsSchema = z.string().trim().min(9).max(254).refine((value) => {
  if (/[\p{C}\s<>`*_~|\\[\]()]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== ''
      && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
});

const policyOperatorSchema = z.strictObject({
  operatorName: operatorNameSchema,
  supportContact: z.union([supportEmailSchema, supportHttpsSchema]),
}).readonly();
export type PolicyOperator = z.output<typeof policyOperatorSchema>;

export function validatePolicyOperator(input: unknown): PolicyOperator {
  const parsed = policyOperatorSchema.safeParse(input);
  if (!parsed.success) throw new Error('POLICY_OPERATOR_CONFIGURATION_INVALID');
  return parsed.data;
}

export function renderTermsNotice(input: PolicyOperator): string {
  const operator = validatePolicyOperator(input);
  return [
    `PaperMarket 시험 이용약관 · ${TERMS_VERSION} · ${POLICY_EFFECTIVE_DATE}`,
    `운영 주체: ${operator.operatorName} / 문의: ${operator.supportContact}`,
    '기업과 자산, 현금, 거래는 모두 가상입니다. 가상자금을 구매·환전·양도하거나 현실의 수익·보상으로 받을 수 없습니다. 서비스는 투자 판단과 결과 추적을 위한 모의투자이며 실제 투자 추천이나 수익 보장이 아닙니다.',
    '단계 5는 공개 기업 정보·일정·차트·성과·기준전략과 개인 알림함·내보내기를 제공합니다. 시세는 기업 회계·금리·공개 전망·가상 사건·배당·청산으로 계산하며 참가자 수·주문량이 바꾸지 않습니다. 사건은 실제 뉴스가 아닙니다. 확정 배당 권리는 매도 후에도 남고 지급이 줄거나 0이 될 수 있습니다. 청산 손실은 남으며 새 회사 주식을 자동 지급하지 않습니다.',
    '계좌 개설은 만 14세 이상 확인과 약관 동의를 각각 선택해야 합니다. 생년월일은 받지 않습니다. Discord 계정 관리 책임은 이용자에게 있으며 타인의 계정·주문을 사용하거나 확인 절차를 우회할 수 없습니다.',
    '최초자금은 시장별 같은 Discord 사용자에게 한 번만 지급합니다. 서버 탈퇴·재가입, 봇 재초대, 이름 변경으로 재지급되지 않습니다. 주문은 표시된 수량·시세·비용·유효기간을 확인한 뒤 확정되며 취소·만료·거절된 주문은 체결되지 않습니다.',
    '지정가·스톱은 확인 후 현금 또는 주식을 예약하며 이미 조건을 충족하면 현재 시세로 체결합니다. 그 외에는 새 확정 시세로 조건을 평가합니다. 스톱은 갭 하락 시 손실액을 보장하지 않습니다. 기본 유효기간은 전체 시장 21틱이며 만료 틱에는 체결하지 않습니다. 배당락·교환·소멸 때 미체결 주문을 취소합니다. 예약 현금은 총 현금에 포함되고 이자를 얻으며 예약 주식도 배당 권리를 유지합니다. /orders에서 본인 주문을 취소할 수 있습니다.',
    '차트는 확정 틱 자료이고 예측이 아닙니다. CASH·HOLD8 비교는 본인 개설 시점 기준이며, 복원 불가능한 과거 첫 구간은 표시합니다. PM8은 도입 시점부터의 공개 기준입니다. /alerts 알림함은 비공개이며 DM은 기본 꺼짐입니다. 명시적으로 켜고 언제든 끌 수 있습니다. 발송 장애·재시도·중복 가능성이 있어 알림이 체결 보장은 아닙니다.',
    '시스템 점검·오류와 Discord 장애로 이용이 중단될 수 있습니다. 단계 6은 암호화 백업·새 파일 복구를 추가하며, 이전 사본 복구 때 이후 종료·DM 철회 요청을 대조해 다시 반영해야 합니다. 실제 별도 장치 복제·출시 검토 완료는 아닙니다. 운영자는 오류와 처리 결과를 안내하며 관련 법령에 따른 책임을 일괄 배제하지 않습니다.',
    '개인정보 처리와 권리 행사 방법은 /privacy에서 별도로 안내합니다. /close로 계좌를 닫으면 다시 열 수 없으며 최초자금도 재지급되지 않습니다. 중요한 변경은 적용 전 공지하며 이전 문서 버전을 보관합니다. 이 문서는 개발 단계 초안으로, 실제 공개 전 운영 사실과 전문가 검토가 필요합니다.',
  ].join('\n\n');
}

export function renderPolicyNotice(input: PolicyOperator): string {
  const operator = validatePolicyOperator(input);
  return [
    'PaperMarket은 가상 기업·자금으로 투자 판단을 연습하는 모의투자입니다. 단계 5는 기업·일정·차트·성과·기준전략 조회와 알림함·내보내기를 제공합니다. 공개 전망·가상 사건·금리·배당·청산으로 시세와 자산을 계산하며 현실의 투자 추천·수익·현금 보상이 아닙니다.',
    '계좌 개설 전 /help의 시험 이용약관과 /privacy의 개인정보 처리 안내를 확인해 주세요. /open에서 만 14세 이상과 약관 동의를 각각 명시적으로 선택합니다. 선택하지 않으면 계좌를 개설하지 않으며 생년월일은 수집하지 않습니다.',
    '계좌 식별·명령 처리·모의자산 기록에 필요한 Discord 사용자·서버·Interaction ID, 가상계좌·주문·체결·원장·성과 이력, 알림 설정·알림함, 확인 시각과 문서 버전을 로컬 SQLite에 기록합니다. 계좌 이용계약 이행을 위한 처리이며 마케팅 동의를 요구하지 않습니다. 선택 DM은 기본 꺼짐이며 /alerts에서 켜거나 철회합니다. /export에서 본인 기록을 받습니다.',
    `운영 주체: ${operator.operatorName} / 개인정보·권리 행사 문의: ${operator.supportContact}`,
  ].join('\n\n');
}

export function renderPrivacyNotice(input: PolicyOperator): string {
  const operator = validatePolicyOperator(input);
  return [
    `PaperMarket 개인정보 처리 안내 초안 · ${PRIVACY_VERSION} · ${POLICY_EFFECTIVE_DATE}`,
    `운영 주체·개인정보 문의 담당: ${operator.operatorName}\n권리 행사 접수: ${operator.supportContact}`,
    '처리 항목: Discord 사용자·서버·Interaction ID, 계좌·가상자산·주문·체결·원장, 조건가격·유효기간·예약 자산, 배당·청산 권리·분수 잔액, 성과·기준전략·내보내기 기록, 관심종목·가격 알림·알림함·발송 상태, 선택 DM 동의 시각·버전, 연령 확인·약관 버전. 본인 식별·중복 방지·자산 복원·조회·알림에 로컬 SQLite를 사용합니다.',
    '계좌 이용계약 이행에 필요한 처리이며 포괄적 개인정보 필수 동의를 받지 않습니다. 만 14세 미만은 개설할 수 없고 연령은 자기 확인입니다. 생년월일·실명·이메일·전화·주소·사진·채팅·실제 금융계좌·결제정보는 수집하지 않습니다.',
    '개인 조회·CSV/JSON 첨부는 본인 Discord 비공개 응답입니다. 봇은 내보내기 파일을 디스크에 저장하지 않습니다. 알림함은 최근 1,000건, 중복 방지 키·발송 상태는 계좌 종료까지 보관합니다. DM은 기본 꺼짐이며 /alerts에서 별도로 켜고 끕니다. 끄면 대기 발송을 취소하지만 이미 보낸 메시지는 회수하지 않습니다.',
    'Discord는 요청·응답·선택 DM을 전달하는 외부 플랫폼입니다. 서버 위치·해외 처리·보유기간·이전 근거는 공개 전 확인·고지해야 합니다. 내보내기 첨부·이미 보낸 DM의 플랫폼 보관·삭제도 별도입니다.',
    '/close 확인 시 미체결 조건주문을 취소하고 원래 Discord ID·약관 기록·원본 토큰·개인 캐시·알림 설정·알림함·발송 상태·내보내기 접근 기록을 제거·무효화합니다. 인증된 Discord 명령과 소유자 확인에 의존하며 별도 재로그인은 강제하지 않습니다.',
    '추가형 금융원장·조건주문과 예약 전표·성과·기준전략 기록·내부 계좌 ID·서버 범위 HMAC 연결값은 시장 존속기간 동안 무결성·최초자금 재지급 방지에 보관합니다. HMAC은 익명정보가 아니며 가명정보입니다. 계좌 재개설은 불가하며 전체 삭제·DB/WAL/백업 파기는 운영자 절차가 필요합니다.',
    '본인 열람은 /portfolio·/history·/performance·/orders·/alerts, 내보내기는 /export입니다. 정정·전체 삭제·처리정지는 위 접수처로 요청하고 결과·제한 사유를 안내받습니다. 마케팅·광고 추적·웹 쿠키·외부 분석·LLM 전송: 해당 없음.',
    '보안: 소유자 확인·입력 범위·명령 제한·일회성 주문 확인, 독립 키의 암호화 백업을 적용합니다. 기본 보관은 최근 24개·7일별·4주별 사본의 합집합이며 별도 경로 복제는 운영자 설정입니다. 이전 사본은 종료 전 개인정보를 포함할 수 있어 복구 전 종료·DM 철회 요청을 수동 대조합니다. SQLite/WAL·임시 평문·Windows ACL·접근기록은 운영자가 관리해야 합니다.',
    '자동 계산은 모의 시세·거래·이자·배당·청산 권리·성과·기준전략·가격 알림입니다. 종료 계좌의 기존 권리는 무결성 정산에 남고 사용할 수 없습니다. 현실의 신용·채용·보험 심사는 없습니다. 계산·제한 사유 설명은 접수처로 요청할 수 있습니다.',
    '개발 초안이며 법률·출시 검토 완료가 아닙니다. 공개 전 운영 사실과 전문가 검토가 필요합니다. 변경을 적용 전 공지하고 이전 버전을 보관합니다.',
  ].join('\n\n');
}

export function renderAccountClosureNotice(input: PolicyOperator): string {
  const operator = validatePolicyOperator(input);
  return [
    'PaperMarket 계좌를 닫기 전 처리 내용을 확인해 주세요.',
    '/close confirmed:true는 본인 계좌의 이용을 영구 종료하고 미체결 조건주문을 취소·예약 해제합니다. 원래 Discord 사용자 ID·약관 확인·원본 확인 토큰·개인 캐시·관심종목·가격 알림·DM 설정·알림함·발송 상태·내보내기 접근 기록을 제거·무효화합니다. 계좌는 복구하거나 다시 열 수 없으며 최초자금도 재지급되지 않습니다.',
    '금융원장·조건주문/예약 전표·성과·기준전략·내부 계좌 ID·서버 범위 HMAC 연결값은 시장 존속기간 동안 무결성과 재지급 방지에 남습니다. HMAC은 가명정보이며 이 명령은 모든 기록의 전체 삭제가 아닙니다. 이전 암호화 백업에는 종료 전 개인정보가 남을 수 있고 복구 전 종료·DM 철회 요청을 수동 대조해야 합니다. 이미 전달된 첨부·DM과 DB/WAL/백업의 파기는 별도 절차가 필요합니다.',
    '확인 선택은 기본 꺼짐이며, 명령을 보낸 Discord 사용자의 계좌만 닫습니다. 현재 Discord 인증에 의존하므로 계정 접근 권한을 안전하게 관리해 주세요.',
    `전체 삭제·처리정지·기타 권리 행사 접수: ${operator.supportContact}`,
  ].join('\n\n');
}
