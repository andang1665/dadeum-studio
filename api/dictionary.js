/**
 * ==========================================================================
 * 국어사전 API 프록시 — Vercel 서버리스 함수
 * ==========================================================================
 *
 * 요청 주소:  GET /api/dictionary?q=사과
 *
 * 왜 중계 서버가 필요한가
 *   1) 국립국어원 표준국어대사전 API는 CORS 헤더를 보내지 않습니다.
 *      브라우저가 직접 부르면 차단당합니다.
 *   2) 인증키를 브라우저 코드에 넣으면 저장소가 공개라 그대로 노출됩니다.
 *      키는 Vercel의 환경 변수(STDICT_KEY)에만 두고, 브라우저로는
 *      검색 결과만 내려보냅니다.
 *
 * Vercel은 api/ 폴더의 파일을 자동으로 함수로 인식합니다.
 * 설정 파일에 따로 등록할 필요가 없습니다.
 *
 * 사이트와 같은 도메인에서 돌아가므로 CORS 헤더는 필요하지 않습니다.
 *
 * ⚠️ 인증키를 이 파일에 적지 마세요.
 *    Vercel → Settings → Environment Variables 에 STDICT_KEY 로 등록합니다.
 */

const STDICT_API_URL = 'https://stdict.korean.go.kr/api/search.do';

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

  const key = process.env.STDICT_KEY;
  if (!key) {
    // 환경 변수를 등록하지 않았거나, 등록 후 재배포를 하지 않은 경우입니다.
    return res.status(503).json({ error: '국어사전 기능이 아직 설정되지 않았습니다.' });
  }

  // ⚠️ 이 API는 잘못된 파라미터를 받아도 오류를 내지 않고 HTTP 200 + 빈 본문을
  //    돌려줍니다. 그래서 원인을 찾기가 매우 어렵습니다. 실측으로 확인한 값:
  //      num=10, num=20 … (10 단위) → 정상 /  num=3 → 빈 본문
  //      sort=dict                  → 정상 /  sort=popular → 빈 본문
  const url =
    `${STDICT_API_URL}?key=${encodeURIComponent(key)}` +
    `&q=${encodeURIComponent(query)}&req_type=json&num=10&sort=dict`;

  let raw;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    raw = await upstream.text();
  } catch (e) {
    return res.status(502).json({ error: '사전 서비스에 연결하지 못했습니다.' });
  }

  // 검색 결과가 없을 때도 오류가 아니라 빈 본문이 옵니다.
  if (!raw.trim()) {
    return res.status(404).json({ error: `'${query}'에 대한 검색 결과가 없습니다.` });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res.status(502).json({ error: '사전 서비스가 올바르지 않은 응답을 반환했습니다.' });
  }

  if (data.error) {
    return res.status(502).json({ error: '사전 서비스 오류가 발생했습니다.' });
  }

  const items = toArray(data.channel && data.channel.item);
  const definitions = [];
  for (const item of items) {
    for (const sense of toArray(item.sense)) {
      const definition = (sense.definition || '').trim();
      if (!definition) continue;
      const pos = (item.pos || sense.type || '').trim();
      definitions.push(pos ? `「${pos}」 ${definition}` : definition);
    }
  }

  if (definitions.length === 0) {
    return res.status(404).json({ error: `'${query}'에 대한 검색 결과가 없습니다.` });
  }

  // 사전 뜻풀이는 거의 바뀌지 않으므로 Vercel 엣지에 하루 캐시합니다.
  // 같은 단어를 여러 사람이 찾아도 국립국어원 서버는 한 번만 부릅니다.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');

  return res.status(200).json({
    word: cleanHeadword(items[0].word) || query,
    hanja: (items[0].origin || '').trim(),
    pronunciation: '', // 검색 API는 발음 정보를 제공하지 않습니다.
    definitions,
    source: 'stdict',
  });
};
