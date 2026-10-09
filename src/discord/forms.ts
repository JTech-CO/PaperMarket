import { LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

function input(id: string, label: string, description: string, maximum: number, value?: string, required = true): LabelBuilder {
  const field = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setMaxLength(maximum).setRequired(required);
  if (value !== undefined) field.setValue(value);
  return new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(field);
}

/** Current Label components are used instead of deprecated modal Action Rows. No client identity enters these inputs. */
export function tradeModal(side: 'BUY' | 'SELL', symbol: string, generation: number): ModalBuilder {
  return new ModalBuilder().setCustomId(`pm:tradeform:${side}:${symbol}:${generation}`).setTitle(`${symbol} ${generation}세대 · ${side === 'BUY' ? '매수' : '매도'} 견적`)
    .addLabelComponents(
      input('quantity', '수량', '양수 · 소수점 6자리까지. 제출 후 견적을 확인합니다.', 96),
      input('order_type', '주문 방식', side === 'BUY' ? 'MARKET 또는 LIMIT' : 'MARKET, LIMIT 또는 STOP', 6, 'MARKET'),
      input('price', '조건가격', 'LIMIT·STOP에 필수. 시장가는 비워 두세요.', 96, undefined, false),
      input('duration', '조건주문 유효기간', '1~10000틱 또는 UC(취소할 때까지). 기본 21틱.', 8, undefined, false),
    );
}

export function companySelectionModal(): ModalBuilder {
  return new ModalBuilder().setCustomId('pm:companyform').setTitle('가상 기업 선택')
    .addLabelComponents(input('symbol', '종목 심볼', '/market에 표시한 심볼을 입력하세요.', 12),
      input('generation', '과거 세대 (선택)', '비우면 현재 세대. 과거 세대는 조회만 가능합니다.', 7, undefined, false));
}
