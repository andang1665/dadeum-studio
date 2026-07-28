/**
 * ==========================================================================
 * 다듬 스튜디오 (Dadeum Studio) 한국어 맞춤법 & 띄어쓰기 검사 엔진
 * ==========================================================================
 */

/**
 * 자바스크립트 정규식의 \b(단어 경계)는 \w = [A-Za-z0-9_] 를 기준으로 하므로
 * 한글에서는 절대 매칭되지 않습니다.
 *
 *   /\b할수\s*있다\b/.test('할수 있다')  →  false   (규칙이 죽음)
 *   /할수\s*있다/.test('할수 있다')       →  true
 *
 * 기존 규칙 47개가 모두 \b를 쓰고 있어 검사 결과가 항상 0건이었습니다.
 * 규칙을 하나하나 고치는 대신, 실행 시점에 \b를 한글까지 포함하는
 * 전후방 탐색(lookaround)으로 바꿔 줍니다.
 *
 *   앞쪽 \b  →  (?<![가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9])
 *   뒤쪽 \b  →  (?![가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9])
 */
const WORD_CHARS = '가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9';
const LOOKBEHIND = `(?<![${WORD_CHARS}])`;
const LOOKAHEAD = `(?![${WORD_CHARS}])`;

function hangulSafeSource(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    // 이스케이프된 백슬래시(\\)는 건너뛰어, \\b 같은 표현을 잘못 바꾸지 않도록 합니다.
    if (source[i] === '\\' && source[i + 1] === '\\') {
      out += '\\\\';
      i++;
      continue;
    }
    if (source[i] === '\\' && source[i + 1] === 'b') {
      // \b 바로 앞의 문자로 앞/뒤 경계를 판별합니다.
      // 패턴 맨 앞이거나 '(', '|' 뒤라면 여는 경계로 봅니다.
      const prev = out.replace(/\(\?:$/, '(').slice(-1);
      out += (out === '' || prev === '(' || prev === '|') ? LOOKBEHIND : LOOKAHEAD;
      i++;
      continue;
    }
    out += source[i];
  }
  return out;
}

/** 규칙의 정규식을 한 번만 변환해 두고 재사용합니다. */
function normalizeRule(rule) {
  if (rule._normalized) return rule;

  const source = rule.pattern.source;
  if (source.includes('\\b')) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    rule.pattern = new RegExp(hangulSafeSource(source), flags);
  } else if (!rule.pattern.flags.includes('g')) {
    // exec 루프를 쓰므로 g 플래그가 없으면 무한 루프가 됩니다.
    rule.pattern = new RegExp(source, rule.pattern.flags + 'g');
  }

  rule._normalized = true;
  return rule;
}

class DadeumCheckerEngine {
  constructor() {
    // 1. 띄어쓰기 전용 규칙 (Category: 'red')
    this.spacingRules = [
      {
        pattern: /\b할수\s*있다\b/g,
        replacement: '할 수 있다',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '수'는 앞 단어와 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항 (의존 명사는 띄어 쓴다)'
      },
      {
        pattern: /\b할수\s*없다\b/g,
        replacement: '할 수 없다',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '수'는 앞 단어와 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /\b할수\s*밖에\b/g,
        replacement: '할 수밖에',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '수'는 띄어 쓰고, 조사 '밖에'는 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항 및 제41항'
      },
      {
        pattern: /\b갈수\s*밖에\b/g,
        replacement: '갈 수밖에',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '수'는 띄어 쓰고, 조사 '밖에'는 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /(\S+)(것이다|것이다|것으로|것을|것이|것은)\b/g,
        check: (match, p1, p2) => {
          if (p1.endsWith('한') || p1.endsWith('는') || p1.endsWith('을') || p1.endsWith('은') || p1.endsWith('던') || p1.endsWith('ㄹ')) {
            return `${p1} ${p2}`;
          }
          return null;
        },
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '것'은 앞말과 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /\b(먹은|간|어떤|좋은|아는|할|본)\s*것\s*같다\b/g,
        replacement: (m) => m.replace(/\s*것\s*/, ' 것 '),
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '것'은 앞 단어와 띄어 씁니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /(\S+)(때문에|때문이다|때문인)\b/g,
        check: (match, p1, p2) => {
          if (!p1.endsWith('기') && !p1.endsWith('이') && !p1.endsWith('나')) {
            return `${p1} ${p2}`;
          }
          return null;
        },
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '때문'은 앞말과 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /\b잘못된띄어쓰기\b/g,
        replacement: '잘못된 띄어쓰기',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "관형사형 형용사 '잘못된'과 명사 '띄어쓰기'는 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제2항'
      },
      {
        pattern: /\b어쩔수\b/g,
        replacement: '어쩔 수',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '수'는 앞 관형사 '어쩔'과 띄어 씁니다.",
        ruleReference: '한글 맞춤법 제42항'
      },
      {
        pattern: /\b온힘\b/g,
        replacement: '온 힘',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "관형사 '온'은 명사 '힘'과 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제43항'
      },
      {
        pattern: /\b책\s+을\b/g,
        replacement: '책을',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "조사 '을'은 앞 명사에 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제41항 (조사는 그 앞말에 붙여 쓴다)'
      },
      {
        pattern: /\b학교\s+에서\b/g,
        replacement: '학교에서',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "조사 '에서'는 앞 명사에 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제41항'
      },
      {
        pattern: /\b사람\s+이\b/g,
        replacement: '사람이',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "조사 '이'는 앞 명사에 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제41항'
      },
      {
        pattern: /\b너\s+에게\b/g,
        replacement: '너에게',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "조사 '에게'는 앞말에 붙여 씁니다.",
        ruleReference: '한글 맞춤법 제41항'
      },
      {
        pattern: /\b나\s+마저\b/g,
        replacement: '나마저',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "조사 '마저'는 앞 대명사에 붙여 써야 합니다.",
        ruleReference: '한글 맞춤법 제41항'
      },
      {
        pattern: /\b아는체\s*하다\b/g,
        replacement: '아는 체하다',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "의존명사 '체'와 '하다'가 결합한 '체하다'는 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제47항'
      },
      {
        pattern: /\b체크\s*해\s*보다\b/g,
        replacement: '체크해 보다',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "보조용언 '보다'는 본용언과 띄어 쓰는 것이 원칙입니다.",
        ruleReference: '한글 맞춤법 제47항'
      }
    ];

    // 2. 맞춤법 및 철자 오류 규칙 (Category: 'blue')
    this.spellingRules = [
      {
        pattern: /\b금새\b/g,
        replacement: '금세',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'금시에'가 줄어든 말로 '금세'가 바른 표기입니다.",
        ruleReference: '표준어 규정 제14항'
      },
      {
        pattern: /\b몇일\b/g,
        replacement: '며칠',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'몇 일'이 아닌 '며칠'이 올바른 어휘 표기입니다.",
        ruleReference: '한글 맞춤법 제27항'
      },
      {
        pattern: /\b찌게\b/g,
        replacement: '찌개',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'찌개'가 올바른 표준어 표기입니다.",
        ruleReference: '표준어 규정'
      },
      {
        pattern: /\b설레임\b/g,
        replacement: '설렘',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "동사 '설레다'의 명사형은 '설렘'이 바른 표현입니다.",
        ruleReference: '한글 맞춤법 제19항'
      },
      {
        pattern: /\b어떻해\b/g,
        replacement: '어떡해',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'어떻게 해'의 줄임말은 '어떡해'로 적어야 합니다.",
        ruleReference: '한글 맞춤법 제39항'
      },
      {
        pattern: /\b어떡해\s+(해야|할지|하면)\b/g,
        replacement: '어떻게 $1',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "서술어를 수식하는 부사형은 '어떻게'가 맞습니다.",
        ruleReference: '한글 맞춤법 제39항'
      },
      {
        pattern: /\b됬다\b/g,
        replacement: '됐다',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'되었-선'의 줄임말은 '됐-'이므로 '됐다'가 맞습니다.",
        ruleReference: '한글 맞춤법 제35항'
      },
      {
        pattern: /\b됬어\b/g,
        replacement: '됐어',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'되었어'의 줄임말은 '됐어'입니다.",
        ruleReference: '한글 맞춤법 제35항'
      },
      {
        pattern: /\b안돼요\b/g,
        replacement: '안 돼요',
        category: 'blue',
        categoryName: '맞춤법 및 띄어쓰기',
        reason: "부사 '안'과 동사 '돼요'는 띄어 써야 합니다.",
        ruleReference: '한글 맞춤법 제41항'
      },
      {
        pattern: /\b않돼\b/g,
        replacement: '안 돼',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "부사 '안(아니)'을 써야 할 자리에 부정 보조용언 '않'을 쓸 수 없습니다.",
        ruleReference: '한글 맞춤법 제45항'
      },
      {
        pattern: /\b않해\b/g,
        replacement: '안 해',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "부사 '안'을 사용하여 '안 해'로 써야 합니다.",
        ruleReference: '한글 맞춤법 제45항'
      },
      {
        pattern: /\b않가\b/g,
        replacement: '안 가',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'아니 가다'의 줄임말은 '안 가다'입니다.",
        ruleReference: '한글 맞춤법 제45항'
      },
      {
        pattern: /\b뵈요\b/g,
        replacement: '봬요',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'보아요'의 줄임말은 '봬요'입니다.",
        ruleReference: '한글 맞춤법 제35항'
      },
      {
        pattern: /\b내일\s*뵈요\b/g,
        replacement: '내일 봬요',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'뵈어-'의 줄임말 '봬-'에 어미 '-요'가 붙어 '봬요'가 됩니다.",
        ruleReference: '한글 맞춤법 제35항'
      },
      {
        pattern: /\b어의없다\b/g,
        replacement: '어이없다',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "'일이 너무 뜻밖이어서 황당하다'는 뜻은 '어이없다'가 바른 말입니다.",
        ruleReference: '표준어 규정'
      },
      {
        pattern: /\b희안하다\b/g,
        replacement: '희한하다',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "한자어 '稀罕하다'에서 유래한 '희한하다'가 올바른 표기입니다.",
        ruleReference: '표준국어대사전'
      },
      {
        pattern: /\b어물쩡\b/g,
        replacement: '어물쩍',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "말이나 행동을 우물쭈물 넘기는 것은 '어물쩍'이 바른 표현입니다.",
        ruleReference: '표준어 규정'
      },
      {
        pattern: /\b삼가하다\b/g,
        replacement: '삼가다',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "기본형은 '삼가다'이므로 '삼가하다'는 잘못된 표현입니다.",
        ruleReference: '표준어 규정 제17항'
      },
      {
        pattern: /\b오랜만에\b/g,
        replacement: '오랜만에',
        category: 'blue',
        categoryName: '맞춤법 체크',
        reason: "'오랜만'은 '오래간만'의 줄임말로 한 단어입니다. (올바름)",
        ruleReference: '표준국어대사전'
      },
      {
        pattern: /\b오랜 만에\b/g,
        replacement: '오랜만에',
        category: 'red',
        categoryName: '띄어쓰기 오류',
        reason: "'오랜만'은 명사이므로 붙여 써야 합니다.",
        ruleReference: '표준국어대사전'
      },
      {
        pattern: /\b하든지\s*말든지\b/g,
        replacement: '하든지 말든지',
        category: 'blue',
        categoryName: '맞춤법 체크',
        reason: "선택을 나타낼 때는 '-든지'를 씁니다.",
        ruleReference: '한글 맞춤법 제56항'
      },
      {
        pattern: /\b하덤지\b/g,
        replacement: '하든지',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "선택을 의미할 때는 '-든지'를 써야 합니다.",
        ruleReference: '한글 맞춤법 제56항'
      },
      {
        pattern: /\b하던지 말던지\b/g,
        replacement: '하든지 말든지',
        category: 'blue',
        categoryName: '맞춤법 오류',
        reason: "과거를 회상할 때 '-던지'를 쓰며, 선택을 뜻할 때는 '-든지'를 씁니다.",
        ruleReference: '한글 맞춤법 제56항'
      }
    ];

    // 3. 어휘 및 순화어 규칙 (Category: 'green')
    this.vocabRules = [
      {
        pattern: /\b바램\b/g,
        replacement: '바람',
        category: 'green',
        categoryName: '어휘 선택 오류',
        reason: "소망이나 소원을 뜻하는 명사는 '바람'이 올바른 어휘입니다.",
        ruleReference: '표준어 규정 제14항'
      },
      {
        pattern: /\b담궈\b/g,
        replacement: '담가',
        category: 'green',
        categoryName: '어휘 활용 오류',
        reason: "'담그다'의 어간 '담그-' 뒤에 어미 '-아'가 결합하면 '담가'가 됩니다.",
        ruleReference: '한글 맞춤법 제18항'
      },
      {
        pattern: /\b잠궈\b/g,
        replacement: '잠가',
        category: 'green',
        categoryName: '어휘 활용 오류',
        reason: "'잠그다'의 활용형은 '잠가'가 바릅니다.",
        ruleReference: '한글 맞춤법 제18항'
      },
      {
        pattern: /\b무난하다\b/g,
        replacement: '무난하다',
        category: 'green',
        categoryName: '올바른 어휘',
        reason: "'무난하다'가 올바른 표준 표기입니다.",
        ruleReference: '표준어 규정'
      },
      {
        pattern: /\b문안하다\b/g,
        replacement: '무난하다',
        category: 'green',
        categoryName: '어휘 선택 오류',
        reason: "'별다른 어려움이 없다'는 뜻일 때는 '무난하다'를 씁니다.",
        ruleReference: '표준국어대사전'
      }
    ];

    // 4. 문맥 및 어조 교정 규칙 (Category: 'purple')
    this.contextRules = [
      {
        pattern: /\b이거\s*좀\s*해줘\b/g,
        replacement: '이것을 진행해 주세요',
        category: 'purple',
        categoryName: '문맥/다듬은 표현',
        reason: "비즈니스 및 세련된 다듬글 어조에 맞게 정중하고 명확하게 정제된 표현입니다.",
        ruleReference: '다듬 스튜디오 문체 가이드'
      },
      {
        pattern: /\b진짜\s+대박\b/g,
        replacement: '매우 뛰어난',
        category: 'purple',
        categoryName: '문맥/다듬은 표현',
        reason: "구어체 은어 대신 다듬어진 정돈된 어휘로 수정을 권장합니다.",
        ruleReference: '다듬 스튜디오 표현 가이드'
      }
    ];
  }

  /**
   * Main Check Function
   * @param {string} text - User input text
   * @param {Array<string>} customDictionary - Excluded words list
   * @returns {Array<Object>} Issues found
   */
  check(text, customDictionary = []) {
    if (!text || typeof text !== 'string') return [];

    const issues = [];
    let issueIdCounter = 1;

    // Combine all rules. 외부 규칙 파일(js/rules-ko.js)이 로드되어 있으면
    // 함께 사용합니다. 규칙을 계속 늘려갈 곳은 그 파일입니다.
    const externalRules =
      (typeof window !== 'undefined' && window.DADEUM_RULES) ? window.DADEUM_RULES : [];

    const allRules = [
      ...this.spacingRules,
      ...this.spellingRules,
      ...this.vocabRules,
      ...this.contextRules,
      ...externalRules
    ].map(normalizeRule);

    allRules.forEach(rule => {
      let match;
      // Reset regex state
      rule.pattern.lastIndex = 0;

      while ((match = rule.pattern.exec(text)) !== null) {
        // 폭이 0인 매치가 나오면 lastIndex가 전진하지 않아 무한 루프에 빠집니다.
        // (경계 조건만으로 이루어진 패턴에서 실제로 발생했습니다.)
        if (match[0] === '') {
          rule.pattern.lastIndex++;
          continue;
        }

        const matchedText = match[0];
        const startPos = match.index;
        const endPos = startPos + matchedText.length;

        // Check if matched word is in user's custom exclusion dictionary
        const isCustomExcluded = customDictionary.some(customWord => 
          matchedText.includes(customWord) || customWord.includes(matchedText)
        );

        if (isCustomExcluded) continue;

        // Calculate replacement text
        //
        // $1, $2 … 역참조는 이미 손에 쥔 match 배열로 직접 치환합니다.
        // 잘라낸 matchedText에 패턴을 다시 돌리는 방식은 두 가지로 깨집니다.
        //   1) 전후방 탐색(lookaround)이 있는 패턴은 문맥이 잘려 나가 재매칭에
        //      실패합니다. 그러면 replacementText가 원문과 같아져 교정이
        //      조용히 사라집니다. (예: /(할)수(?=\s*있)/ 에 "할수"만 넣으면 실패)
        //   2) g 플래그 정규식을 String.replace()에 넘기면 lastIndex가 0으로
        //      초기화되어 아래 while(exec) 루프가 무한 루프에 빠집니다.
        // match 배열을 쓰면 두 문제가 함께 사라집니다.
        let replacementText = '';
        if (typeof rule.replacement === 'function') {
          replacementText = rule.replacement(matchedText);
        } else if (typeof rule.replacement === 'string') {
          replacementText = rule.replacement.replace(/\$(\d)/g, (token, n) => {
            const group = match[Number(n)];
            return group === undefined ? token : group;
          });
        } else if (rule.check) {
          replacementText = rule.check(matchedText, match[1], match[2]);
        }

        if (!replacementText || replacementText === matchedText) continue;

        // Check for duplicate issues covering the same range
        const isOverlap = issues.some(existing => 
          (startPos >= existing.start && startPos < existing.end) ||
          (endPos > existing.start && endPos <= existing.end)
        );

        if (!isOverlap) {
          issues.push({
            id: `err-${issueIdCounter++}`,
            start: startPos,
            end: endPos,
            original: matchedText,
            replacement: replacementText,
            category: rule.category,
            categoryName: rule.categoryName,
            reason: rule.reason,
            ruleReference: rule.ruleReference || '국립국어원 표준 맞춤법 규정'
          });
        }
      }
    });

    // Sort issues by order of occurrence in text
    return issues.sort((a, b) => a.start - b.start);
  }
}

// Attach to window object
if (typeof window !== 'undefined') {
  window.DadeumCheckerEngine = DadeumCheckerEngine;
}
