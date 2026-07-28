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
 * 사전 두 곳을 순서대로 찾습니다.
 *   ① 표준국어대사전 (STDICT_KEY)   — 규범 사전. 여기 있으면 표준어입니다.
 *   ② 우리말샘        (OPENDICT_KEY) — 개방형 사전. 표제어가 훨씬 많아
 *                                      복합명사·신조어·전문용어까지 나옵니다.
 *
 * ②는 OPENDICT_KEY를 등록했을 때만 동작합니다. 등록하지 않으면 지금처럼
 * ①만 쓰므로, 키가 없다고 해서 기능이 깨지지 않습니다.
 *
 * 순서가 중요합니다. 우리말샘은 이용자가 직접 등록한 뜻풀이도 담고 있어
 * 규범성이 표준국어대사전보다 낮습니다. 그래서 규범 사전을 먼저 보고,
 * 없을 때만 보조로 씁니다. 화면에도 어느 사전에서 왔는지 표시합니다.
 *
 * ⚠️ 인증키를 이 파일에 적지 마세요.
 *    Vercel → Settings → Environment Variables 에 등록합니다.
 */

const STDICT_API_URL = 'https://stdict.korean.go.kr/api/search.do';
const OPENDICT_API_URL = 'https://opendict.korean.go.kr/api/search';

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
 * 응답 본문(JSON 문자열)에서 뜻풀이를 뽑아냅니다.
 * 두 사전의 응답 구조가 같아 함수 하나로 처리됩니다.
 */
function parseEntries(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.error) return null;

  const items = toArray(data.channel && data.channel.item);
  const definitions = [];
  for (const item of items) {
    for (const sense of toArray(item.sense)) {
      const definition = (sense.definition || '').trim();
      if (!definition) continue;
      // 품사는 사전에 따라 item 또는 sense 쪽에 붙어 옵니다.
      const pos = (item.pos || sense.pos || sense.type || '').trim();
      definitions.push(pos ? `「${pos}」 ${definition}` : definition);
    }
  }
  if (definitions.length === 0) return null;
  return { items, definitions };
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
  const stdictKey = (process.env.STDICT_KEY || '').trim();
  const opendictKey = (process.env.OPENDICT_KEY || '').trim();

  if (!stdictKey && !opendictKey) {
    // 환경 변수를 등록하지 않았거나, 등록 후 재배포를 하지 않은 경우입니다.
    return res.status(503).json({ error: '국어사전 기능이 아직 설정되지 않았습니다.' });
  }

  // ⚠️ 두 API 모두 잘못된 파라미터를 받아도 오류를 내지 않고 HTTP 200 +
  //    빈 본문을 돌려줍니다. 그래서 원인을 찾기가 매우 어렵습니다.
  //    실측으로 확인한 값: num=10(10 단위)·sort=dict 는 정상,
  //    num=3·sort=popular 는 빈 본문.
  function buildUrl(base, key, word) {
    return (
      `${base}?key=${encodeURIComponent(key)}` +
      `&q=${encodeURIComponent(word)}&req_type=json&num=10&sort=dict`
    );
  }

  async function fetchRaw(base, key, word) {
    const upstream = await fetch(buildUrl(base, key, word));
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    return upstream.text();
  }

  /**
   * 사전 한 곳에서 찾습니다. 원형으로 먼저 찾고, 없으면 조사를 떼고
   * 한 번만 더 시도합니다.
   */
  async function lookUp(base, key) {
    if (!key) return null;

    let raw = await fetchRaw(base, key, query);
    let matchedWord = query;

    if (!raw.trim()) {
      const stem = stripJosa(query);
      if (stem) {
        const stemRaw = await fetchRaw(base, key, stem);
        if (stemRaw.trim()) {
          raw = stemRaw;
          matchedWord = stem;
        }
      }
    }

    if (!raw.trim()) return null;
    const parsed = parseEntries(raw);
    return parsed ? { ...parsed, matchedWord } : null;
  }

  // ① 규범 사전 → ② 개방형 사전 순으로 찾습니다.
  let found = null;
  let source = 'stdict';
  try {
    found = await lookUp(STDICT_API_URL, stdictKey);
    if (!found && opendictKey) {
      found = await lookUp(OPENDICT_API_URL, opendictKey);
      if (found) source = 'opendict';
    }
  } catch (e) {
    return res.status(502).json({ error: '사전 서비스에 연결하지 못했습니다.' });
  }

  if (!found) {
    // 빈 응답은 두 가지 뜻을 동시에 가집니다. 이 API의 가장 고약한 점입니다.
    //   (가) 정말로 검색 결과가 없다
    //   (나) 인증키가 틀렸거나 이 서버에서 API를 이용할 수 없다
    // 둘 다 HTTP 200 + 0바이트로 똑같이 옵니다. 구분하지 않으면 설정 오류를
    // "그런 단어 없음"으로 잘못 안내하게 되므로, 사전에 반드시 있는 낱말로
    // 대조 요청을 한 번 보내 판별합니다. (못 찾았을 때만 실행됩니다)
    let controlFailed = false;
    try {
      const base = stdictKey ? STDICT_API_URL : OPENDICT_API_URL;
      const key = stdictKey || opendictKey;
      controlFailed = !(await fetchRaw(base, key, '사과')).trim();
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
    word: cleanHeadword(found.items[0].word) || found.matchedWord,
    // 조사를 떼고 찾았을 때, 사용자가 무엇을 검색했는지 화면에 알려 주기 위한
    // 값입니다. ('사과를'로 찾았는데 '사과'가 나오면 혼란스러우므로)
    queried: query !== found.matchedWord ? query : '',
    hanja: (found.items[0].origin || '').trim(),
    pronunciation: '', // 검색 API는 발음 정보를 제공하지 않습니다.
    definitions: found.definitions,
    source,
  });
};
