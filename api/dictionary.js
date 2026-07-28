/**
 * ==========================================================================
 * 국어사전 API 프록시 — Vercel 서버리스 함수
 * ==========================================================================
 *
 * 요청 주소:  GET /api/dictionary?q=사과
 *
 * 왜 중계 서버가 필요한가
 *   1) 국립국어원 API는 CORS 헤더를 보내지 않습니다. 브라우저가 직접 부르면
 *      차단당합니다.
 *   2) 인증키를 브라우저 코드에 넣으면 저장소가 공개라 그대로 노출됩니다.
 *      키는 Vercel의 환경 변수에만 두고, 브라우저로는 검색 결과만 보냅니다.
 *
 * 사전 세 곳을 순서대로 찾습니다. 순서가 곧 신뢰도 순서입니다.
 *   ① 표준국어대사전 (STDICT_KEY)   — 규범 사전. 여기 있으면 표준어입니다.
 *   ② 우리말샘        (OPENDICT_KEY) — 개방형 사전. 복합명사·신조어까지.
 *   ③ 온용어          (TERM_KEY)     — 전문용어 사전. 분야별 학술·산업 용어.
 *
 * 규범성이 높은 쪽을 먼저 봐야 합니다. 개방형·전문용어 사전을 먼저 보면
 * "여기 있으니까 표준어"라고 오해하게 됩니다. 화면에도 어느 사전에서 왔는지
 * 구분해 표시합니다.
 *
 * 키를 등록하지 않은 사전은 그냥 건너뜁니다. 그래서 키가 하나만 있어도
 * 기능이 깨지지 않습니다.
 *
 * ⚠️ 인증키를 이 파일에 적지 마세요.
 *    Vercel → Settings → Environment Variables 에 등록합니다.
 */

/** 표제어의 어미 구분 기호를 제거합니다. 예: '사과-하다' → '사과하다' */
function cleanHeadword(word) {
  return String(word || '')
    .replace(/[-^]/g, '')
    .replace(/\d+$/, '')
    .trim();
}

/** 결과가 1건이면 배열이 아닌 객체로 오므로 정규화합니다. */
function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 뜻풀이에 섞여 오는 태그와 문자 참조를 걷어냅니다.
 * 온용어는 검색어에 <strong> 태그를 씌워 보내는 경우가 있습니다.
 */
function cleanText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>/g, '')
    .trim();
}

// 글에서 낱말을 집어 오면 '사과를', '학교에서'처럼 조사가 붙어 있습니다.
// 사전은 표제어('사과', '학교')만 싣고 있어 그대로는 못 찾습니다.
//
// 긴 조사를 먼저 떼야 합니다. '에서'를 '에'보다 먼저 보지 않으면
// '학교에서'가 '학교에'로 잘못 잘립니다.
const JOSA = [
  '으로서', '으로써', '에서는', '에게서', '이라는', '라는',
  '으로', '에서', '에게', '한테', '까지', '부터', '조차', '마저',
  '처럼', '보다', '만큼', '이나', '라도', '든지',
  '은', '는', '이', '가', '을', '를', '에', '와', '과', '도', '만', '의', '로', '랑',
];

function stripJosa(word) {
  for (const josa of JOSA) {
    // 조사를 떼고 최소 한 글자는 남아야 합니다.
    if (word.length > josa.length && word.endsWith(josa)) {
      return word.slice(0, -josa.length);
    }
  }
  return null;
}

/**
 * 사전에서 찾아볼 후보를 짧아지는 순서로 만듭니다.
 *
 *   팀원들과 → 팀원들 → 팀원
 *   사과를   → 사과
 *
 * '들'은 조사가 아니라 복수 접미사라 조사를 뗀 뒤에 한 번 더 떼야 합니다.
 * 표제어는 '팀원'이지 '팀원들'이 아니기 때문입니다.
 */
function lookupCandidates(word) {
  const list = [word];

  const noJosa = stripJosa(word);
  if (noJosa) list.push(noJosa);

  for (const candidate of [...list]) {
    if (candidate.length > 2 && candidate.endsWith('들')) {
      list.push(candidate.slice(0, -1));
    }
  }

  return [...new Set(list)];
}

// ==========================================================================
// 사전별 어댑터
//
// 세 사전은 파라미터 이름도 응답 구조도 제각각입니다. 분기문으로 처리하면
// 금방 엉키므로, 사전마다 "주소 만들기 + 응답 해석하기" 한 쌍으로 묶습니다.
// 사전을 추가할 때는 이 배열에 한 덩어리만 더하면 됩니다.
// ==========================================================================

const DICTIONARIES = [
  {
    id: 'stdict',
    envVar: 'STDICT_KEY',
    // ⚠️ 잘못된 파라미터를 줘도 오류 없이 HTTP 200 + 빈 본문이 옵니다.
    //    실측: num=10(10 단위)·sort=dict 는 정상, num=3·sort=popular 는 빈 본문.
    buildUrl: (key, word) =>
      `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(key)}` +
      `&q=${encodeURIComponent(word)}&req_type=json&num=10&sort=dict`,
    parse: (data) => parseStandardShape(data),
  },
  {
    id: 'opendict',
    envVar: 'OPENDICT_KEY',
    buildUrl: (key, word) =>
      `https://opendict.korean.go.kr/api/search?key=${encodeURIComponent(key)}` +
      `&q=${encodeURIComponent(word)}&req_type=json&num=10&sort=dict`,
    parse: (data) => parseStandardShape(data),
  },
  {
    id: 'term',
    envVar: 'TERM_KEY',
    // 온용어만 검색어 파라미터 이름이 q 가 아니라 apiSearchWord 입니다.
    buildUrl: (key, word) =>
      `https://kli.korean.go.kr/term/api/search.do?key=${encodeURIComponent(key)}` +
      `&apiSearchWord=${encodeURIComponent(word)}&num=10&sort=wt`,
    parse: (data, word) => parseTermShape(data, word),
  },
];

/** 표준국어대사전·우리말샘의 공통 응답 구조를 해석합니다. */
function parseStandardShape(data) {
  const items = toArray(data.channel && data.channel.item);
  const definitions = [];
  for (const item of items) {
    for (const sense of toArray(item.sense)) {
      const definition = cleanText(sense.definition);
      if (!definition) continue;
      // 품사는 사전에 따라 item 또는 sense 쪽에 붙어 옵니다.
      const pos = cleanText(item.pos || sense.pos || sense.type);
      definitions.push(pos ? `「${pos}」 ${definition}` : definition);
    }
  }
  if (definitions.length === 0) return null;
  return {
    definitions,
    headword: cleanHeadword(items[0].word),
    hanja: cleanText(items[0].origin),
  };
}

/**
 * 온용어 응답을 해석합니다. 구조가 다릅니다.
 *   channel.return_object[].resultlist[] → { word, definition, origin, category_main … }
 *
 * 온용어 검색은 '포함' 검색이라 '알고리즘'을 찾으면 277건이 나옵니다.
 * 그대로 쓰면 엉뚱한 용어가 딸려 오므로 표제어가 정확히 같은 것만 씁니다.
 */
function parseTermShape(data, word) {
  const rows = [];
  for (const group of toArray(data.channel && data.channel.return_object)) {
    for (const row of toArray(group.resultlist)) rows.push(row);
  }

  const exact = rows.filter((row) => cleanText(row.word) === word);
  if (exact.length === 0) return null;

  const definitions = [];
  const seen = new Set();
  for (const row of exact) {
    const definition = cleanText(row.definition);
    if (!definition || seen.has(definition)) continue;
    seen.add(definition);
    // 전문용어는 분야를 같이 보여 줘야 뜻이 통합니다.
    // (같은 낱말이 법률에서와 공학에서 뜻이 다릅니다)
    const field = cleanText(row.category_sub || row.category_main);
    definitions.push(field ? `「${field}」 ${definition}` : definition);
  }
  if (definitions.length === 0) return null;

  return {
    definitions,
    headword: cleanText(exact[0].word),
    hanja: cleanText(exact[0].origin),
  };
}

// package.json에 "type": "module"이 없으므로 이 파일은 CommonJS로 해석됩니다.
// export default 로 쓰면 배포 시 구문 오류가 나므로 module.exports를 씁니다.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: '지원하지 않는 방식입니다.' });
  }

  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    return res.status(400).json({ error: '검색어가 없습니다.' });
  }
  if (query.length > 50) {
    return res.status(400).json({ error: '검색어가 너무 깁니다.' });
  }

  // 환경 변수에 값을 붙여 넣을 때 앞뒤 공백이나 줄바꿈이 딸려 오는 일이
  // 흔합니다. 그대로 두면 인증키가 통째로 무효가 되므로 잘라냅니다.
  const available = DICTIONARIES
    .map((dict) => ({ ...dict, key: (process.env[dict.envVar] || '').trim() }))
    .filter((dict) => dict.key);

  if (available.length === 0) {
    // 환경 변수를 등록하지 않았거나, 등록 후 재배포를 하지 않은 경우입니다.
    return res.status(503).json({ error: '국어사전 기능이 아직 설정되지 않았습니다.' });
  }

  async function fetchJson(dict, word) {
    const upstream = await fetch(dict.buildUrl(dict.key, word));
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const raw = await upstream.text();
    // 표준국어대사전은 '결과 없음'을 빈 본문으로 알려 옵니다.
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 사전 한 곳에서 후보들을 차례로 찾아봅니다.
   *
   * 재시도 여부는 "본문이 비었는가"가 아니라 "뜻풀이를 얻었는가"로 판단해야
   * 합니다. 사전마다 '결과 없음'을 표현하는 방식이 다르기 때문입니다.
   *   표준국어대사전 : 본문 0바이트
   *   우리말샘·온용어 : 정상 JSON인데 항목이 없음
   */
  async function lookUp(dict) {
    for (const candidate of lookupCandidates(query)) {
      const data = await fetchJson(dict, candidate);
      if (!data || data.error) continue;
      const parsed = dict.parse(data, candidate);
      if (parsed) return { ...parsed, matchedWord: candidate };
    }
    return null;
  }

  let found = null;
  let source = null;
  try {
    for (const dict of available) {
      found = await lookUp(dict);
      if (found) {
        source = dict.id;
        break;
      }
    }
  } catch (e) {
    return res.status(502).json({ error: '사전 서비스에 연결하지 못했습니다.' });
  }

  if (!found) {
    // 아무 데서도 못 찾았을 때, 두 가지를 구분해야 합니다.
    //   (가) 정말로 그런 낱말이 없다
    //   (나) 인증키가 틀렸거나 이 서버에서 API를 이용할 수 없다
    // 구분하지 않으면 설정 오류를 "그런 단어 없음"으로 잘못 안내하게 되므로,
    // 사전에 반드시 있는 낱말로 대조 요청을 보내 판별합니다.
    let controlFailed = false;
    try {
      const data = await fetchJson(available[0], '사과');
      controlFailed = !data;
    } catch (e) {
      controlFailed = true;
    }

    if (controlFailed) {
      return res.status(503).json({
        error:
          '사전 서버가 요청을 거부했습니다. 인증키가 올바른지, 그리고 국립국어원에 ' +
          '등록한 이용 정보가 현재 배포 주소와 맞는지 확인해 주세요.',
        code: 'STDICT_REJECTED',
      });
    }
    return res.status(404).json({ error: `'${query}'에 대한 검색 결과가 없습니다.` });
  }

  // 사전 뜻풀이는 거의 바뀌지 않으므로 Vercel 엣지에 하루 캐시합니다.
  // 같은 단어를 여러 사람이 찾아도 국립국어원 서버는 한 번만 부릅니다.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');

  return res.status(200).json({
    word: found.headword || found.matchedWord,
    // 조사를 떼고 찾았을 때, 사용자가 무엇을 검색했는지 화면에 알려 주기 위한
    // 값입니다. ('사과를'로 찾았는데 '사과'가 나오면 혼란스러우므로)
    queried: query !== found.matchedWord ? query : '',
    hanja: found.hanja || '',
    pronunciation: '', // 검색 API는 발음 정보를 제공하지 않습니다.
    definitions: found.definitions,
    source,
  });
};
