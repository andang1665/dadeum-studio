/**
 * ==========================================================================
 * 다듬 스튜디오 (Dadeum Studio) 어조 & 문체 교정 엔진
 * --------------------------------------------------------------------------
 * 문장의 종결 어미를 분석해 세 가지 문체로 변환합니다.
 *   formal : 합쇼체  (~합니다 / ~습니다)
 *   polite : 해요체  (~해요 / ~어요)
 *   report : 개조식  (~함 / ~임)
 *
 * 이전 버전은 정규식에 \b(단어 경계)를 사용했는데, \b는 ASCII 기준이라
 * 한글에서는 결코 매칭되지 않아 어떤 변환도 일어나지 않았습니다.
 * 이번 버전은 한글 음절을 초성/중성/종성으로 분해·조합해 어간을 직접
 * 활용시키므로, 사전에 없는 동사도 규칙적으로 변환됩니다.
 * ==========================================================================
 */

class DadeumToneEngine {
  constructor() {
    // 한글 음절 조합 상수
    this.HANGUL_BASE = 0xac00;
    this.HANGUL_LAST = 0xd7a3;
    this.JONG_COUNT = 28;
    this.JUNG_COUNT = 21;

    // 종성(받침) 인덱스: 0 = 받침 없음
    this.JONG_NONE = 0;
    this.JONG_N = 4;   // ㄴ
    this.JONG_B = 17;  // ㅂ
    this.JONG_M = 16;  // ㅁ
    this.JONG_SS = 20; // ㅆ

    // 중성(모음) 인덱스 — 모음조화 판정에 사용
    this.JUNG_A = 0;   // ㅏ
    this.JUNG_O = 8;   // ㅗ

    // 불규칙/고빈도 표현은 규칙 활용보다 우선해 그대로 치환합니다.
    // (긴 표현이 먼저 매칭되도록 순서가 중요합니다.)
    this.explicitMap = {
      formal: [
        ['해 주세요', '해 주시기 바랍니다'],
        ['해주세요', '해 주시기 바랍니다'],
        ['주세요', '주시기 바랍니다'],
        ['해 줘', '해 주시기 바랍니다'],
        ['해줘', '해 주시기 바랍니다'],
        ['해줄래', '해 주시겠습니까'],
        ['할게요', '하겠습니다'],
        ['할게', '하겠습니다'],
        ['할래요', '하겠습니다'],
        ['할래', '하겠습니다'],
        ['거예요', '것입니다'],
        ['거야', '것입니다'],
        ['에요', '입니다'],
        ['예요', '입니다'],
        ['이야', '입니다'],
        ['부탁해', '부탁드립니다'],
        ['고마워', '감사합니다'],
        ['미안해', '죄송합니다'],
        ['안녕', '안녕하십니까'],
      ],
      polite: [
        ['해 주시기 바랍니다', '해 주세요'],
        ['주시기 바랍니다', '주세요'],
        ['해 줘', '해 주세요'],
        ['해줘', '해 주세요'],
        ['해줄래', '해 줄래요'],
        ['부탁해', '부탁해요'],
        ['고마워', '고마워요'],
        ['미안해', '미안해요'],
        ['하시기 바랍니다', '하세요'],
        ['하십시오', '하세요'],
        ['하십시요', '하세요'],
        ['감사합니다', '고마워요'],
        ['죄송합니다', '미안해요'],
        ['것입니다', '거예요'],
        ['하겠습니다', '할게요'],
        ['드립니다', '드려요'],
      ],
      report: [
        ['해 주시기 바랍니다', '요청함'],
        ['주시기 바랍니다', '요청함'],
        ['감사합니다', '감사함'],
        ['죄송합니다', '사과함'],
        ['것입니다', '것임'],
        ['하겠습니다', '예정임'],
        ['드립니다', '드림'],
      ],
    };

    // 종결 어미 → 평서형 기본꼴('~다')로 되돌리기 위한 표.
    // 어떤 문체로 쓰인 문장이든 먼저 기본꼴로 정규화한 뒤, 목표 문체로
    // 다시 활용시키는 2단계 방식이라 문체 간 상호 변환이 안정적입니다.
    this.toPlain = [
      // 과거형
      ['했습니다', '했다'], ['했어요', '했다'], ['했어', '했다'], ['했음', '했다'],
      ['였습니다', '였다'], ['였어요', '였다'],
      ['았습니다', '았다'], ['았어요', '았다'], ['았어', '았다'],
      ['었습니다', '었다'], ['었어요', '었다'], ['었어', '었다'],
      // 현재형 (하다)
      ['합니다', '한다'], ['해요', '한다'], ['해', '한다'], ['함', '한다'],
      // 계사 (이다)
      ['입니다', '이다'], ['이에요', '이다'], ['예요', '이다'], ['임', '이다'],
      // 있다/없다
      ['있습니다', '있다'], ['있어요', '있다'], ['있어', '있다'], ['있음', '있다'],
      ['없습니다', '없다'], ['없어요', '없다'], ['없어', '없다'], ['없음', '없다'],
      // 되다
      ['됐습니다', '됐다'], ['됐어요', '됐다'], ['됐어', '됐다'], ['됐음', '됐다'],
      ['됩니다', '된다'], ['돼요', '된다'], ['돼', '된다'], ['됨', '된다'],
      // 고빈도 형용사 해체/해요체 (좋아 → 좋다)
      ['좋아요', '좋다'], ['좋아', '좋다'],
      ['같아요', '같다'], ['같아', '같다'],
      ['맞아요', '맞다'], ['맞아', '맞다'],
      ['싫어요', '싫다'], ['싫어', '싫다'],
      ['많아요', '많다'], ['많아', '많다'],
    ];

    // 종성(받침) ㄹ — '~ㄹ게'(갈게, 볼게) 판정에 사용
    this.JONG_L = 8;
  }

  // ---------- 한글 음절 분해 / 조합 ----------

  isHangulSyllable(ch) {
    const code = ch.charCodeAt(0);
    return code >= this.HANGUL_BASE && code <= this.HANGUL_LAST;
  }

  decompose(ch) {
    if (!this.isHangulSyllable(ch)) return null;
    const offset = ch.charCodeAt(0) - this.HANGUL_BASE;
    return {
      cho: Math.floor(offset / (this.JUNG_COUNT * this.JONG_COUNT)),
      jung: Math.floor(offset / this.JONG_COUNT) % this.JUNG_COUNT,
      jong: offset % this.JONG_COUNT,
    };
  }

  compose(cho, jung, jong) {
    return String.fromCharCode(
      this.HANGUL_BASE + (cho * this.JUNG_COUNT + jung) * this.JONG_COUNT + jong
    );
  }

  /** 마지막 글자에 받침이 있는지 */
  hasBatchim(word) {
    const parts = this.decompose(word[word.length - 1]);
    return parts ? parts.jong !== this.JONG_NONE : false;
  }

  /** 마지막 글자의 받침을 지정한 값으로 바꿔 반환 */
  withBatchim(word, jong) {
    const last = word[word.length - 1];
    const parts = this.decompose(last);
    if (!parts) return word;
    return word.slice(0, -1) + this.compose(parts.cho, parts.jung, jong);
  }

  /** 마지막 글자 모음이 양성모음(ㅏ/ㅗ)인지 — '아요' vs '어요' 판정 */
  isBrightVowel(word) {
    const parts = this.decompose(word[word.length - 1]);
    if (!parts) return false;
    return parts.jung === this.JUNG_A || parts.jung === this.JUNG_O;
  }

  // ---------- 어간 추출 ----------

  /**
   * 평서형('~다')에서 어간을 뽑습니다.
   *   먹는다 → 먹 / 간다 → 가 / 먹다 → 먹 / 하다 → 하
   */
  getStem(plainWord) {
    if (!plainWord.endsWith('다')) return null;

    let stem = plainWord.slice(0, -1);
    if (stem.length === 0) return null;

    // '~는다' (먹는다 → 먹)
    if (stem.endsWith('는')) return stem.slice(0, -1);

    // '~ㄴ다' 의 ㄴ 받침 제거 (간다 → 가, 한다 → 하)
    const parts = this.decompose(stem[stem.length - 1]);
    if (parts && parts.jong === this.JONG_N) {
      return this.withBatchim(stem, this.JONG_NONE);
    }

    return stem;
  }

  // ---------- 문체별 활용 ----------

  /** 어간 → 합쇼체 (갑니다 / 먹습니다 / 작성합니다) */
  toFormal(stem) {
    // '하다' 계열: 작성하 → 작성합니다
    if (stem.endsWith('하')) return stem.slice(0, -1) + '합니다';
    // 계사 '이다': 사과이 → 사과입니다
    if (stem.endsWith('이')) return stem.slice(0, -1) + '입니다';
    if (this.hasBatchim(stem)) return stem + '습니다';
    return this.withBatchim(stem, this.JONG_B) + '니다';
  }

  /** 어간 → 해요체 (가요 / 먹어요 / 작성해요) */
  toPolite(stem) {
    // '하다' 계열: 작성하 → 작성해요
    if (stem.endsWith('하')) return stem.slice(0, -1) + '해요';
    if (stem.endsWith('되')) return stem.slice(0, -1) + '돼요';

    // 계사 '이다': 받침 유무에 따라 '이에요' / '예요'
    if (stem.endsWith('이')) {
      const noun = stem.slice(0, -1);
      if (!noun) return '예요';
      return noun + (this.hasBatchim(noun) ? '이에요' : '예요');
    }

    if (this.hasBatchim(stem)) {
      return stem + (this.isBrightVowel(stem) ? '아요' : '어요');
    }

    // 받침이 없으면 어간 모음과 어미가 축약됩니다 (가 + 아요 → 가요)
    const parts = this.decompose(stem[stem.length - 1]);
    if (parts && (parts.jung === this.JUNG_A || parts.jung === 4 /* ㅓ */)) {
      return stem + '요';
    }
    return stem + (this.isBrightVowel(stem) ? '아요' : '어요');
  }

  /** 어간 → 개조식 명사형 (감 / 먹음 / 작성함) */
  toReport(stem) {
    if (stem.endsWith('이')) return stem.slice(0, -1) + '임';
    if (this.hasBatchim(stem)) return stem + '음';
    return this.withBatchim(stem, this.JONG_M);
  }

  // ---------- 메인 변환 ----------

  /**
   * @param {string} text
   * @param {'formal'|'polite'|'report'} mode
   */
  convert(text, mode = 'formal') {
    if (!text || !['formal', 'polite', 'report'].includes(mode)) return text;

    // 문장을 종결 부호 단위로 나누되, 부호와 뒤따르는 공백은 그대로 보존합니다.
    const segments = text.split(/([.!?]+\s*|\n+)/);

    return segments
      .map((segment) => {
        // 구분자(부호/줄바꿈)는 건드리지 않습니다.
        if (/^([.!?]+\s*|\n+)$/.test(segment) || segment.trim() === '') return segment;
        return this.convertSentence(segment, mode);
      })
      .join('');
  }

  /**
   * 약속형 '~ㄹ게'를 목표 문체로 변환합니다. (갈게 → 가겠습니다 / 갈게요 / 갈 예정임)
   * 해당 형태가 아니면 null을 반환합니다.
   */
  convertLGe(core, mode) {
    if (!core.endsWith('게') && !core.endsWith('게요')) return null;

    const body = core.endsWith('게요') ? core.slice(0, -2) : core.slice(0, -1);
    if (!body) return null;

    const parts = this.decompose(body[body.length - 1]);
    if (!parts || parts.jong !== this.JONG_L) return null;

    const stem = this.withBatchim(body, this.JONG_NONE);

    if (mode === 'formal') return stem + '겠습니다';
    if (mode === 'polite') return body + '게요';
    return body + ' 예정임';
  }

  convertSentence(sentence, mode) {
    // 문장 끝의 공백은 보존하고 실제 내용만 변환합니다.
    const match = sentence.match(/^([\s\S]*?)(\s*)$/);
    const core = match[1];
    const trailingSpace = match[2];
    if (!core) return sentence;

    // 1) 불규칙·고빈도 표현 우선 치환
    for (const [from, to] of this.explicitMap[mode]) {
      if (core.endsWith(from)) {
        return core.slice(0, -from.length) + to + trailingSpace;
      }
    }

    // 1-b) 약속형 '~ㄹ게' (갈게, 볼게, 보낼게 …) — 어간의 ㄹ 받침을 떼고 활용
    const lGeConverted = this.convertLGe(core, mode);
    if (lGeConverted !== null) return lGeConverted + trailingSpace;

    // 2) 어떤 문체든 평서형('~다')으로 정규화
    let plain = core;
    let normalized = false;
    for (const [from, to] of this.toPlain) {
      if (plain.endsWith(from)) {
        plain = plain.slice(0, -from.length) + to;
        normalized = true;
        break;
      }
    }

    // 정규화도 안 되고 '~다'로 끝나지도 않으면 변환 대상이 아닙니다.
    if (!normalized && !plain.endsWith('다')) return sentence;

    // 3) 목표 문체로 활용
    const words = plain.split(' ');
    const lastWord = words[words.length - 1];
    const stem = this.getStem(lastWord);
    if (!stem) return sentence;

    let converted;
    if (mode === 'formal') converted = this.toFormal(stem);
    else if (mode === 'polite') converted = this.toPolite(stem);
    else converted = this.toReport(stem);

    words[words.length - 1] = converted;
    return words.join(' ') + trailingSpace;
  }
}

if (typeof window !== 'undefined') {
  window.DadeumToneEngine = DadeumToneEngine;
}
