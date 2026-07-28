/**
 * 다듬 스튜디오 - 로컬 프록시 서버 (server.js)
 *
 * 브라우저(fetch)는 다음(Daum) 도메인으로 직접 요청할 수 없습니다 (CORS 차단).
 * 이 서버가 대신 요청을 보내고, 결과만 우리 프런트엔드가 쓰기 좋은 JSON으로
 * 정리해서 돌려주는 "프록시" 역할을 합니다.
 *
 * 실행 방법: node server.js  →  http://localhost:3787 접속
 * (외부 의존성 없이 Node.js 내장 모듈만 사용합니다. npm install 불필요)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// --------------------------------------------------------------------------
// .env 파일 읽기 (외부 패키지 dotenv 없이 최소 구현)
//   KEY=VALUE 형식의 줄만 읽고, #으로 시작하는 줄과 빈 줄은 무시합니다.
//   이미 시스템 환경변수로 설정된 값은 덮어쓰지 않습니다(배포 플랫폼 우선).
// --------------------------------------------------------------------------
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = process.env.PORT || 3787;
const ROOT = __dirname;
const STDICT_KEY = process.env.STDICT_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// ==========================================================================
// 1. 다음(Daum) 맞춤법 검사기 프록시
//    - 비공식 스크레이핑 방식입니다. Daum이 페이지 구조를 바꾸면 깨질 수 있습니다.
//    - 한 번에 1000자 제한이 있어 긴 글은 문단 단위로 잘라 순차 요청합니다.
// ==========================================================================

const DAUM_CHECK_URL = 'https://alldic.daum.net/grammar_checker.do';
const DAUM_CHUNK_LIMIT = 900; // Daum 실제 한도(1000자)보다 여유를 둠

function splitIntoChunks(text, limit) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      // 문장을 자르지 않도록 마지막 줄바꿈/마침표 지점을 찾아 자름
      const slice = text.slice(cursor, end);
      const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf('다.'));
      if (lastBreak > 0) end = cursor + lastBreak + 1;
    }
    chunks.push({ start: cursor, text: text.slice(cursor, end) });
    cursor = end;
  }
  return chunks;
}

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(str) {
  return decodeEntities(str.replace(/<[^>]+>/g, ''));
}

// Daum 응답 HTML에서 <a data-error-type=".." data-error-input=".." data-error-output=".." data-error-context="..">
// 블록들을 찾아내고, 각 블록 안의 도움말(<ul id="help">) 텍스트까지 함께 추출합니다.
function parseDaumResult(html) {
  const contSpellMatch = html.match(/class="cont_spell">([\s\S]*?)<\/div>\s*<\/div>\s*<span class="info_byte"/);
  const scope = contSpellMatch ? contSpellMatch[1] : html;

  const anchorRegex = /<a[^>]*data-error-type="([^"]*)"[^>]*data-error-input="([^"]*)"[^>]*data-error-output="([^"]*)"[^>]*data-error-context="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

  const results = [];
  let m;
  while ((m = anchorRegex.exec(scope)) !== null) {
    const [, type, input, output, context, innerBlock] = m;

    let reason = '';
    const helpMatch = innerBlock.match(/id="help">([\s\S]*?)<\/ul>/);
    if (helpMatch) {
      const liTexts = [...helpMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((li) => stripTags(li[1]).trim());
      reason = liTexts.join(' ');
    }

    results.push({
      type: decodeEntities(type),
      input: decodeEntities(input),
      output: decodeEntities(output),
      context: decodeEntities(context),
      reason: reason || `'${decodeEntities(input)}'을(를) '${decodeEntities(output)}'(으)로 교정하는 것이 바릅니다.`,
    });
  }
  return results;
}

function classifyType(daumType) {
  if (daumType.includes('space')) {
    return { category: 'red', categoryName: '띄어쓰기 오류' };
  }
  if (daumType.includes('standard') || daumType.includes('word')) {
    return { category: 'green', categoryName: '어휘 선택 오류' };
  }
  if (daumType.includes('spell')) {
    return { category: 'blue', categoryName: '맞춤법 오류' };
  }
  return { category: 'blue', categoryName: '맞춤법 오류' };
}

async function checkChunkWithDaum(text) {
  const body = new URLSearchParams({ sentence: text }).toString();
  const res = await fetch(DAUM_CHECK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DadeumStudio/1.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`Daum server responded ${res.status}`);
  const html = await res.text();
  return parseDaumResult(html);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSpellcheck(text) {
  const chunks = splitIntoChunks(text, DAUM_CHUNK_LIMIT).filter((c) => c.text.trim() !== '');
  const issues = [];
  let issueId = 1;
  let failedChunks = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let found = [];
    try {
      found = await checkChunkWithDaum(chunk.text);
    } catch (err) {
      // 한 조각이 실패해도(다음 서버 지연/일시 차단 등) 전체 검사를 포기하지 않고
      // 나머지 조각은 계속 검사합니다.
      failedChunks++;
      console.error('[spellcheck chunk failed]', err.message);
      continue;
    }

    let searchCursor = 0;
    for (const item of found) {
      if (!item.input || item.input === item.output) continue;
      const localIdx = chunk.text.indexOf(item.input, searchCursor);
      if (localIdx === -1) continue; // 원문 위치를 못 찾으면 안전하게 건너뜀
      const start = chunk.start + localIdx;
      const end = start + item.input.length;
      searchCursor = localIdx + item.input.length;

      const { category, categoryName } = classifyType(item.type);
      issues.push({
        id: `api-${issueId++}`,
        start,
        end,
        original: item.input,
        replacement: item.output,
        category,
        categoryName,
        reason: item.reason,
        ruleReference: '',
      });
    }

    if (i < chunks.length - 1) await sleep(150); // Daum 서버에 과도하게 연속 요청하지 않도록 살짝 대기
  }

  if (chunks.length > 0 && failedChunks === chunks.length) {
    throw new Error('모든 조각의 맞춤법 검사에 실패했습니다.');
  }

  return issues.sort((a, b) => a.start - b.start);
}

// ==========================================================================
// 2. 국립국어원 표준국어대사전 오픈 API — '국어사전' 기능에 사용
//    공식 무료 API입니다. 인증키 발급:
//      https://stdict.korean.go.kr/openapi/openApiInfo.do
//    발급받은 키를 .env 파일에 STDICT_KEY=... 형태로 넣어주세요.
//
//    (이전에는 다음(Daum) 사전 페이지를 스크레이핑했으나, 타사 콘텐츠
//     무단 수집은 이용약관 및 구글 애드센스 정책 위반이라 공식 API로
//     전면 교체했습니다.)
// ==========================================================================

const STDICT_API_URL = 'https://stdict.korean.go.kr/api/search.do';

// 표준국어대사전은 표제어에 어미 구분 기호를 포함합니다.
//   예: "먹-다", "가^보다", "사과01" → 화면에는 기호 없이 보여줍니다.
function cleanHeadword(word) {
  return String(word || '')
    .replace(/[-^]/g, '')
    .replace(/\d+$/, '')
    .trim();
}

// sense / item 은 결과가 1개일 때 배열이 아닌 객체로 오는 경우가 있어 정규화합니다.
function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function lookupDictionary(query) {
  if (!STDICT_KEY) {
    const err = new Error('국어사전 API 인증키(STDICT_KEY)가 설정되지 않았습니다.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const url =
    `${STDICT_API_URL}?key=${encodeURIComponent(STDICT_KEY)}` +
    `&q=${encodeURIComponent(query)}&req_type=json&num=10&sort=popular`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`표준국어대사전 API 응답 오류 (${res.status})`);

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 인증키가 잘못되면 JSON이 아닌 에러 문자열/XML이 돌아옵니다.
    throw new Error('표준국어대사전 API가 올바르지 않은 응답을 반환했습니다. 인증키를 확인하세요.');
  }

  if (data.error) {
    throw new Error(`표준국어대사전 API 오류: ${data.error.message || data.error.error_code}`);
  }

  const items = toArray(data.channel && data.channel.item);
  if (items.length === 0) return null;

  const word = cleanHeadword(items[0].word) || query;
  // origin 필드에 한자(어원)가 담겨 옵니다. 고유어에는 없습니다.
  const hanja = (items[0].origin || '').trim();

  const definitions = [];
  for (const item of items) {
    for (const sense of toArray(item.sense)) {
      const definition = (sense.definition || '').trim();
      if (!definition) continue;
      // 품사 정보가 있으면 앞에 붙여 "「명사」 뜻풀이" 형태로 보여줍니다.
      const pos = (item.pos || sense.type || '').trim();
      definitions.push(pos ? `「${pos}」 ${definition}` : definition);
    }
  }

  if (definitions.length === 0) return null;

  return {
    word,
    hanja,
    pronunciation: '', // 검색 API는 발음 정보를 제공하지 않습니다.
    definitions,
    source: 'stdict',
  };
}

// ==========================================================================
// 3. 정적 파일 서빙 + 라우팅
// ==========================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  // SEO / 애드센스에 필요한 파일들 (robots.txt, sitemap.xml, ads.txt)
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// --------------------------------------------------------------------------
// 간이 요청 제한(rate limit)
//   외부에 공개하면 누군가 이 서버를 무료 API처럼 자동 호출할 수 있습니다.
//   그러면 외부 서비스에서 우리 서버 IP가 차단되므로 IP당 호출 수를 제한합니다.
// --------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 40; // IP당 1분에 40회
const MAX_TEXT_LENGTH = 50000; // 한 번에 검사 가능한 최대 글자 수
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_LIMIT_MAX;
}

// 오래된 기록을 주기적으로 비워 메모리가 계속 쌓이지 않도록 합니다.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function getClientIp(req) {
  // 배포 플랫폼(Render/Vercel 등)은 실제 방문자 IP를 이 헤더에 담아 전달합니다.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  // 청크(Buffer)를 곧바로 문자열로 이어붙이면(body += chunk) 한글 같은
  // 멀티바이트 UTF-8 문자가 청크 경계에서 잘려 깨질 수 있습니다.
  // (타이핑한 짧은 텍스트는 청크가 1개뿐이라 문제가 드러나지 않았지만,
  //  파일 업로드로 생기는 긴 텍스트는 여러 청크로 나뉘며 실제로 깨졌습니다.)
  // 모든 청크를 Buffer 그대로 모았다가 마지막에 한 번에 디코딩합니다.
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      if (totalLength > 10 * 1024 * 1024) req.destroy(); // 10MB 안전장치
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(path.join(ROOT, filePath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('찾을 수 없는 파일입니다.');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsedUrl;

  // ALLOWED_ORIGIN을 설정하면 그 도메인에서 온 요청만 허용합니다(무단 사용 방지).
  // 비워두면 로컬 개발 편의를 위해 모든 출처를 허용합니다.
  // (file:// 로 직접 열면 브라우저가 Origin을 "null"로 보냅니다.)
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const isApiRequest = pathname.startsWith('/api/');
  if (isApiRequest && isRateLimited(getClientIp(req))) {
    return sendJSON(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }

  try {
    if (pathname === '/api/spellcheck' && req.method === 'POST') {
      const raw = await readRequestBody(req);
      const { text } = JSON.parse(raw || '{}');
      if (!text || typeof text !== 'string') return sendJSON(res, 400, { error: '검사할 텍스트가 없습니다.' });
      if (text.length > MAX_TEXT_LENGTH) {
        return sendJSON(res, 413, {
          error: `한 번에 검사할 수 있는 글자 수는 ${MAX_TEXT_LENGTH.toLocaleString()}자까지입니다.`,
        });
      }
      const issues = await runSpellcheck(text);
      return sendJSON(res, 200, { issues, source: 'daum' });
    }

    if (pathname === '/api/dictionary' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q');
      if (!q) return sendJSON(res, 400, { error: '검색어가 없습니다.' });
      const result = await lookupDictionary(q);
      if (!result) return sendJSON(res, 404, { error: `'${q}'에 대한 검색 결과가 없습니다.` });
      return sendJSON(res, 200, result);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err.code === 'NO_API_KEY') {
      console.error('[국어사전] STDICT_KEY가 없어 사전 검색을 처리할 수 없습니다.');
      return sendJSON(res, 503, {
        error: '국어사전 기능이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.',
      });
    }
    console.error('[server error]', err.message);
    return sendJSON(res, 502, { error: '사전/맞춤법 서비스 요청에 실패했습니다.', detail: err.message });
  }
});

// 배포 플랫폼(Render, Railway, Fly 등)은 컨테이너 외부에서 접속하므로
// 모든 네트워크 인터페이스에 바인딩해야 합니다. 특정 인터페이스만 열면
// 헬스체크가 실패해 배포가 무한 대기 상태가 됩니다.
//
// 기본값 '::' 는 IPv6 와 IPv4 를 모두 받는 듀얼 스택 바인딩입니다.
// ('0.0.0.0' 으로 고정하면 Windows처럼 localhost가 ::1로 먼저 해석되는
//  환경에서 로컬 접속이 실패할 수 있어 기본값으로 쓰지 않습니다.
//  IPv4 전용 바인딩이 필요한 플랫폼에서는 HOST=0.0.0.0 으로 지정하세요.)
const HOST = process.env.HOST || '::';

server.listen(PORT, HOST, () => {
  console.log(`다듬 스튜디오 서버 실행 중: http://localhost:${PORT}`);
  console.log(
    STDICT_KEY
      ? '국어사전: 국립국어원 표준국어대사전 공식 API 연결됨 ✅'
      : '국어사전: ⚠️  STDICT_KEY 미설정 — .env 파일에 인증키를 넣어주세요.'
  );
  if (!ALLOWED_ORIGIN) {
    console.log('⚠️  ALLOWED_ORIGIN 미설정 — 모든 출처 허용 중입니다(배포 시 반드시 설정하세요).');
  }
});
