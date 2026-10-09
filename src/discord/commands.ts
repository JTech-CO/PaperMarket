import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type SlashCommandOptionsOnlyBuilder } from 'discord.js';

export const COMMAND_NAMES = ['setup', 'open', 'market', 'company', 'economy', 'financial', 'news', 'calendar', 'chart', 'performance', 'export', 'alerts', 'buy', 'sell', 'orders', 'portfolio', 'funding', 'history', 'status', 'help', 'privacy', 'close'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

function addOrderOptions(command: SlashCommandOptionsOnlyBuilder, side: 'BUY' | 'SELL'): SlashCommandOptionsOnlyBuilder {
  return command.addStringOption((option) => option.setName('order_type').setDescription('주문 방식: 선택하지 않으면 시장가')
    .addChoices({ name: '시장가', value: 'MARKET' }, { name: '지정가', value: 'LIMIT' },
      ...(side === 'SELL' ? [{ name: '스톱 매도', value: 'STOP' }] : [])))
    .addStringOption((option) => option.setName('price').setDescription('지정가의 최대/최저 가격 또는 스톱 발동가격: 조건주문에 필수')
      .setMaxLength(96))
    .addStringOption((option) => option.setName('time_in_force').setDescription('조건주문 유효기간: 기본은 21틱')
      .addChoices({ name: '틱 수 지정', value: 'TICK_COUNT' }, { name: '취소할 때까지', value: 'UNTIL_CANCELLED' }))
    .addIntegerOption((option) => option.setName('ticks').setDescription('조건주문 유효 틱 수: 기본 21틱, 정확히 만료 틱에는 체결하지 않음')
      .setMinValue(1).setMaxValue(10_000));
}

/** Guild scope and command permissions are presentation defaults; the handler checks them again. */
export function buildCommands() {
  const guildCommand = (name: CommandName, description: string) => new SlashCommandBuilder()
    .setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
  return [
    guildCommand('setup', '기존 채널에 가상 시장을 설정하거나 현황판을 복구합니다.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((option) => option.setName('channel').setDescription('시장 현황판을 둘 기존 텍스트 채널')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)),
    guildCommand('open', '만 14세 이상 여부와 이용약관을 확인한 후 모의계좌를 개설합니다.')
      .addBooleanOption((option) => option.setName('age_14_plus').setDescription('만 14세 이상입니다. 생년월일은 수집하지 않습니다.')
        .setRequired(true))
      .addBooleanOption((option) => option.setName('agree_terms').setDescription('/help의 이용약관을 확인하고 동의합니다.')
        .setRequired(true)),
    guildCommand('market', '8개 가상 종목의 확정 시세를 비공개로 조회합니다.'),
    ...(['company'] as const).map((name) => guildCommand(name, '사업·확정 시세·공시·배당을 종목 세대별로 조회합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('종목 심볼').setMaxLength(12).setRequired(true))
      .addIntegerOption((option) => option.setName('generation').setDescription('과거 종목 세대: 기본은 현재 세대').setMinValue(1).setMaxValue(1_000_000))),
    guildCommand('news', '최근 공개 공시와 사건을 조회합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('이 종목 공시만 표시').setMaxLength(12))
      .addIntegerOption((option) => option.setName('before_tick').setDescription('이 틱보다 앞선 공시: 기본 최신').setMinValue(0).setMaxValue(Number.MAX_SAFE_INTEGER)),
    guildCommand('calendar', '이미 공개된 실적·배당·정책 일정을 조회합니다.'),
    guildCommand('chart', '확정 원가격 또는 배당 포함 1주 총가치를 PNG로 조회합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('종목 심볼').setMaxLength(12).setRequired(true))
      .addStringOption((option) => option.setName('series').setDescription('원가격과 배당 포함 1주 총가치는 별도로 표시합니다.')
        .addChoices({ name: '원가격', value: 'PRICE' }, { name: '배당 포함 1주 총가치', value: 'TOTAL_RETURN' }))
      .addStringOption((option) => option.setName('scale').setDescription('축 종류: 청산 0은 로그축 종료 표식')
        .addChoices({ name: '선형', value: 'LINEAR' }, { name: '로그', value: 'LOG' }))
      .addIntegerOption((option) => option.setName('ticks').setDescription('최근 확정 기록 범위: 기본 252틱').setMinValue(2).setMaxValue(2_000))
      .addIntegerOption((option) => option.setName('generation').setDescription('과거 종목 세대: 기본은 현재 세대').setMinValue(1).setMaxValue(1_000_000)),
    guildCommand('performance', '본인의 총수익·최대낙폭·동일 시점 기준전략을 조회합니다.'),
    guildCommand('export', '본인의 거래·권리·성과 기록을 CSV·JSON으로 다운로드합니다.')
      .addStringOption((option) => option.setName('format').setDescription('파일 형식: 기본 CSV')
        .addChoices({ name: 'CSV', value: 'CSV' }, { name: 'JSON', value: 'JSON' }))
      .addIntegerOption((option) => option.setName('before_sequence').setDescription('이 순번보다 앞선 원장 페이지').setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER)),
    guildCommand('alerts', '관심종목·가격 알림과 영속 알림함을 설정하거나 조회합니다.')
      .addStringOption((option) => option.setName('action').setDescription('알림함 조회 또는 명시적 설정')
        .addChoices({ name: '알림함 조회', value: 'VIEW' }, { name: '관심종목 추가', value: 'WATCH' }, { name: '관심종목 해제', value: 'UNWATCH' },
          { name: '가격 알림 추가', value: 'PRICE' }, { name: '가격 알림 제거', value: 'REMOVE' }, { name: 'DM 수신 동의 변경', value: 'DM' }, { name: '알림 읽음', value: 'READ' }))
      .addStringOption((option) => option.setName('symbol').setDescription('관심·가격 알림 종목').setMaxLength(12))
      .addStringOption((option) => option.setName('price').setDescription('가격 임계값').setMaxLength(96))
      .addStringOption((option) => option.setName('direction').setDescription('한 방향 통과 시 1회 알림, 반대 방향 통과 후 재무장')
        .addChoices({ name: '상향 통과', value: 'ABOVE' }, { name: '하향 통과', value: 'BELOW' }))
      .addStringOption((option) => option.setName('alert_id').setDescription('제거할 가격 알림 ID: 읽음은 현재 페이지의 기록에만 적용').setMaxLength(80))
      .addBooleanOption((option) => option.setName('dm').setDescription('알림을 DM으로도 받는 데 명시적으로 동의합니다. false로 해제')),
    guildCommand('economy', '공개 경제지표·가상 금리·정책 전망·최근 공시를 조회합니다.'),
    guildCommand('financial', '종목의 이미 공개된 실적과 시장 전망을 조회합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('종목 심볼 (예: HGI)').setMaxLength(12).setRequired(true)),
    addOrderOptions(guildCommand('buy', '금액이나 가용 현금 비율로 시장가 매수하거나 직접 수량으로 지정가를 설정합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('종목 심볼 (예: HGI)').setMaxLength(12).setRequired(true))
      .addStringOption((option) => option.setName('budget').setDescription('수수료를 포함한 최대 예산: 수량과 하나만 입력')
        .setMaxLength(64))
      .addIntegerOption((option) => option.setName('budget_percent').setDescription('예약분을 제외한 가용 현금 비율: 예산·수량과 하나만 입력')
        .addChoices({ name: '가용 현금 25%', value: 25 }, { name: '가용 현금 50%', value: 50 }, { name: '가용 현금 100%', value: 100 }))
      .addStringOption((option) => option.setName('quantity').setDescription('직접 매수 수량: 소수점 6자리까지. 지정가는 수량 필수')
        .setMaxLength(64)), 'BUY'),
    addOrderOptions(guildCommand('sell', '시장가·지정가·스톱 매도 조건과 예약 수량을 확인합니다.')
      .addStringOption((option) => option.setName('symbol').setDescription('종목 심볼 (예: HGI)').setMaxLength(12).setRequired(true))
      .addStringOption((option) => option.setName('quantity').setDescription('매도 수량: 소수점 6자리까지, 전량과 하나만 입력')
        .setMaxLength(96))
      .addBooleanOption((option) => option.setName('all').setDescription('시장가로 이 종목의 매도 가능분 전량을 매도합니다.')), 'SELL'),
    guildCommand('orders', '본인의 미체결 예약 주문·예약 자산을 조회하고 취소합니다.'),
    guildCommand('portfolio', '본인의 현금·보유량·평가금액을 비공개로 조회합니다.'),
    guildCommand('funding', '정기 모의 입금의 일정·누적액을 조회하거나 자동 입금을 켜고 끕니다.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('true: 정기 모의 입금 활성화, false: 이후 입금 중단. 생략하면 조회')),
    guildCommand('history', '본인의 체결·배당·이자·청산·정정 기록을 비공개로 조회합니다.'),
    guildCommand('status', '확정 시장 버전과 운영 상태를 조회합니다.'),
    guildCommand('help', '모의투자 규칙·경제 모형의 범위·약관·개인정보 안내를 확인합니다.'),
    guildCommand('privacy', '저장 항목·처리 목적·보관 정책·권리 요청 경로를 확인합니다.'),
    guildCommand('close', '계좌 이용을 중단하고 ID 연결을 제거합니다. 원장·중복 지급 방지 기록은 보관합니다.')
      .addBooleanOption((option) => option.setName('confirmed').setDescription('재개설·초기금 재지급이 불가능함과 보관 정책을 확인했습니다.')
        .setRequired(true)),
  ];
}
