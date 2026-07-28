/**
 * 다듬 스튜디오 규칙 엔진 회귀 테스트
 *
 *   실행:  node test/rules.test.js
 *
 * 두 가지를 측정합니다.
 *   1. 검출률  — 틀린 문장에서 오류를 잡아내는가
 *   2. 오탐률  — 맞는 문장을 틀렸다고 하지 않는가  ← 이쪽이 더 중요합니다
 *
 * 규칙을 추가할 때마다 이 파일에 케이스를 함께 넣어 주세요.
 * 특히 CLEAN(정상 문장) 목록을 늘리는 것이 오탐을 막는 유일한 방법입니다.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// 브라우저용 파일이라 window 를 흉내 낸 컨텍스트에서 실행합니다.
const sandbox = { window: {}, console, module: undefined };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'rules-ko.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'checker-engine.js'), 'utf8'), sandbox);

const engine = new sandbox.window.DadeumCheckerEngine();
const ruleCount = (sandbox.window.DADEUM_RULES || []).length;

// ---------------------------------------------------------------------------
// 1. 틀린 문장 — [문장, 반드시 포함되어야 할 교정 결과]
// ---------------------------------------------------------------------------
const WRONG = [
  // 되/돼  (슬로건 핵심)
  ['그렇게 하면 안되.', '돼'],
  ['이제 다 됬어요.', '됐'],
  ['내일이면 되요.', '돼요'],
  ['비가 와서 안 되서 못 갔다.', '돼서'],
  ['빨리 되야 하는데.', '돼야'],
  ['그건 안 돼고 이건 된다.', '되고'],
  ['그렇게 돼면 곤란합니다.', '되면'],
  ['일이 잘 돼다.', '되다'],

  // 안/않  (슬로건 핵심)
  ['숙제를 하지않았다.', '하지 않'],
  ['밥을 먹지않고 나갔다.', '먹지 않'],
  ['그건 않되는 일입니다.', '안 되'],
  ['이건 정말 않 좋다.', '안 좋'],
  ['기분이 좋지않아요.', '좋지 않'],
  ['시간이 맞지않습니다.', null],

  // 자주 틀리는 표기
  ['오늘이 몇일이지?', '며칠'],
  ['웬지 기분이 좋다.', '왠지'],
  ['왠일로 일찍 왔어?', '웬일'],
  ['이걸 어떻해?', '어떡해'],
  ['정말 오랫만이야.', '오랜만'],
  ['금새 끝났다.', '금세'],
  ['설겆이를 했다.', '설거지'],
  ['그의 역활이 크다.', '역할'],
  ['구지 그렇게까지?', '굳이'],
  ['일일히 확인했다.', '일일이'],
  ['깨끗히 청소했다.', '깨끗이'],
  ['솔직이 말하면 싫어.', '솔직히'],
  ['찌게를 끓였다.', '찌개'],
  ['통채로 삼켰다.', '통째로'],
  ['나중에 뵈요.', '봬요'],

  // 띄어쓰기
  ['나는 할수 있다.', '할 수'],
  ['그건 갈수 없어.', '갈 수'],
  ['먹을만큼만 가져가.', '먹을 만큼'],
  ['집에 가는길에 들렀다.', '가는 길'],
  ['한달 동안 준비했다.', '한 달'],
  ['사람 세명이 왔다.', '세 명'],
  ['사과 두개를 샀다.', '두 개'],

  // 어휘
  ['나는 학생으로써 최선을 다했다.', '학생으로서'],
  ['담당자로써 책임지겠습니다.', '담당자로서'],
  ['일찌기 그런 일은 없었다.', '일찍이'],
];

// ---------------------------------------------------------------------------
// 2. 정상 문장 — 여기서 오류가 나오면 오탐(false positive)
// ---------------------------------------------------------------------------
const CLEAN = [
  '오늘은 날씨가 좋아서 밖에 나갔다.',
  '그렇게 하면 안 돼.',
  '이제 다 됐어요.',
  '내일이면 돼요.',
  '숙제를 하지 않았다.',
  '그건 안 되는 일입니다.',
  '오늘이 며칠이지?',
  '왠지 기분이 좋다.',
  '웬일로 일찍 왔어?',
  '나는 할 수 있다.',
  '먹을 만큼만 가져가.',
  '집에 가는 길에 들렀다.',
  '한 달 동안 준비했다.',
  '나는 학생으로서 최선을 다했다.',
  '이것으로써 발표를 마치겠습니다.',
  '정말 오랜만이야.',
  '깨끗이 청소했다.',
  '회의가 끝나고 결재를 올렸다.',
  '카드로 결제했습니다.',
  '그는 일이 잘 안돼서 힘들어했다.',
  '많이 되었다고 생각합니다.',
  '문제가 되지 않습니다.',
];

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
function corrected(text) {
  return engine.check(text, []).map((i) => i.replacement).join(' | ');
}

let detected = 0;
const missed = [];

console.log('='.repeat(70));
console.log(`규칙 수: ${ruleCount}개 (rules-ko.js)`);
console.log('='.repeat(70));
console.log('\n[1] 검출 테스트 — 틀린 문장에서 오류를 잡아내는가\n');

for (const [text, expect] of WRONG) {
  const issues = engine.check(text, []);
  const out = issues.map((i) => `${i.original}→${i.replacement}`).join(', ');
  const ok = expect === null ? issues.length > 0 : out.includes(expect);
  if (ok) {
    detected++;
    console.log(`  ✅ ${text}`);
    console.log(`       ${out}`);
  } else {
    missed.push(text);
    console.log(`  ❌ ${text}`);
    console.log(`       검출: ${out || '(없음)'}   기대: ${expect || '(무엇이든)'}`);
  }
}

let falsePositives = 0;
console.log('\n[2] 오탐 테스트 — 맞는 문장을 건드리지 않는가\n');

for (const text of CLEAN) {
  const issues = engine.check(text, []);
  if (issues.length === 0) {
    console.log(`  ✅ ${text}`);
  } else {
    falsePositives++;
    console.log(`  ⚠️  ${text}`);
    console.log(`       오탐: ${issues.map((i) => `${i.original}→${i.replacement}`).join(', ')}`);
  }
}

const detRate = Math.round((detected / WRONG.length) * 100);
const fpRate = Math.round((falsePositives / CLEAN.length) * 100);

console.log('\n' + '='.repeat(70));
console.log(`검출률 : ${detected}/${WRONG.length}  (${detRate}%)`);
console.log(`오탐률 : ${falsePositives}/${CLEAN.length}  (${fpRate}%)   ← 낮을수록 좋음`);
console.log('='.repeat(70));

if (missed.length) {
  console.log('\n못 잡은 문장:');
  missed.forEach((t) => console.log('  · ' + t));
}

process.exitCode = falsePositives > 0 ? 1 : 0;
