/**
 * ==========================================================================
 * 다듬 스튜디오 — 국어사전 API 프록시 (Cloudflare Worker)
 * ==========================================================================
 *
 * 왜 이게 필요한가
 *   1) 국립국어원 API는 CORS 헤더를 보내지 않아 브라우저에서 직접 호출할 수
 *      없습니다. 중계할 서버가 반드시 필요합니다.
 *   2) 인증키를 브라우저 코드에 넣으면 누구나 훔쳐 쓸 수 있습니다.
 *      키는 이 Worker의 "Secret"에 보관되고 브라우저로 전달되지 않습니다.
 *   3) GitHub Pages는 정적 파일만 제공하므로 서버 코드를 돌릴 수 없습니다.
 *
 * 배포 방법 (브라우저만으로 가능, CLI 불필요)
 *   1. https://dash.cloudflare.com 가입 → Workers & Pages → Create → Worker
 *   2. 이름을 dadeum-dictionary 로 지정하고 Deploy
 *   3. Edit code → 이 파일 내용을 통째로 붙여넣고 Deploy
 *   4. Settings → Variables and Secrets → Add
 *        Type: Secret / Name: STDICT_KEY / Value: 발급받은 인증키
 *   5. Settings → Domains & Routes 에 표시된 주소를 복사
 *        예) https://dadeum-dictionary.<계정명>.workers.dev
 *
 * ⚠️ 인증키를 이 파일에 직접 적지 마세요. 저장소가 공개라 그대로 노출됩니다.
 *    반드시 4번의 Secret 으로 등록해야 합니다.
 */

// 이 Worker를 호출할 수 있는 사이트. 그 외 출처는 CORS로 차단됩니다.
const ALLOWED_ORIGINS = [
  'https://dadeum.ai.kr',
  'http://dadeum.ai.kr',
  'http://localhost:3787',
];

const STDICT_API_URL = 'https://stdict.korean.go.kr/api/search.do';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

/** 표제어의 어미 구분 기호를 제거합니다. 예: '사과-하다' → '사과하다' */
function cleanHeadword(word) {
  return String(word || '').replace(/[-^]/g, '').replace(/\d+$/, '').trim();
}

/** 결과가 1건이면 배열이 아닌 객체로 오므로 정규화합니다. */
function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ error: '지원하지 않는 방식입니다.' }, 405, origin);
    }

    const query = new URL(request.url).searchParams.get('q');
    if (!query || !query.trim()) {
      return json({ error: '검색어가 없습니다.' }, 400, origin);
    }
    if (query.length > 50) {
      return json({ error: '검색어가 너무 깁니다.' }, 400, origin);
    }

    if (!env.STDICT_KEY) {
      // 키를 Secret으로 등록하지 않은 경우입니다.
      return json({ error: '국어사전 기능이 아직 설정되지 않았습니다.' }, 503, origin);
    }

    // ⚠️ sort 는 'dict'(사전순)만 유효합니다. 'popular' 같은 값을 주면
    //    오류가 아니라 HTTP 200 + 빈 본문이 돌아와 원인을 찾기 어렵습니다.
    const url =
      `${STDICT_API_URL}?key=${encodeURIComponent(env.STDICT_KEY)}` +
      `&q=${encodeURIComponent(query)}&req_type=json&num=10&sort=dict`;

    let raw;
    try {
      const upstream = await fetch(url);
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      raw = await upstream.text();
    } catch (e) {
      return json({ error: '사전 서비스에 연결하지 못했습니다.' }, 502, origin);
    }

    // 검색 결과가 없으면 오류가 아니라 빈 본문이 옵니다.
    if (!raw.trim()) {
      return json({ error: `'${query}'에 대한 검색 결과가 없습니다.` }, 404, origin);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: '사전 서비스가 올바르지 않은 응답을 반환했습니다.' }, 502, origin);
    }

    if (data.error) {
      return json({ error: '사전 서비스 오류가 발생했습니다.' }, 502, origin);
    }

    const items = toArray(data.channel && data.channel.item);
    if (items.length === 0) {
      return json({ error: `'${query}'에 대한 검색 결과가 없습니다.` }, 404, origin);
    }

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
      return json({ error: `'${query}'에 대한 검색 결과가 없습니다.` }, 404, origin);
    }

    return json(
      {
        word: cleanHeadword(items[0].word) || query,
        hanja: (items[0].origin || '').trim(),
        pronunciation: '', // 검색 API는 발음 정보를 제공하지 않습니다.
        definitions,
        source: 'stdict',
      },
      200,
      origin
    );
  },
};
