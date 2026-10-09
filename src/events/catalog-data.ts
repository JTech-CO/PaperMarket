/** Verbatim semantic reference rows from whitepaper Appendix A, in source order. */
export interface AppendixCatalogRow {
  readonly id: string; readonly title: string; readonly observedTarget: string;
  readonly group: 'HGI' | 'DNL' | 'TLR' | 'NXC' | 'VTR' | 'AUR' | 'LMB' | 'RVI' | 'MAC' | 'XCO';
  readonly profile: 'CONTRACT' | 'DEMAND' | 'COST' | 'PRICING' | 'OPERATE' | 'CAPEX' | 'INCIDENT' | 'FINANCE' | 'BELIEF' | 'MILESTONE' | 'DISCLOSURE' | 'MACRO';
}

export const APPENDIX_CATALOG_ROWS: readonly AppendixCatalogRow[] = Object.freeze([
  {
    "id": "HGI-01",
    "title": "대형 공급계약 체결",
    "profile": "CONTRACT",
    "observedTarget": "수주·납품·매출채권",
    "group": "HGI"
  },
  {
    "id": "HGI-02",
    "title": "수출 지역 확대",
    "profile": "DEMAND",
    "observedTarget": "해외 수요·외화 매출",
    "group": "HGI"
  },
  {
    "id": "HGI-03",
    "title": "원재료 구매단가 하락",
    "profile": "COST",
    "observedTarget": "해당 소재 원가",
    "group": "HGI"
  },
  {
    "id": "HGI-04",
    "title": "생산 수율 개선",
    "profile": "OPERATE",
    "observedTarget": "불량률·단위 원가",
    "group": "HGI"
  },
  {
    "id": "HGI-05",
    "title": "공장 자동화 완료",
    "profile": "OPERATE",
    "observedTarget": "완료된 투자·생산성",
    "group": "HGI"
  },
  {
    "id": "HGI-06",
    "title": "장기계약 갱신",
    "profile": "CONTRACT",
    "observedTarget": "잔여 계약·갱신 단가",
    "group": "HGI"
  },
  {
    "id": "HGI-07",
    "title": "외부 경쟁사 공급 차질",
    "profile": "DEMAND",
    "observedTarget": "대체 수요·가동 여력",
    "group": "HGI"
  },
  {
    "id": "HGI-08",
    "title": "고부가 제품 비중 증가",
    "profile": "OPERATE",
    "observedTarget": "상품 구성·판매단가",
    "group": "HGI"
  },
  {
    "id": "HGI-09",
    "title": "과잉 재고 정상화",
    "profile": "OPERATE",
    "observedTarget": "재고 회전·운전자금",
    "group": "HGI"
  },
  {
    "id": "HGI-10",
    "title": "품질 인증 취득",
    "profile": "MILESTONE",
    "observedTarget": "입찰 자격·수주 전망",
    "group": "HGI"
  },
  {
    "id": "HGI-11",
    "title": "주요 고객 이탈",
    "profile": "CONTRACT",
    "observedTarget": "종료 계약·예상 매출",
    "group": "HGI"
  },
  {
    "id": "HGI-12",
    "title": "원재료 구매단가 급등",
    "profile": "COST",
    "observedTarget": "해당 소재 원가",
    "group": "HGI"
  },
  {
    "id": "HGI-13",
    "title": "제품 리콜",
    "profile": "INCIDENT",
    "observedTarget": "반품·보상·품질 신뢰",
    "group": "HGI"
  },
  {
    "id": "HGI-14",
    "title": "생산라인 고장",
    "profile": "INCIDENT",
    "observedTarget": "생산능력·보수 비용",
    "group": "HGI"
  },
  {
    "id": "HGI-15",
    "title": "수출 물류 차질",
    "profile": "COST",
    "observedTarget": "운송비·납기",
    "group": "HGI"
  },
  {
    "id": "HGI-16",
    "title": "노사 분쟁",
    "profile": "INCIDENT",
    "observedTarget": "유효 생산일·비용",
    "group": "HGI"
  },
  {
    "id": "HGI-17",
    "title": "수출 허가 제한",
    "profile": "MILESTONE",
    "observedTarget": "거래 가능 시장·수요",
    "group": "HGI"
  },
  {
    "id": "HGI-18",
    "title": "완제품 재고 과잉",
    "profile": "OPERATE",
    "observedTarget": "재고·보관비·가격 할인",
    "group": "HGI"
  },
  {
    "id": "HGI-19",
    "title": "납품 지연 배상",
    "profile": "INCIDENT",
    "observedTarget": "계약 배상금·현금",
    "group": "HGI"
  },
  {
    "id": "HGI-20",
    "title": "환율 불일치 손실 공개",
    "profile": "DISCLOSURE",
    "observedTarget": "노출된 환차 효과·공개 전망",
    "group": "HGI"
  },
  {
    "id": "HGI-21",
    "title": "신규 공장 투자",
    "profile": "CAPEX",
    "observedTarget": "투자현금·완공 일정",
    "group": "HGI"
  },
  {
    "id": "HGI-22",
    "title": "외부 경쟁사 사업 인수",
    "profile": "CAPEX",
    "observedTarget": "인수자산·투자·통합 위험",
    "group": "HGI"
  },
  {
    "id": "HGI-23",
    "title": "판매가격 인상 결정",
    "profile": "PRICING",
    "observedTarget": "판매단가·수요 탄력성",
    "group": "HGI"
  },
  {
    "id": "HGI-24",
    "title": "해외 생산기지 이전",
    "profile": "CAPEX",
    "observedTarget": "전환 비용·가동 일정",
    "group": "HGI"
  },
  {
    "id": "DNL-01",
    "title": "반복 구매율 개선",
    "profile": "DEMAND",
    "observedTarget": "기존 고객·판매량",
    "group": "DNL"
  },
  {
    "id": "DNL-02",
    "title": "주요 유통채널 입점",
    "profile": "CONTRACT",
    "observedTarget": "유통계약·판매 범위",
    "group": "DNL"
  },
  {
    "id": "DNL-03",
    "title": "핵심 원료 가격 하락",
    "profile": "COST",
    "observedTarget": "식품·생활품 원가",
    "group": "DNL"
  },
  {
    "id": "DNL-04",
    "title": "브랜드 신뢰도 개선",
    "profile": "BELIEF",
    "observedTarget": "소비자 기대·수요 전망",
    "group": "DNL"
  },
  {
    "id": "DNL-05",
    "title": "물류센터 효율 개선",
    "profile": "OPERATE",
    "observedTarget": "유통비·납품 속도",
    "group": "DNL"
  },
  {
    "id": "DNL-06",
    "title": "장기 납품계약 확보",
    "profile": "CONTRACT",
    "observedTarget": "반복 판매·채권",
    "group": "DNL"
  },
  {
    "id": "DNL-07",
    "title": "신제품 재구매율 개선",
    "profile": "DEMAND",
    "observedTarget": "신제품 지속 수요",
    "group": "DNL"
  },
  {
    "id": "DNL-08",
    "title": "포장 단가 절감",
    "profile": "COST",
    "observedTarget": "포장재 비용",
    "group": "DNL"
  },
  {
    "id": "DNL-09",
    "title": "폐기율 감소",
    "profile": "OPERATE",
    "observedTarget": "재고 손실·원가",
    "group": "DNL"
  },
  {
    "id": "DNL-10",
    "title": "해외 판매망 확대",
    "profile": "CONTRACT",
    "observedTarget": "수출 유통·외화 노출",
    "group": "DNL"
  },
  {
    "id": "DNL-11",
    "title": "제품 안전성 문제",
    "profile": "INCIDENT",
    "observedTarget": "회수 비용·판매 중단",
    "group": "DNL"
  },
  {
    "id": "DNL-12",
    "title": "식품 원료 급등",
    "profile": "COST",
    "observedTarget": "해당 원료 단가",
    "group": "DNL"
  },
  {
    "id": "DNL-13",
    "title": "유통 수수료 인상",
    "profile": "COST",
    "observedTarget": "판매 수수료",
    "group": "DNL"
  },
  {
    "id": "DNL-14",
    "title": "주요 유통계약 종료",
    "profile": "CONTRACT",
    "observedTarget": "판매 경로·물량",
    "group": "DNL"
  },
  {
    "id": "DNL-15",
    "title": "품질 논란 확산",
    "profile": "BELIEF",
    "observedTarget": "브랜드 기대·확인 후속",
    "group": "DNL"
  },
  {
    "id": "DNL-16",
    "title": "생산시설 위생 점검 부적합",
    "profile": "INCIDENT",
    "observedTarget": "부분 가동 중단·개선비",
    "group": "DNL"
  },
  {
    "id": "DNL-17",
    "title": "물류 파업",
    "profile": "INCIDENT",
    "observedTarget": "배송 지연·보상",
    "group": "DNL"
  },
  {
    "id": "DNL-18",
    "title": "소비자 이탈률 상승",
    "profile": "DEMAND",
    "observedTarget": "반복 구매·판매량",
    "group": "DNL"
  },
  {
    "id": "DNL-19",
    "title": "재고 유통기한 손실",
    "profile": "INCIDENT",
    "observedTarget": "재고 손상·폐기 비용",
    "group": "DNL"
  },
  {
    "id": "DNL-20",
    "title": "가격 인상 후 판매 부진",
    "profile": "DEMAND",
    "observedTarget": "가격 전가의 수요 반작용",
    "group": "DNL"
  },
  {
    "id": "DNL-21",
    "title": "신규 브랜드 출시",
    "profile": "CAPEX",
    "observedTarget": "마케팅·재고·제품 실험",
    "group": "DNL"
  },
  {
    "id": "DNL-22",
    "title": "판매가격 재조정",
    "profile": "PRICING",
    "observedTarget": "판매단가·수요 탄력성",
    "group": "DNL"
  },
  {
    "id": "DNL-23",
    "title": "자체 물류시설 투자",
    "profile": "CAPEX",
    "observedTarget": "투자·향후 운송비",
    "group": "DNL"
  },
  {
    "id": "DNL-24",
    "title": "외부 브랜드 인수",
    "profile": "CAPEX",
    "observedTarget": "인수 비용·브랜드 자산",
    "group": "DNL"
  },
  {
    "id": "TLR-01",
    "title": "장기 금속 공급계약",
    "profile": "CONTRACT",
    "observedTarget": "물량·단가·대금 회수",
    "group": "TLR"
  },
  {
    "id": "TLR-02",
    "title": "광석 품위 개선",
    "profile": "OPERATE",
    "observedTarget": "유효 생산량·원가",
    "group": "TLR"
  },
  {
    "id": "TLR-03",
    "title": "제련 수율 상승",
    "profile": "OPERATE",
    "observedTarget": "제품 회수율",
    "group": "TLR"
  },
  {
    "id": "TLR-04",
    "title": "에너지 조달단가 하락",
    "profile": "COST",
    "observedTarget": "전력·연료 비용",
    "group": "TLR"
  },
  {
    "id": "TLR-05",
    "title": "신규 자원 매장 확인",
    "profile": "MILESTONE",
    "observedTarget": "가채량 추정·개발 전망",
    "group": "TLR"
  },
  {
    "id": "TLR-06",
    "title": "운송비 절감 계약",
    "profile": "COST",
    "observedTarget": "물류 원가",
    "group": "TLR"
  },
  {
    "id": "TLR-07",
    "title": "생산시설 가동률 개선",
    "profile": "OPERATE",
    "observedTarget": "생산량·고정비 배분",
    "group": "TLR"
  },
  {
    "id": "TLR-08",
    "title": "부채 차환 조건 개선",
    "profile": "FINANCE",
    "observedTarget": "만기 차입·가산금리",
    "group": "TLR"
  },
  {
    "id": "TLR-09",
    "title": "외부 수출 고객 확보",
    "profile": "CONTRACT",
    "observedTarget": "해외 매출·환율 노출",
    "group": "TLR"
  },
  {
    "id": "TLR-10",
    "title": "복구 사업 완료",
    "profile": "OPERATE",
    "observedTarget": "생산 재개·유효 능력",
    "group": "TLR"
  },
  {
    "id": "TLR-11",
    "title": "채굴 현장 사고",
    "profile": "INCIDENT",
    "observedTarget": "생산 중단·복구·배상",
    "group": "TLR"
  },
  {
    "id": "TLR-12",
    "title": "광석 품위 저하",
    "profile": "OPERATE",
    "observedTarget": "단위 생산 원가",
    "group": "TLR"
  },
  {
    "id": "TLR-13",
    "title": "제련시설 고장",
    "profile": "INCIDENT",
    "observedTarget": "설비 손상·가동률",
    "group": "TLR"
  },
  {
    "id": "TLR-14",
    "title": "에너지 구매비 급등",
    "profile": "COST",
    "observedTarget": "해당 에너지 계약",
    "group": "TLR"
  },
  {
    "id": "TLR-15",
    "title": "매장량 추정 하향",
    "profile": "MILESTONE",
    "observedTarget": "가채량·잔존가치",
    "group": "TLR"
  },
  {
    "id": "TLR-16",
    "title": "환경 복구비 증가",
    "profile": "INCIDENT",
    "observedTarget": "충당 의무·현금 일정",
    "group": "TLR"
  },
  {
    "id": "TLR-17",
    "title": "주요 구매계약 축소",
    "profile": "CONTRACT",
    "observedTarget": "판매 물량·재고",
    "group": "TLR"
  },
  {
    "id": "TLR-18",
    "title": "수출 물류 경로 중단",
    "profile": "INCIDENT",
    "observedTarget": "납품·수송 비용",
    "group": "TLR"
  },
  {
    "id": "TLR-19",
    "title": "조달 가산금리 상승",
    "profile": "FINANCE",
    "observedTarget": "미래 차입비용",
    "group": "TLR"
  },
  {
    "id": "TLR-20",
    "title": "과잉 재고 평가손실",
    "profile": "INCIDENT",
    "observedTarget": "재고 가치·순이익",
    "group": "TLR"
  },
  {
    "id": "TLR-21",
    "title": "신규 광구 개발 투자",
    "profile": "CAPEX",
    "observedTarget": "탐사·개발 현금·기간",
    "group": "TLR"
  },
  {
    "id": "TLR-22",
    "title": "고정가격 장기계약 전환",
    "profile": "CONTRACT",
    "observedTarget": "가격 위험·상방 제한",
    "group": "TLR"
  },
  {
    "id": "TLR-23",
    "title": "생산량 조절 결정",
    "profile": "OPERATE",
    "observedTarget": "생산·재고·고정비",
    "group": "TLR"
  },
  {
    "id": "TLR-24",
    "title": "비핵심 광구 매각",
    "profile": "FINANCE",
    "observedTarget": "매각대금·자산 감소·처분손익",
    "group": "TLR"
  },
  {
    "id": "NXC-01",
    "title": "대형 기업 고객 확보",
    "profile": "CONTRACT",
    "observedTarget": "계약 매출·온보딩 비용",
    "group": "NXC"
  },
  {
    "id": "NXC-02",
    "title": "고객 이탈률 하락",
    "profile": "OPERATE",
    "observedTarget": "고객 유지·반복 매출",
    "group": "NXC"
  },
  {
    "id": "NXC-03",
    "title": "고객당 매출 증가",
    "profile": "DEMAND",
    "observedTarget": "업셀·상품 구성",
    "group": "NXC"
  },
  {
    "id": "NXC-04",
    "title": "신규 서비스 판매 호조",
    "profile": "DEMAND",
    "observedTarget": "서비스 매출·지원 비용",
    "group": "NXC"
  },
  {
    "id": "NXC-05",
    "title": "해외 서비스 계약",
    "profile": "CONTRACT",
    "observedTarget": "해외 매출·운영비",
    "group": "NXC"
  },
  {
    "id": "NXC-06",
    "title": "서버 사용효율 개선",
    "profile": "OPERATE",
    "observedTarget": "컴퓨팅 원가",
    "group": "NXC"
  },
  {
    "id": "NXC-07",
    "title": "손익분기점 조기 전망",
    "profile": "DISCLOSURE",
    "observedTarget": "기존 실적·수익성 전망",
    "group": "NXC"
  },
  {
    "id": "NXC-08",
    "title": "장기 구독 비중 확대",
    "profile": "CONTRACT",
    "observedTarget": "반복 매출·회수 일정",
    "group": "NXC"
  },
  {
    "id": "NXC-09",
    "title": "핵심 소프트웨어 기술 확보",
    "profile": "MILESTONE",
    "observedTarget": "제품 능력·투자 전망",
    "group": "NXC"
  },
  {
    "id": "NXC-10",
    "title": "유통 파트너 계약",
    "profile": "CONTRACT",
    "observedTarget": "판매 범위·수수료",
    "group": "NXC"
  },
  {
    "id": "NXC-11",
    "title": "대규모 서비스 장애",
    "profile": "INCIDENT",
    "observedTarget": "보상·이탈·가동률",
    "group": "NXC"
  },
  {
    "id": "NXC-12",
    "title": "고객 정보 보안 사고",
    "profile": "INCIDENT",
    "observedTarget": "복구·배상·신뢰",
    "group": "NXC"
  },
  {
    "id": "NXC-13",
    "title": "외부 경쟁사 가격 인하",
    "profile": "DEMAND",
    "observedTarget": "가격 경쟁·이탈 위험",
    "group": "NXC"
  },
  {
    "id": "NXC-14",
    "title": "고객 이탈률 상승",
    "profile": "OPERATE",
    "observedTarget": "고객 수·유지 비용",
    "group": "NXC"
  },
  {
    "id": "NXC-15",
    "title": "핵심 제품 출시 지연",
    "profile": "MILESTONE",
    "observedTarget": "매출 전환 시점",
    "group": "NXC"
  },
  {
    "id": "NXC-16",
    "title": "인프라 조달비 상승",
    "profile": "COST",
    "observedTarget": "서버·전력·계약비",
    "group": "NXC"
  },
  {
    "id": "NXC-17",
    "title": "현금 소진 전망 악화",
    "profile": "DISCLOSURE",
    "observedTarget": "현금흐름·조달 필요",
    "group": "NXC"
  },
  {
    "id": "NXC-18",
    "title": "대형 계약 취소",
    "profile": "CONTRACT",
    "observedTarget": "예정 매출·채권",
    "group": "NXC"
  },
  {
    "id": "NXC-19",
    "title": "성장률 예상 하회",
    "profile": "DISCLOSURE",
    "observedTarget": "공개 성장 실적·기대 수정",
    "group": "NXC"
  },
  {
    "id": "NXC-20",
    "title": "핵심 연구인력 이탈",
    "profile": "INCIDENT",
    "observedTarget": "채용 비용·개발 일정",
    "group": "NXC"
  },
  {
    "id": "NXC-21",
    "title": "외부 대상 유상증자",
    "profile": "FINANCE",
    "observedTarget": "현금·주식 수·희석",
    "group": "NXC"
  },
  {
    "id": "NXC-22",
    "title": "대규모 연구개발 투자",
    "profile": "CAPEX",
    "observedTarget": "연구비·후속 성과",
    "group": "NXC"
  },
  {
    "id": "NXC-23",
    "title": "외부 소프트웨어 사업 인수",
    "profile": "CAPEX",
    "observedTarget": "인수 현금·통합 위험",
    "group": "NXC"
  },
  {
    "id": "NXC-24",
    "title": "저가 요금제 출시",
    "profile": "DEMAND",
    "observedTarget": "고객 수·고객당 매출",
    "group": "NXC"
  },
  {
    "id": "VTR-01",
    "title": "대형 자동화 수주",
    "profile": "CONTRACT",
    "observedTarget": "수주·제작·납품 일정",
    "group": "VTR"
  },
  {
    "id": "VTR-02",
    "title": "납품 전환율 개선",
    "profile": "OPERATE",
    "observedTarget": "수주 잔고·매출 인식",
    "group": "VTR"
  },
  {
    "id": "VTR-03",
    "title": "핵심 부품 원가 절감",
    "profile": "COST",
    "observedTarget": "구동·제어 부품비",
    "group": "VTR"
  },
  {
    "id": "VTR-04",
    "title": "로봇 유지보수 계약 확대",
    "profile": "CONTRACT",
    "observedTarget": "반복 서비스 매출",
    "group": "VTR"
  },
  {
    "id": "VTR-05",
    "title": "생산라인 증설 완료",
    "profile": "OPERATE",
    "observedTarget": "완료 투자·생산능력",
    "group": "VTR"
  },
  {
    "id": "VTR-06",
    "title": "해외 공장 자동화 계약",
    "profile": "CONTRACT",
    "observedTarget": "수출·프로젝트 비용",
    "group": "VTR"
  },
  {
    "id": "VTR-07",
    "title": "제품 인증 통과",
    "profile": "MILESTONE",
    "observedTarget": "입찰 자격·판매 가능성",
    "group": "VTR"
  },
  {
    "id": "VTR-08",
    "title": "고객 재주문 증가",
    "profile": "DEMAND",
    "observedTarget": "반복 수요·수주 전망",
    "group": "VTR"
  },
  {
    "id": "VTR-09",
    "title": "설치 효율 개선",
    "profile": "OPERATE",
    "observedTarget": "인도 기간·설치 원가",
    "group": "VTR"
  },
  {
    "id": "VTR-10",
    "title": "외부 파트너 부품 확보",
    "profile": "CONTRACT",
    "observedTarget": "공급 안정·구매 조건",
    "group": "VTR"
  },
  {
    "id": "VTR-11",
    "title": "구동 부품 공급 중단",
    "profile": "INCIDENT",
    "observedTarget": "생산 차질·대체 원가",
    "group": "VTR"
  },
  {
    "id": "VTR-12",
    "title": "로봇 안전 결함",
    "profile": "INCIDENT",
    "observedTarget": "리콜·수리·판매 중단",
    "group": "VTR"
  },
  {
    "id": "VTR-13",
    "title": "대형 프로젝트 납기 지연",
    "profile": "CONTRACT",
    "observedTarget": "매출 지연·위약금",
    "group": "VTR"
  },
  {
    "id": "VTR-14",
    "title": "원가 예상 초과",
    "profile": "COST",
    "observedTarget": "해당 프로젝트 원가",
    "group": "VTR"
  },
  {
    "id": "VTR-15",
    "title": "설치 현장 사고",
    "profile": "INCIDENT",
    "observedTarget": "복구·배상·가동 중단",
    "group": "VTR"
  },
  {
    "id": "VTR-16",
    "title": "주요 고객 투자 취소",
    "profile": "CONTRACT",
    "observedTarget": "수주 취소·재고",
    "group": "VTR"
  },
  {
    "id": "VTR-17",
    "title": "재고 부품 노후화",
    "profile": "INCIDENT",
    "observedTarget": "재고 손상",
    "group": "VTR"
  },
  {
    "id": "VTR-18",
    "title": "서비스 유지비 증가",
    "profile": "COST",
    "observedTarget": "보증·지원 비용",
    "group": "VTR"
  },
  {
    "id": "VTR-19",
    "title": "경쟁 제품 성능 우위 공개",
    "profile": "BELIEF",
    "observedTarget": "제품 경쟁력 기대",
    "group": "VTR"
  },
  {
    "id": "VTR-20",
    "title": "현금 회수 지연",
    "profile": "FINANCE",
    "observedTarget": "매출채권·운전자금",
    "group": "VTR"
  },
  {
    "id": "VTR-21",
    "title": "신규 로봇 제품군 개발",
    "profile": "CAPEX",
    "observedTarget": "연구개발·후속 인증",
    "group": "VTR"
  },
  {
    "id": "VTR-22",
    "title": "생산시설 추가 투자",
    "profile": "CAPEX",
    "observedTarget": "자금·능력·완공",
    "group": "VTR"
  },
  {
    "id": "VTR-23",
    "title": "외부 대상 자본조달",
    "profile": "FINANCE",
    "observedTarget": "주식 수·투자 여력",
    "group": "VTR"
  },
  {
    "id": "VTR-24",
    "title": "장기 일괄 자동화 계약",
    "profile": "CONTRACT",
    "observedTarget": "기간·수익성·집중 위험",
    "group": "VTR"
  },
  {
    "id": "AUR-01",
    "title": "실증 사업 선정",
    "profile": "MILESTONE",
    "observedTarget": "프로젝트 단계·조건부 수입",
    "group": "AUR"
  },
  {
    "id": "AUR-02",
    "title": "기술 인증 통과",
    "profile": "MILESTONE",
    "observedTarget": "판매 자격·성공 확률",
    "group": "AUR"
  },
  {
    "id": "AUR-03",
    "title": "초기 상용화 계약",
    "profile": "CONTRACT",
    "observedTarget": "예정 납품·현금 일정",
    "group": "AUR"
  },
  {
    "id": "AUR-04",
    "title": "시제품 성능 개선",
    "profile": "MILESTONE",
    "observedTarget": "성능 검증·후속 시험",
    "group": "AUR"
  },
  {
    "id": "AUR-05",
    "title": "전략적 제휴 체결",
    "profile": "CONTRACT",
    "observedTarget": "공동 투자·사업 범위",
    "group": "AUR"
  },
  {
    "id": "AUR-06",
    "title": "핵심 특허 확보",
    "profile": "MILESTONE",
    "observedTarget": "기술 보호·사업 전망",
    "group": "AUR"
  },
  {
    "id": "AUR-07",
    "title": "가상 해외시장 허가",
    "profile": "MILESTONE",
    "observedTarget": "허가된 시장·수요",
    "group": "AUR"
  },
  {
    "id": "AUR-08",
    "title": "첫 유료 고객 확보",
    "profile": "CONTRACT",
    "observedTarget": "상용 매출·서비스 비용",
    "group": "AUR"
  },
  {
    "id": "AUR-09",
    "title": "산업 실증 지원 확정",
    "profile": "FINANCE",
    "observedTarget": "조건부 보조금·의무",
    "group": "AUR"
  },
  {
    "id": "AUR-10",
    "title": "초기 생산 준비 완료",
    "profile": "OPERATE",
    "observedTarget": "생산 가능량·고정비",
    "group": "AUR"
  },
  {
    "id": "AUR-11",
    "title": "인증 심사 실패",
    "profile": "MILESTONE",
    "observedTarget": "사업 지연·추가 비용",
    "group": "AUR"
  },
  {
    "id": "AUR-12",
    "title": "상용화 일정 지연",
    "profile": "MILESTONE",
    "observedTarget": "매출 시점·현금 소진",
    "group": "AUR"
  },
  {
    "id": "AUR-13",
    "title": "사업 지원 철회",
    "profile": "FINANCE",
    "observedTarget": "조건부 자금·상환 의무",
    "group": "AUR"
  },
  {
    "id": "AUR-14",
    "title": "성능 검증 목표 미달",
    "profile": "MILESTONE",
    "observedTarget": "성공 전망·개선 필요",
    "group": "AUR"
  },
  {
    "id": "AUR-15",
    "title": "실증 운행 사고",
    "profile": "INCIDENT",
    "observedTarget": "배상·시험 중단·신뢰",
    "group": "AUR"
  },
  {
    "id": "AUR-16",
    "title": "과장된 성능 발표 정정",
    "profile": "DISCLOSURE",
    "observedTarget": "공개 수치·기대 정정",
    "group": "AUR"
  },
  {
    "id": "AUR-17",
    "title": "기술 권리 분쟁",
    "profile": "INCIDENT",
    "observedTarget": "법무 비용·활용 제한",
    "group": "AUR"
  },
  {
    "id": "AUR-18",
    "title": "협력사 사업 이탈",
    "profile": "CONTRACT",
    "observedTarget": "공급·공동개발 일정",
    "group": "AUR"
  },
  {
    "id": "AUR-19",
    "title": "신규 자금조달 실패",
    "profile": "FINANCE",
    "observedTarget": "현금 소진·대체 조달",
    "group": "AUR"
  },
  {
    "id": "AUR-20",
    "title": "양산 비용 초과",
    "profile": "COST",
    "observedTarget": "단위 생산비·수익성",
    "group": "AUR"
  },
  {
    "id": "AUR-21",
    "title": "업계 인사의 기술 언급",
    "profile": "BELIEF",
    "observedTarget": "테마 관심·확인 후속",
    "group": "AUR"
  },
  {
    "id": "AUR-22",
    "title": "외부 기업 인수설",
    "profile": "BELIEF",
    "observedTarget": "비확정 인수 기대",
    "group": "AUR"
  },
  {
    "id": "AUR-23",
    "title": "가상 산업 규칙 초안 공개",
    "profile": "BELIEF",
    "observedTarget": "규칙 확정 전 사업 기대",
    "group": "AUR"
  },
  {
    "id": "AUR-24",
    "title": "대체 운송기술 등장",
    "profile": "MILESTONE",
    "observedTarget": "경쟁 시나리오·수요",
    "group": "AUR"
  },
  {
    "id": "LMB-01",
    "title": "후보물질 초기 결과 개선",
    "profile": "MILESTONE",
    "observedTarget": "연구 단계·후속 검증",
    "group": "LMB"
  },
  {
    "id": "LMB-02",
    "title": "전임상 목표 달성",
    "profile": "MILESTONE",
    "observedTarget": "다음 연구 단계",
    "group": "LMB"
  },
  {
    "id": "LMB-03",
    "title": "가상 임상시험 승인",
    "profile": "MILESTONE",
    "observedTarget": "시험 가능성·비용 계획",
    "group": "LMB"
  },
  {
    "id": "LMB-04",
    "title": "중간 연구 지표 개선",
    "profile": "MILESTONE",
    "observedTarget": "성공 전망·검증 필요",
    "group": "LMB"
  },
  {
    "id": "LMB-05",
    "title": "기술이전 계약 체결",
    "profile": "CONTRACT",
    "observedTarget": "계약금·조건부 수입",
    "group": "LMB"
  },
  {
    "id": "LMB-06",
    "title": "외부 공동연구 계약",
    "profile": "CONTRACT",
    "observedTarget": "연구비 분담·권리",
    "group": "LMB"
  },
  {
    "id": "LMB-07",
    "title": "주요 기술 특허 확보",
    "profile": "MILESTONE",
    "observedTarget": "기술 권리·잔존가치",
    "group": "LMB"
  },
  {
    "id": "LMB-08",
    "title": "후속 단계 시험 개시",
    "profile": "MILESTONE",
    "observedTarget": "단계 이동·추가 자금",
    "group": "LMB"
  },
  {
    "id": "LMB-09",
    "title": "연구비 지원 확보",
    "profile": "FINANCE",
    "observedTarget": "조건부 자금·지급 일정",
    "group": "LMB"
  },
  {
    "id": "LMB-10",
    "title": "기술료 조건 충족",
    "profile": "CONTRACT",
    "observedTarget": "성취 조건·수령액",
    "group": "LMB"
  },
  {
    "id": "LMB-11",
    "title": "연구 목표 미달",
    "profile": "MILESTONE",
    "observedTarget": "성공 전망·사업 일정",
    "group": "LMB"
  },
  {
    "id": "LMB-12",
    "title": "시험 중 안전성 신호",
    "profile": "MILESTONE",
    "observedTarget": "추가 평가·시험 보류",
    "group": "LMB"
  },
  {
    "id": "LMB-13",
    "title": "후보물질 개발 중단",
    "profile": "MILESTONE",
    "observedTarget": "프로젝트 종료·손상",
    "group": "LMB"
  },
  {
    "id": "LMB-14",
    "title": "시험 모집 지연",
    "profile": "MILESTONE",
    "observedTarget": "일정·비용·현금 소진",
    "group": "LMB"
  },
  {
    "id": "LMB-15",
    "title": "기술이전 협상 결렬",
    "profile": "CONTRACT",
    "observedTarget": "예상 계약 제외",
    "group": "LMB"
  },
  {
    "id": "LMB-16",
    "title": "연구 데이터 정정",
    "profile": "DISCLOSURE",
    "observedTarget": "공개 결과·신뢰 수정",
    "group": "LMB"
  },
  {
    "id": "LMB-17",
    "title": "핵심 특허 분쟁",
    "profile": "INCIDENT",
    "observedTarget": "권리·법무 비용",
    "group": "LMB"
  },
  {
    "id": "LMB-18",
    "title": "임상 수행비 증가",
    "profile": "COST",
    "observedTarget": "해당 연구 프로젝트비",
    "group": "LMB"
  },
  {
    "id": "LMB-19",
    "title": "계약금 수령 지연",
    "profile": "FINANCE",
    "observedTarget": "채권·운전자금",
    "group": "LMB"
  },
  {
    "id": "LMB-20",
    "title": "후속 투자 유치 실패",
    "profile": "FINANCE",
    "observedTarget": "유동성·연구 지속",
    "group": "LMB"
  },
  {
    "id": "LMB-21",
    "title": "새 연구 파이프라인 도입",
    "profile": "CAPEX",
    "observedTarget": "도입금·조건부 연구",
    "group": "LMB"
  },
  {
    "id": "LMB-22",
    "title": "기술이전 선급금 조건 변경",
    "profile": "CONTRACT",
    "observedTarget": "확정·조건부 현금 분리",
    "group": "LMB"
  },
  {
    "id": "LMB-23",
    "title": "외부 대상 유상증자",
    "profile": "FINANCE",
    "observedTarget": "자금·주식 수·희석",
    "group": "LMB"
  },
  {
    "id": "LMB-24",
    "title": "경쟁 연구 결과 공개",
    "profile": "BELIEF",
    "observedTarget": "대체 가능성·시장 기대",
    "group": "LMB"
  },
  {
    "id": "RVI-01",
    "title": "장기 시설 이용계약",
    "profile": "CONTRACT",
    "observedTarget": "반복 수입·계약 기간",
    "group": "RVI"
  },
  {
    "id": "RVI-02",
    "title": "시설 가동률 상승",
    "profile": "OPERATE",
    "observedTarget": "이용량·수익성",
    "group": "RVI"
  },
  {
    "id": "RVI-03",
    "title": "차입금 차환 성공",
    "profile": "FINANCE",
    "observedTarget": "만기·가산금리",
    "group": "RVI"
  },
  {
    "id": "RVI-04",
    "title": "유지보수 단가 절감",
    "profile": "COST",
    "observedTarget": "보수 비용",
    "group": "RVI"
  },
  {
    "id": "RVI-05",
    "title": "신규 시설 가동",
    "profile": "OPERATE",
    "observedTarget": "완료된 투자·사용 능력",
    "group": "RVI"
  },
  {
    "id": "RVI-06",
    "title": "요금 인상 승인",
    "profile": "CONTRACT",
    "observedTarget": "허용 판매단가·수요",
    "group": "RVI"
  },
  {
    "id": "RVI-07",
    "title": "자발적 부채 감축",
    "profile": "FINANCE",
    "observedTarget": "원금 상환·이자 절감",
    "group": "RVI"
  },
  {
    "id": "RVI-08",
    "title": "신용 상태 개선",
    "profile": "FINANCE",
    "observedTarget": "후속 조달비·신용 전망",
    "group": "RVI"
  },
  {
    "id": "RVI-09",
    "title": "현금흐름 예상 상회",
    "profile": "DISCLOSURE",
    "observedTarget": "공개 현금창출·배당 여력",
    "group": "RVI"
  },
  {
    "id": "RVI-10",
    "title": "정기배당 확대 결의",
    "profile": "DISCLOSURE",
    "observedTarget": "도메인이 결정한 DPS·일정",
    "group": "RVI"
  },
  {
    "id": "RVI-11",
    "title": "주요 시설 사고",
    "profile": "INCIDENT",
    "observedTarget": "복구·부분 운영 중단",
    "group": "RVI"
  },
  {
    "id": "RVI-12",
    "title": "예상 밖 대규모 보수",
    "profile": "CAPEX",
    "observedTarget": "유지 투자·현금 감소",
    "group": "RVI"
  },
  {
    "id": "RVI-13",
    "title": "차환 가산금리 상승",
    "profile": "FINANCE",
    "observedTarget": "미래 이자·만기 부담",
    "group": "RVI"
  },
  {
    "id": "RVI-14",
    "title": "요금 동결 결정",
    "profile": "CONTRACT",
    "observedTarget": "계약 단가·원가 전가",
    "group": "RVI"
  },
  {
    "id": "RVI-15",
    "title": "시설 이용량 감소",
    "profile": "DEMAND",
    "observedTarget": "이용료 수입",
    "group": "RVI"
  },
  {
    "id": "RVI-16",
    "title": "주요 고객 연체",
    "profile": "FINANCE",
    "observedTarget": "매출채권·현금 회수",
    "group": "RVI"
  },
  {
    "id": "RVI-17",
    "title": "신용 상태 악화",
    "profile": "FINANCE",
    "observedTarget": "차입 조건·배당 제한",
    "group": "RVI"
  },
  {
    "id": "RVI-18",
    "title": "운영 기준 준수비 증가",
    "profile": "COST",
    "observedTarget": "해당 시설 운영비",
    "group": "RVI"
  },
  {
    "id": "RVI-19",
    "title": "장기 시설 운영 중단",
    "profile": "INCIDENT",
    "observedTarget": "능력·수입·복구",
    "group": "RVI"
  },
  {
    "id": "RVI-20",
    "title": "정기배당 감액 결의",
    "profile": "DISCLOSURE",
    "observedTarget": "도메인이 결정한 DPS·사유",
    "group": "RVI"
  },
  {
    "id": "RVI-21",
    "title": "신규 기반시설 투자",
    "profile": "CAPEX",
    "observedTarget": "투자·부채·향후 수입",
    "group": "RVI"
  },
  {
    "id": "RVI-22",
    "title": "비핵심 시설 매각",
    "profile": "FINANCE",
    "observedTarget": "처분대금·수입 감소",
    "group": "RVI"
  },
  {
    "id": "RVI-23",
    "title": "장기 부채 조기 상환",
    "profile": "FINANCE",
    "observedTarget": "현금·위약금·이자",
    "group": "RVI"
  },
  {
    "id": "RVI-24",
    "title": "장기 요금계약 재협상",
    "profile": "CONTRACT",
    "observedTarget": "판매단가·기간·안정성",
    "group": "RVI"
  },
  {
    "id": "MAC-01",
    "title": "정책금리 인상 결정",
    "profile": "MACRO",
    "observedTarget": "정책 반응 함수의 실제 결정·예상 차이",
    "group": "MAC"
  },
  {
    "id": "MAC-02",
    "title": "정책금리 인하 결정",
    "profile": "MACRO",
    "observedTarget": "정책 반응 함수의 실제 결정·예상 차이",
    "group": "MAC"
  },
  {
    "id": "MAC-03",
    "title": "예상 밖 정책금리 동결",
    "profile": "MACRO",
    "observedTarget": "동결 결과·시장 기대",
    "group": "MAC"
  },
  {
    "id": "MAC-04",
    "title": "물가 예상 상회",
    "profile": "MACRO",
    "observedTarget": "공개 물가·정책 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-05",
    "title": "물가 예상 하회",
    "profile": "MACRO",
    "observedTarget": "공개 물가·정책 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-06",
    "title": "성장 지표 예상 상회",
    "profile": "MACRO",
    "observedTarget": "수요·산출갭 공개 추정",
    "group": "MAC"
  },
  {
    "id": "MAC-07",
    "title": "성장 지표 예상 하회",
    "profile": "MACRO",
    "observedTarget": "수요·산출갭 공개 추정",
    "group": "MAC"
  },
  {
    "id": "MAC-08",
    "title": "고용 지표 개선",
    "profile": "MACRO",
    "observedTarget": "임금·소비·수요 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-09",
    "title": "고용 지표 악화",
    "profile": "MACRO",
    "observedTarget": "임금·소비·수요 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-10",
    "title": "금속 가격 급등",
    "profile": "MACRO",
    "observedTarget": "금속 가격·업종별 노출",
    "group": "MAC"
  },
  {
    "id": "MAC-11",
    "title": "금속 가격 급락",
    "profile": "MACRO",
    "observedTarget": "금속 가격·업종별 노출",
    "group": "MAC"
  },
  {
    "id": "MAC-12",
    "title": "에너지 가격 급등",
    "profile": "MACRO",
    "observedTarget": "에너지비·판매 계약",
    "group": "MAC"
  },
  {
    "id": "MAC-13",
    "title": "에너지 가격 급락",
    "profile": "MACRO",
    "observedTarget": "에너지비·판매 계약",
    "group": "MAC"
  },
  {
    "id": "MAC-14",
    "title": "모의통화 약세",
    "profile": "MACRO",
    "observedTarget": "환율 상승·수출입 비용",
    "group": "MAC"
  },
  {
    "id": "MAC-15",
    "title": "모의통화 강세",
    "profile": "MACRO",
    "observedTarget": "환율 하락·수출입 비용",
    "group": "MAC"
  },
  {
    "id": "MAC-16",
    "title": "신용 공급 경색",
    "profile": "MACRO",
    "observedTarget": "자금조달·가산금리",
    "group": "MAC"
  },
  {
    "id": "MAC-17",
    "title": "신용 공급 완화",
    "profile": "MACRO",
    "observedTarget": "자금조달·가산금리",
    "group": "MAC"
  },
  {
    "id": "MAC-18",
    "title": "소비심리 개선",
    "profile": "MACRO",
    "observedTarget": "소비수요·재고 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-19",
    "title": "소비심리 악화",
    "profile": "MACRO",
    "observedTarget": "소비수요·재고 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-20",
    "title": "외부 수출수요 확대",
    "profile": "MACRO",
    "observedTarget": "해외 판매·생산 계획",
    "group": "MAC"
  },
  {
    "id": "MAC-21",
    "title": "외부 수출수요 축소",
    "profile": "MACRO",
    "observedTarget": "해외 판매·생산 계획",
    "group": "MAC"
  },
  {
    "id": "MAC-22",
    "title": "가상 산업 지원 확대",
    "profile": "MACRO",
    "observedTarget": "조건부 사업 지원·의무",
    "group": "MAC"
  },
  {
    "id": "MAC-23",
    "title": "가상 산업 지원 축소",
    "profile": "MACRO",
    "observedTarget": "조건부 지원·사업 전망",
    "group": "MAC"
  },
  {
    "id": "MAC-24",
    "title": "외부 금융 불안",
    "profile": "MACRO",
    "observedTarget": "공동 위험선호·신용·상관",
    "group": "MAC"
  },
  {
    "id": "XCO-01",
    "title": "TLR→HGI 금속 납품 확대",
    "profile": "CONTRACT",
    "observedTarget": "공급 매출·고객 원재료·회수",
    "group": "XCO"
  },
  {
    "id": "XCO-02",
    "title": "TLR→HGI 금속 공급 중단",
    "profile": "INCIDENT",
    "observedTarget": "공급량·고객 생산·대체 비용",
    "group": "XCO"
  },
  {
    "id": "XCO-03",
    "title": "TLR→VTR 소재 공급계약",
    "profile": "CONTRACT",
    "observedTarget": "동일 계약의 양측 전표",
    "group": "XCO"
  },
  {
    "id": "XCO-04",
    "title": "TLR↔VTR 고정단가 계약",
    "profile": "CONTRACT",
    "observedTarget": "원자재 위험의 이전·기간",
    "group": "XCO"
  },
  {
    "id": "XCO-05",
    "title": "HGI→VTR 정밀부품 신규 수주",
    "profile": "CONTRACT",
    "observedTarget": "공급자 수주·고객 생산계획",
    "group": "XCO"
  },
  {
    "id": "XCO-06",
    "title": "HGI→VTR 공급 부품 리콜",
    "profile": "INCIDENT",
    "observedTarget": "보상·반품·고객 제작 지연",
    "group": "XCO"
  },
  {
    "id": "XCO-07",
    "title": "HGI→AUR 시제품 부품 공급",
    "profile": "CONTRACT",
    "observedTarget": "실증 단계·조건부 납품",
    "group": "XCO"
  },
  {
    "id": "XCO-08",
    "title": "HGI↔AUR 상용 부품계약 보류",
    "profile": "CONTRACT",
    "observedTarget": "미확정 수주·양산 일정",
    "group": "XCO"
  },
  {
    "id": "XCO-09",
    "title": "VTR→HGI 공장 자동화 구축",
    "profile": "CAPEX",
    "observedTarget": "공급자 매출·고객 투자자산",
    "group": "XCO"
  },
  {
    "id": "XCO-10",
    "title": "VTR→HGI 자동화 설치 지연",
    "profile": "INCIDENT",
    "observedTarget": "매출 인식·생산성 시점",
    "group": "XCO"
  },
  {
    "id": "XCO-11",
    "title": "VTR→DNL 포장 자동화 계약",
    "profile": "CONTRACT",
    "observedTarget": "설비 공급·고객 원가 전망",
    "group": "XCO"
  },
  {
    "id": "XCO-12",
    "title": "VTR→DNL 자동화 장비 결함",
    "profile": "INCIDENT",
    "observedTarget": "보증 비용·포장능력",
    "group": "XCO"
  },
  {
    "id": "XCO-13",
    "title": "NXC→HGI ERP 구독계약",
    "profile": "CONTRACT",
    "observedTarget": "구독 매출·IT 운영비",
    "group": "XCO"
  },
  {
    "id": "XCO-14",
    "title": "NXC→DNL 재고 시스템 도입",
    "profile": "CONTRACT",
    "observedTarget": "구독·고객 운전자금 효율",
    "group": "XCO"
  },
  {
    "id": "XCO-15",
    "title": "NXC→VTR 유지보수 클라우드",
    "profile": "CONTRACT",
    "observedTarget": "서비스 매출·운영비",
    "group": "XCO"
  },
  {
    "id": "XCO-16",
    "title": "NXC→RVI 시설 관리 시스템",
    "profile": "CONTRACT",
    "observedTarget": "IT 계약·시설 운영효율",
    "group": "XCO"
  },
  {
    "id": "XCO-17",
    "title": "RVI→NXC 장기 인프라 공급",
    "profile": "CONTRACT",
    "observedTarget": "시설 수입·클라우드 원가",
    "group": "XCO"
  },
  {
    "id": "XCO-18",
    "title": "RVI→NXC 전력 공급 장애",
    "profile": "INCIDENT",
    "observedTarget": "가동률·서비스 배상",
    "group": "XCO"
  },
  {
    "id": "XCO-19",
    "title": "NXC↔RVI 용량 확대 협약",
    "profile": "CAPEX",
    "observedTarget": "투자·예약 용량·수입 시점",
    "group": "XCO"
  },
  {
    "id": "XCO-20",
    "title": "TLR↔HGI 에너지비 전가 협상",
    "profile": "CONTRACT",
    "observedTarget": "계약단가·양측 마진",
    "group": "XCO"
  },
  {
    "id": "XCO-21",
    "title": "VTR→HGI 부품대금 연체",
    "profile": "FINANCE",
    "observedTarget": "VTR 미지급·HGI 채권 위험",
    "group": "XCO"
  },
  {
    "id": "XCO-22",
    "title": "DNL→VTR 설비 발주 취소",
    "profile": "CONTRACT",
    "observedTarget": "고객 투자·공급자 수주·위약금",
    "group": "XCO"
  },
  {
    "id": "XCO-23",
    "title": "LMB→NXC 연구 계산 서비스",
    "profile": "CONTRACT",
    "observedTarget": "연구 운영비·구독 매출",
    "group": "XCO"
  },
  {
    "id": "XCO-24",
    "title": "AUR↔RVI 실증 기반시설 계약",
    "profile": "CONTRACT",
    "observedTarget": "단계별 투자·조건부 이용료",
    "group": "XCO"
  }
]);

