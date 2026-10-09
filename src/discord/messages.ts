import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { FinancialDecimal } from '../domain/numeric.js';

export const UI_COLORS = Object.freeze({ neutral: 0x6B7280, up: 0x15803D, down: 0xB91C1C });

/** Plain text is bounded before Markdown escaping. Mentions are also disabled on every message. */
export function safeText(value: string, maximum = 100): string {
  return escapeMarkdown(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@/g, '@\u200b').slice(0, maximum));
}

export function displayNumber(value: string, decimalPlaces = 2): string {
  const number = new FinancialDecimal(value);
  // Tiny nonzero prices and money remain visible rather than being shown as zero.
  if (!number.isZero() && number.abs().lt(new FinancialDecimal(10).pow(-decimalPlaces))) return number.toString();
  if (number.abs().gte('1e15')) return number.toSignificantDigits(12).toString();
  const [whole = '0', fraction] = number.toFixed(decimalPlaces).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** A confirmation must show the actual terms, including settled fractions beyond two decimal places. */
export function displayExact(value: string, minimumDecimalPlaces = 2): string {
  const number = new FinancialDecimal(value);
  const text = number.toString();
  if (text.includes('e')) return text;
  const [whole = '0', fraction = ''] = text.split('.');
  const displayedFraction = fraction.padEnd(minimumDecimalPlaces, '0');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${displayedFraction ? `.${displayedFraction}` : ''}`;
}

export function displayDirection(value: string): string {
  const number = new FinancialDecimal(value);
  if (number.isZero()) return '보합 0.00%';
  return `${number.isPositive() ? '상승 +' : '하락 -'}${displayNumber(number.abs().mul(100).toString())}%`;
}

export function baseEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setColor(UI_COLORS.neutral).setTitle(title.slice(0, 40))
    .setDescription(description.slice(0, 1_200)).setFooter({ text: '가상 시장 · 실거래 아님' });
}

const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  GUILD_ONLY: '서버 안에서 명령을 실행하세요. DM에서는 시장을 선택할 수 없습니다.',
  PERMISSION_DENIED: '서버 관리 권한이 있어야 /setup을 실행할 수 있습니다.',
  CHANNEL_PERMISSION_DENIED: '선택 채널에 채널 보기·메시지 보내기·Embed·메시지 기록 보기 권한을 허용한 후 /setup을 다시 실행하세요.',
  INVALID_CHANNEL: '현재 서버의 기존 텍스트 채널을 선택하세요.',
  INVALID_INPUT: '입력 형식을 확인하세요. 시장가 매수는 금액·가용 현금 비율(25%·50%·100%)·수량 중 하나, 매도는 수량·전량 중 하나입니다. 금액은 수수료를 포함하며 양수여야 합니다. 지정가·스톱은 수량·조건가격이 필요하고 금액·비율·전량과 함께 사용할 수 없습니다. 스톱은 매도만 지원하고 유효기간은 1~10,000틱 또는 취소할 때까지입니다.',
  MARKET_NOT_FOUND: '아직 시장이 없습니다. 서버 관리자에게 /setup을 요청하세요.',
  MARKET_UNAVAILABLE: '시장이 중단되어 주문을 처리할 수 없습니다. /status에서 상태를 확인하세요.',
  MARKET_PAUSED: '시장이 중단되어 주문을 처리할 수 없습니다. /status에서 상태를 확인하세요.',
  MARKET_UPDATING: '시세 확정 중입니다. 잠시 후 새 주문을 만드세요.',
  ACCOUNT_NOT_FOUND: '먼저 /help의 안내를 확인하고 /open으로 모의계좌를 개설하세요.',
  CONSENT_REQUIRED: '계좌 개설에는 만 14세 이상 확인과 /help의 이용약관 동의가 필요합니다.',
  ACKNOWLEDGEMENTS_REQUIRED: '계좌 개설에는 만 14세 이상 확인과 /help의 이용약관 동의가 필요합니다.',
  CONSENT_VERSION_CHANGED: '이용 안내가 개정되었습니다. /help를 확인하고 /open으로 다시 확인하세요.',
  ACCOUNT_CLOSED: '이 계좌는 이용이 중단되었습니다. /help의 운영자 연락 경로로 문의하세요.',
  SYMBOL_NOT_FOUND: '종목을 찾을 수 없습니다. /market에서 심볼을 확인하세요.',
  INSUFFICIENT_CASH: '수수료를 포함한 현금이 부족합니다. 수량이나 예산을 줄여 다시 주문하세요.',
  INSUFFICIENT_QUANTITY: '매도 가능 수량이 부족합니다. /portfolio에서 보유량을 확인하세요.',
  INSUFFICIENT_SHARES: '매도 가능 수량이 부족합니다. /portfolio에서 보유량을 확인하세요.',
  ZERO_QUANTITY: '계산된 주문 수량이 최소 단위보다 작습니다. 수량 또는 예산을 늘려 다시 확인하세요.',
  NUMERIC_BOUNDARY: '입력값이 지원 범위를 벗어났습니다. 수량과 금액의 범위를 확인하세요.',
  STALE_QUOTE: '시세 또는 계좌 상태가 바뀌어 이전 견적은 체결하지 않았습니다. /buy 또는 /sell을 다시 실행해 새 견적을 확인한 뒤 확인 버튼을 누르세요.',
  ORDER_EXPIRED: '견적 확인 시간이 지났습니다. /buy 또는 /sell을 다시 실행해 새 견적을 확인한 뒤 확인 버튼을 누르세요.',
  ORDER_OWNER_MISMATCH: '이 주문을 처리할 권한이 없습니다. 본인의 명령으로 새 주문을 만드세요.',
  ORDER_NOT_FOUND: '확인할 주문이 없습니다. /history에서 결과를 확인하거나 새 주문을 만드세요.',
  INTENT_NOT_FOUND: '이 주문을 처리할 권한이 없거나 주문이 없습니다. 본인의 명령으로 새 주문을 만드세요.',
  LISTING_NOT_TRADABLE: '현재 거래할 수 없는 종목입니다. /market에서 상태를 확인하세요.',
  INVALID_PRECISION: '수량은 소수점 6자리까지 입력하세요. 금액·시세가 지원 범위를 벗어나면 주문할 수 없습니다.',
  ORDER_CANCELLED: '이미 취소된 주문입니다. 거래가 필요하면 새 주문을 만드세요.',
  CORPORATE_ACTION_CANCELLED: '배당락 또는 청산으로 이전 견적을 취소했습니다. /market에서 종목과 새 시세를 확인하고 다시 주문하세요.',
  RATE_LIMITED: '명령을 너무 빠르게 실행했습니다. 잠시 후 다시 시도하세요.',
  BUSY: '처리 경로가 혼잡합니다. 잠시 후 /history에서 결과를 확인하고 다시 시도하세요.',
  INTEGRITY_ERROR: '데이터 무결성 확인 중으로 처리가 중단됐습니다. /status에서 상태를 확인하세요.',
  INTERNAL_ERROR: '처리를 완료하지 못했습니다. 자산 상태는 /portfolio와 /history에서 확인하세요.',
  IDEMPOTENCY_CONFLICT: '요청을 다시 사용할 수 없습니다. /history에서 처리 결과를 확인하세요.',
  SERVICE_UNAVAILABLE: '처리를 완료하지 못했습니다. 자산 상태는 /portfolio와 /history에서 확인하세요.',
  BOARD_UNAVAILABLE: '시장 설정은 저장됐지만 현황판을 게시하지 못했습니다. 채널 권한을 확인한 후 /setup을 다시 실행하세요.',
});

/** Exception text and unknown codes never cross the public error boundary. */
export function errorEmbed(code: string): EmbedBuilder {
  const title = code === 'MARKET_PAUSED' || code === 'MARKET_UNAVAILABLE' ? '운영 중단' : code === 'INTEGRITY_ERROR' ? '데이터 복구 중'
    : code === 'PERMISSION_DENIED' || code === 'CHANNEL_PERMISSION_DENIED' ? '권한 부족'
      : code === 'STALE_QUOTE' || code === 'ORDER_EXPIRED' ? '견적 갱신 안내' : '처리 안내';
  return baseEmbed(title, Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code]! : ERROR_TEXT.SERVICE_UNAVAILABLE!);
}

