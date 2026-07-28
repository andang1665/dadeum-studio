/**
 * ==========================================================================
 * 다듬 스튜디오 (Dadeum Studio) 맞춤법 검사기 메인 컨트롤러 (app.js)
 * ==========================================================================
 */

document.addEventListener('DOMContentLoaded', () => {
  // Engines Initialization
  const checkerEngine = new DadeumCheckerEngine();
  const toneEngine = new DadeumToneEngine();

  // State Management
  let isRealtime = true;
  let customDictionary = JSON.parse(localStorage.getItem('dadeum_custom_dict') || '["다듬스튜디오", "다듬", "Dadeum"]');
  let currentIssues = [];
  let debounceTimer = null;

  // When an 어조 변환 has been applied, the converted text lives here and is
  // what the 교정 결과 panel shows / checks / exports — the 원문 textarea is
  // deliberately left untouched. null means "no conversion active", in which
  // case the result panel simply follows the 원문.
  let toneText = null;

  /** The text the 교정 결과 panel is currently working on. */
  function getTargetText() {
    return toneText !== null ? toneText : inputTextarea.value;
  }

  /** Write back to whichever source the result panel is working on. */
  function setTargetText(value) {
    if (toneText !== null) toneText = value;
    else {
      inputTextarea.value = value;
      // 교정을 적용해 원문이 바뀌었을 때도 저장본을 갱신합니다.
      scheduleDraftSave();
    }
  }

  /** Drop any active tone conversion (called whenever the 원문 changes). */
  function clearToneConversion() {
    toneText = null;
    toneNotice.style.display = 'none';
  }

  // DOM Elements
  const inputTextarea = document.getElementById('inputTextarea');
  const inputHighlightLayer = document.getElementById('inputHighlightLayer');
  const btnRunCheck = document.getElementById('btnRunCheck');
  const btnClearText = document.getElementById('btnClearText');
  const btnCopyOriginal = document.getElementById('btnCopyOriginal');
  const btnCopyResult = document.getElementById('btnCopyResult');
  const btnApplyAll = document.getElementById('btnApplyAll');
  const btnExportFile = document.getElementById('btnExportFile');
  const fileUploadInput = document.getElementById('fileUploadInput');

  const charCountWithSpace = document.getElementById('charCountWithSpace');
  const charCountNoSpace = document.getElementById('charCountNoSpace');
  const wordCount = document.getElementById('wordCount');
  const readTime = document.getElementById('readTime');

  const outputContainer = document.getElementById('outputContainer');
  const renderedTextContainer = document.getElementById('renderedTextContainer');
  const cardsListContainer = document.getElementById('cardsListContainer');
  const emptyStateContainer = document.getElementById('emptyStateContainer');
  const summaryChipsContainer = document.getElementById('summaryChipsContainer');
  const toneNotice = document.getElementById('toneNotice');
  const toneNoticeText = document.getElementById('toneNoticeText');
  const btnResetTone = document.getElementById('btnResetTone');

  // Mode & Tone Controls
  const modeRealtimeBtn = document.getElementById('modeRealtimeBtn');
  const modeManualBtn = document.getElementById('modeManualBtn');
  const toneSelect = document.getElementById('toneSelect');
  const themeToggle = document.getElementById('themeToggle');

  // Modal Elements
  const btnCustomDict = document.getElementById('btnCustomDict');
  const dictModal = document.getElementById('dictModal');
  const dictModalClose = document.getElementById('dictModalClose');
  const dictInput = document.getElementById('dictInput');
  const btnAddDict = document.getElementById('btnAddDict');
  const dictTagsContainer = document.getElementById('dictTagsContainer');

  // Korean Dictionary (국어사전) Elements
  const engineStatus = document.getElementById('engineStatus');
  const btnKoDict = document.getElementById('btnKoDict');
  const koDictModal = document.getElementById('koDictModal');
  const koDictModalClose = document.getElementById('koDictModalClose');
  const koDictInput = document.getElementById('koDictInput');
  const btnKoDictSearch = document.getElementById('btnKoDictSearch');
  const koDictResult = document.getElementById('koDictResult');

  // API Engine State
  // When the page is opened straight from the folder (file:// protocol) there
  // is no origin to resolve "/api/..." against, so we point at the local
  // server explicitly. server.js sends CORS headers so this works too.
  const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3787' : '';

  const isLocal =
    window.location.protocol === 'file:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  // 국어사전 주소.
  //
  // 배포 환경(Vercel)과 로컬(server.js) 모두 같은 경로로 사전을 제공하므로
  // 주소가 하나로 통일됩니다. 사이트와 같은 도메인이라 CORS 문제도 없습니다.
  // (인증키는 서버 쪽 환경 변수에만 있고 브라우저로 내려오지 않습니다.)
  const DICT_API = `${API_BASE}/api/dictionary`;

  // 맞춤법 검사는 브라우저의 규칙 엔진(checker-engine.js)이 담당합니다.
  // 로컬에서만 server.js의 외부 검사 API를 추가로 시도합니다. 배포 환경에는
  // 그 API가 없으므로, 매번 404를 받으러 가지 않도록 아예 건너뜁니다.
  const SPELLCHECK_API_ENABLED = isLocal;

  // 맞춤법 규칙은 한글 단어 경계를 잡기 위해 후방 탐색 (?<!…) 을 씁니다.
  // 이 문법은 iOS 16.3 이하 사파리에서 지원되지 않아, 그런 기기에서는
  // 규칙을 만드는 순간 예외가 나고 검사기가 통째로 죽습니다.
  // 아무 설명 없이 "먹통"이 되는 것이 가장 나쁘므로, 지원 여부를 미리 확인해
  // 사용자에게 이유를 알려 줍니다.
  const supportsLookbehind = (() => {
    try {
      new RegExp('(?<!가)나');
      return true;
    } catch (e) {
      return false;
    }
  })();

  if (!supportsLookbehind) {
    const banner = document.getElementById('setupBanner');
    if (banner) {
      const title = document.getElementById('setupBannerTitle');
      const text = document.getElementById('setupBannerText');
      if (title) title.textContent = '이 브라우저에서는 맞춤법 검사를 실행할 수 없습니다.';
      if (text) {
        text.textContent =
          ' 사용 중인 브라우저가 오래되어 검사 기능이 동작하지 않습니다. ' +
          'iOS는 16.4 이상으로 업데이트하시거나, 크롬 등 최신 브라우저로 열어 주세요.';
      }
      banner.style.display = 'flex';
    }
  }

  let apiEngineAvailable = false;
  checkApiAvailability();

  // ==========================================
  // 자동 저장 (LocalStorage)
  //
  // 실수로 새로고침하거나 창을 닫아도 쓰던 글이 날아가지 않도록, 입력한 글을
  // 이 브라우저에만 보관합니다. 서버로 보내지 않으므로 글 내용은 다른 곳으로
  // 나가지 않습니다.
  //
  // 저장은 타자를 멈춘 뒤에 합니다. 글자 하나마다 저장하면 긴 글에서
  // 입력이 버벅입니다.
  // ==========================================
  const DRAFT_KEY = 'dadeum_draft';
  const DRAFT_SAVED_AT_KEY = 'dadeum_draft_saved_at';
  let draftTimer = null;

  function saveDraft() {
    try {
      const text = inputTextarea.value;
      if (!text) {
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(DRAFT_SAVED_AT_KEY);
        return;
      }
      localStorage.setItem(DRAFT_KEY, text);
      localStorage.setItem(DRAFT_SAVED_AT_KEY, String(Date.now()));
    } catch (e) {
      // 시크릿 모드이거나 저장 공간이 가득 찬 경우입니다. 자동 저장은
      // 부가 기능이므로, 실패해도 검사기 본체는 그대로 동작해야 합니다.
    }
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 800);
  }

  function clearDraft() {
    clearTimeout(draftTimer);
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_SAVED_AT_KEY);
    } catch (e) {
      /* 위와 같은 이유로 무시합니다. */
    }
  }

  /** 저장 시각을 '방금 전', '3분 전'처럼 읽기 쉽게 바꿉니다. */
  function formatSavedAgo(timestamp) {
    const diffMin = Math.floor((Date.now() - timestamp) / 60000);
    if (diffMin < 1) return '방금 전';
    if (diffMin < 60) return `${diffMin}분 전`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}시간 전`;
    return `${Math.floor(diffHour / 24)}일 전`;
  }

  /**
   * 저장해 둔 글을 되살립니다.
   *
   * 사용자가 모르는 사이에 글이 나타나면 당황스러우므로, 복구했다는 사실과
   * 되돌리는 방법(작성 취소)을 함께 알려 줍니다.
   */
  function restoreDraft() {
    let saved = null;
    let savedAt = null;
    try {
      saved = localStorage.getItem(DRAFT_KEY);
      savedAt = Number(localStorage.getItem(DRAFT_SAVED_AT_KEY)) || null;
    } catch (e) {
      return;
    }
    if (!saved) return;

    inputTextarea.value = saved;

    const banner = document.getElementById('setupBanner');
    if (!banner || !supportsLookbehind) return;

    const title = document.getElementById('setupBannerTitle');
    const text = document.getElementById('setupBannerText');
    if (title) title.textContent = '작성 중이던 글을 불러왔습니다.';
    if (text) {
      text.textContent =
        (savedAt ? ` ${formatSavedAgo(savedAt)}에 ` : ' 이전에 ') +
        '자동 저장된 내용입니다. 새로 쓰시려면 "지우기" 버튼을 눌러 주세요.';
    }
    banner.style.display = 'flex';
  }

  // 처음에는 빈 작업 공간으로 시작하고, 저장해 둔 글이 있으면 되살립니다.
  inputTextarea.value = '';
  restoreDraft();

  // 타자를 멈추길 기다리지 않고 즉시 저장해야 하는 순간들입니다.
  // (탭을 닫거나, 다른 앱으로 전환하거나, 휴대폰에서 화면을 끌 때)
  window.addEventListener('beforeunload', saveDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
  });

  // Initial Run
  updateStats();
  renderInputOverlay('', []);
  runSpellingCheck();
  renderCustomDictTags();

  // Keep the (invisible-text) textarea and its colored highlight layer
  // scrolling together, since the highlight layer sits directly behind it.
  inputTextarea.addEventListener('scroll', () => {
    inputHighlightLayer.scrollTop = inputTextarea.scrollTop;
    inputHighlightLayer.scrollLeft = inputTextarea.scrollLeft;
  });

  // ==========================================
  // Real Spellcheck API (Daum, via local proxy server.js)
  // ==========================================

  async function checkApiAvailability() {
    if (!SPELLCHECK_API_ENABLED) {
      apiEngineAvailable = false;
      updateEngineStatusUI();
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/spellcheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '테스트' }),
      });
      apiEngineAvailable = res.ok;
    } catch (e) {
      apiEngineAvailable = false;
    }
    updateEngineStatusUI();
  }

  function updateEngineStatusUI() {
    if (!engineStatus) return;

    // 배포된 사이트에서는 규칙 엔진이 정상 동작하는 상태이므로 "서버 미실행"
    // 같은 개발용 경고를 띄우면 안 됩니다. 그건 로컬에서만 의미가 있습니다.
    if (!SPELLCHECK_API_ENABLED) {
      engineStatus.textContent = '🟢 규칙 기반 검사';
      engineStatus.title =
        '한글 맞춤법 규정에 근거한 내장 규칙으로 검사합니다. 왜 틀렸는지 근거 조항까지 보여 줍니다.';
      updateSetupBanner();
      return;
    }

    engineStatus.textContent = apiEngineAvailable ? '🟢 정밀 API 검사 연결됨' : '⚪ 로컬 규칙 검사 (서버 미실행)';
    engineStatus.title = apiEngineAvailable
      ? '맞춤법 검사 API에 연결되었습니다.'
      : '검사 서버가 실행되지 않아 내장 규칙 엔진으로만 검사합니다. 폴더의 "다듬스튜디오 실행.bat"을 실행하세요.';
    updateSetupBanner();
  }

  /**
   * 서버에 연결되지 않았을 때 원인과 해결 방법을 배너로 안내합니다.
   * 원인이 두 가지라 문구를 나눕니다.
   *   1) 파일을 직접 열었다 (file://)  → 실행 방법 자체가 잘못됨
   *   2) 서버로 열었는데 API가 죽었다   → 서버는 떴지만 외부 연동에 문제
   */
  function updateSetupBanner() {
    const banner = document.getElementById('setupBanner');
    if (!banner) return;

    // 배포 환경에는 안내할 "실행 방법"이 없습니다. 이 배너는 사용자가 폴더에서
    // index.html을 직접 열었을 때를 위한 것이라 로컬에서만 띄웁니다.
    if (!SPELLCHECK_API_ENABLED || apiEngineAvailable || banner.dataset.dismissed === 'true') {
      banner.style.display = 'none';
      return;
    }

    const title = document.getElementById('setupBannerTitle');
    const text = document.getElementById('setupBannerText');

    if (window.location.protocol === 'file:') {
      title.textContent = '검사 서버에 연결되지 않았습니다.';
      text.textContent =
        ' index.html 파일을 직접 열면 정밀 검사와 국어사전을 쓸 수 없습니다. ' +
        '이 창을 닫고, 같은 폴더의 "다듬스튜디오 실행.bat"을 더블클릭해 주세요. ' +
        '(지금은 내장 규칙 검사만 동작합니다)';
    } else {
      title.textContent = '정밀 검사 서버에 연결되지 않았습니다.';
      text.textContent =
        ' 현재는 내장 규칙 검사만 동작합니다. 잠시 후 새로고침하면 다시 연결될 수 있습니다.';
    }

    banner.style.display = 'flex';
  }

  const setupBannerClose = document.getElementById('setupBannerClose');
  if (setupBannerClose) {
    setupBannerClose.addEventListener('click', () => {
      const banner = document.getElementById('setupBanner');
      banner.dataset.dismissed = 'true';
      banner.style.display = 'none';
    });
  }

  async function checkViaApi(text) {
    if (!SPELLCHECK_API_ENABLED) throw new Error('로컬 규칙 엔진을 사용합니다.');
    const res = await fetch(`${API_BASE}/api/spellcheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    const data = await res.json();

    // Apply the user's custom exclusion dictionary to API results too
    return (data.issues || []).filter((issue) => {
      return !customDictionary.some((w) => issue.original.includes(w) || w.includes(issue.original));
    });
  }

  // ==========================================
  // Event Listeners
  // ==========================================

  // While typing: mirror the text into both panels immediately, then (in
  // 실시간 검사 mode) re-run the check shortly after typing pauses so the
  // 교정 결과 panel updates on its own. Corrections are only ever *shown*
  // automatically — never applied — so nothing is silently rewritten.
  inputTextarea.addEventListener('input', () => {
    updateStats();
    scheduleDraftSave();
    currentIssues = [];
    // Editing the 원문 invalidates any active tone conversion.
    clearToneConversion();
    renderInputOverlay(inputTextarea.value, []);
    renderResultMirror(inputTextarea.value);

    if (isRealtime) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runSpellingCheck();
      }, 700);
    }
  });

  // NOTE: clicking a flagged word to correct it is wired up per-element in
  // renderInputOverlay() — the marked spans in the highlight layer are the
  // only clickable targets, so clicking blank space never triggers a fix.

  // Manual Check Button
  btnRunCheck.addEventListener('click', async () => {
    await runSpellingCheck();
    showToast(apiEngineAvailable ? '정밀 API 검사가 완료되었습니다.' : '로컬 검사가 완료되었습니다.');
  });

  // Mode Toggle — 실시간 검사 re-checks automatically as you type;
  // 수동 검사 only checks when the 검사하기 button is pressed.
  modeRealtimeBtn.addEventListener('click', async () => {
    isRealtime = true;
    modeRealtimeBtn.classList.add('active');
    modeManualBtn.classList.remove('active');
    await runSpellingCheck();
    showToast('실시간 검사 모드가 활성화되었습니다.');
  });

  modeManualBtn.addEventListener('click', () => {
    isRealtime = false;
    clearTimeout(debounceTimer);
    modeManualBtn.classList.add('active');
    modeRealtimeBtn.classList.remove('active');
    showToast('수동 검사 모드로 변경되었습니다.');
  });

  // Tone Polish Convert
  const TONE_LABELS = { formal: '격식체(합쇼체)', polite: '친근체(해요체)', report: '보고서체(개조식)' };

  toneSelect.addEventListener('change', async () => {
    const selectedTone = toneSelect.value;
    toneSelect.value = 'none';
    if (selectedTone === 'none') return;

    const currentText = inputTextarea.value;
    if (!currentText.trim()) {
      showToast('먼저 변환할 문장을 입력해 주세요.');
      return;
    }

    const convertedText = toneEngine.convert(currentText, selectedTone);
    if (convertedText === currentText) {
      showToast(`이미 ${TONE_LABELS[selectedTone]}이거나 변환할 종결 어미를 찾지 못했습니다.`);
      return;
    }

    // The 원문 is left exactly as the user wrote it — only the 교정 결과
    // panel switches over to the converted text.
    toneText = convertedText;
    toneNoticeText.textContent = `✨ ${TONE_LABELS[selectedTone]}로 변환된 결과입니다. (원문은 그대로 유지됩니다)`;
    toneNotice.style.display = 'flex';

    await runSpellingCheck();
    showToast(`${TONE_LABELS[selectedTone]}로 변환했습니다.`);
  });

  // Discard the tone conversion and go back to following the 원문.
  btnResetTone.addEventListener('click', async () => {
    clearToneConversion();
    await runSpellingCheck();
    showToast('원문 기준으로 되돌렸습니다.');
  });

  // Clear Text Button
  btnClearText.addEventListener('click', () => {
    inputTextarea.value = '';
    // "지우기"는 사용자가 명시적으로 비운 것이므로 저장본도 함께 지웁니다.
    // 남겨 두면 새로고침했을 때 지운 글이 되살아나 버립니다.
    clearDraft();
    clearToneConversion();
    updateStats();
    runSpellingCheck();
    const banner = document.getElementById('setupBanner');
    if (banner) banner.style.display = 'none';
  });

  // Copy Original Text
  btnCopyOriginal.addEventListener('click', () => {
    navigator.clipboard.writeText(inputTextarea.value);
    showToast('원문 텍스트가 클립보드에 복사되었습니다.');
  });

  // Copy Corrected Text
  btnCopyResult.addEventListener('click', () => {
    const correctedText = getFullCorrectedText();
    navigator.clipboard.writeText(correctedText);
    showToast('교정 완료본이 클립보드에 복사되었습니다.');
  });

  // Apply All Corrections
  btnApplyAll.addEventListener('click', async () => {
    if (currentIssues.length === 0) return;
    const count = currentIssues.length;
    applyAllFixes(currentIssues);
    updateStats();
    await runSpellingCheck();
    showToast(`${count}건의 전체 교정이 적용되었습니다.`);
  });

  // File Export (.txt)
  btnExportFile.addEventListener('click', () => {
    const content = getFullCorrectedText();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `다듬스튜디오_교정본_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('교정본 문서 파일이 다운로드되었습니다.');
  });

  // File Upload (.txt / .pdf / .docx)
  fileUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();

    try {
      let text = '';

      if (ext === 'txt') {
        text = await readTextFileWithEncodingFallback(file);
      } else if (ext === 'pdf') {
        text = await extractTextFromPdf(file);
      } else if (ext === 'docx') {
        text = await extractTextFromDocx(file);
      } else {
        showToast('지원하지 않는 파일 형식입니다. (.txt, .pdf, .docx만 가능)');
        fileUploadInput.value = '';
        return;
      }

      inputTextarea.value = text;
      // 불러온 파일 내용도 자동 저장 대상입니다. input 이벤트가 발생하지 않는
      // 경로라 여기서 직접 저장해 줘야 합니다.
      saveDraft();
      clearToneConversion();
      updateStats();
      await runSpellingCheck();
      showToast(`'${file.name}' 파일을 성공적으로 불러왔습니다.`);
    } catch (err) {
      console.error(err);
      showToast(`'${file.name}' 파일을 읽는 중 오류가 발생했습니다: ${err.message}`);
    } finally {
      fileUploadInput.value = ''; // allow re-uploading the same file
    }
  });

  // .txt 파일은 저장 프로그램에 따라 UTF-8이 아닌 EUC-KR(CP949, 옛 "ANSI")로
  // 저장된 경우가 많아 그대로 읽으면 한글이 깨집니다(예: "안녕" → "?쒕뀞").
  // UTF-8로 먼저 엄격 디코딩을 시도하고, 실패하면 EUC-KR로 재시도합니다.
  async function readTextFileWithEncodingFallback(file) {
    const buffer = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      return new TextDecoder('euc-kr').decode(buffer);
    }
  }

  async function extractTextFromPdf(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pageTexts = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(' ');
      pageTexts.push(pageText);
    }

    return pageTexts.join('\n\n');
  }

  async function extractTextFromDocx(file) {
    if (typeof mammoth === 'undefined') {
      throw new Error('DOCX 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
    }
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
  }

  // Theme Toggle
  themeToggle.addEventListener('click', () => {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', newTheme);
    themeToggle.textContent = newTheme === 'dark' ? '☀️' : '🌙';
  });

  // Custom Dictionary Modal Handlers
  btnCustomDict.addEventListener('click', () => {
    dictModal.classList.add('active');
  });

  dictModalClose.addEventListener('click', () => {
    dictModal.classList.remove('active');
  });

  dictModal.addEventListener('click', (e) => {
    if (e.target === dictModal) dictModal.classList.remove('active');
  });

  btnAddDict.addEventListener('click', addWordToCustomDict);
  dictInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWordToCustomDict();
  });

  // Korean Dictionary (국어사전) Modal Handlers
  btnKoDict.addEventListener('click', () => {
    koDictModal.classList.add('active');
    koDictInput.focus();
  });

  koDictModalClose.addEventListener('click', () => {
    koDictModal.classList.remove('active');
  });

  koDictModal.addEventListener('click', (e) => {
    if (e.target === koDictModal) koDictModal.classList.remove('active');
  });

  btnKoDictSearch.addEventListener('click', runKoDictSearch);
  koDictInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runKoDictSearch();
  });

  async function runKoDictSearch() {
    const query = koDictInput.value.trim();
    if (!query) return;

    koDictResult.innerHTML = `<div class="ko-dict-empty">'${escapeHTML(query)}' 검색 중...</div>`;

    try {
      const res = await fetch(`${DICT_API}?q=${encodeURIComponent(query)}`);
      if (res.status === 404) {
        koDictResult.innerHTML = `<div class="ko-dict-empty">'${escapeHTML(query)}'에 대한 검색 결과가 없습니다.</div>`;
        return;
      }
      if (!res.ok) {
        // 서버가 알려주는 구체적인 사유(인증키 미설정, 요청 과다 등)를 그대로 보여줍니다.
        const errData = await res.json().catch(() => null);
        const message = errData && errData.error ? errData.error : `서버 응답 오류 (${res.status})`;
        koDictResult.innerHTML = `<div class="ko-dict-empty">${escapeHTML(message)}</div>`;
        return;
      }

      const data = await res.json();
      renderKoDictResult(data);
    } catch (err) {
      koDictResult.innerHTML = `<div class="ko-dict-empty">국어사전 서버에 연결할 수 없습니다.<br>잠시 후 다시 시도해 주세요.</div>`;
    }
  }

  function renderKoDictResult(data) {
    const defsHTML = data.definitions
      .map((def, i) => `<li><span class="def-index">${i + 1}.</span><span>${escapeHTML(def)}</span></li>`)
      .join('');

    koDictResult.innerHTML = `
      <div class="ko-dict-entry">
        <div class="ko-dict-word-row">
          <span class="ko-dict-word">${escapeHTML(data.word)}</span>
          ${data.hanja ? `<span class="ko-dict-hanja">${escapeHTML(data.hanja)}</span>` : ''}
          ${data.pronunciation ? `<span class="ko-dict-pron">${escapeHTML(data.pronunciation)}</span>` : ''}
        </div>
        <ul class="ko-dict-defs">${defsHTML}</ul>
        <div class="ko-dict-source">출처: 국립국어원 표준국어대사전</div>
      </div>
    `;
  }

  // ==========================================
  // Core Checker & Render Functions
  // ==========================================

  async function runSpellingCheck() {
    // Checks (and the result panel) run on the tone-converted text when a
    // conversion is active, otherwise directly on the 원문.
    const text = getTargetText();

    if (!text.trim()) {
      emptyStateContainer.style.display = 'flex';
      renderedTextContainer.style.display = 'none';
      cardsListContainer.innerHTML = '';
      summaryChipsContainer.innerHTML = '';
      btnApplyAll.style.display = 'none';
      currentIssues = [];
      renderInputOverlay(inputTextarea.value, []);
      return;
    }

    // Prefer the real Daum spellcheck API (via server.js proxy); fall back to
    // the built-in regex rule engine if the server isn't running or the
    // request fails (e.g. offline, or the page was opened directly as a file).
    try {
      currentIssues = await checkViaApi(text);
      apiEngineAvailable = true;
    } catch (e) {
      apiEngineAvailable = false;
      currentIssues = checkerEngine.check(text, customDictionary);
    }
    updateEngineStatusUI();

    // Issue offsets refer to `text`. While a tone conversion is active that's
    // the converted text, not the 원문 — so the 원문 overlay gets no marks
    // (their positions wouldn't line up) and corrections are made from the
    // result panel instead.
    renderInputOverlay(inputTextarea.value, toneText !== null ? [] : currentIssues);

    if (currentIssues.length === 0) {
      cardsListContainer.innerHTML = '';
      summaryChipsContainer.innerHTML = '';
      btnApplyAll.style.display = 'none';

      // With a tone conversion active the panel must keep showing the
      // converted text — it's the whole point of the conversion — so only
      // fall back to the "no errors" placeholder when there's nothing to show.
      if (toneText !== null) {
        emptyStateContainer.style.display = 'none';
        renderedTextContainer.style.display = 'block';
        renderedTextContainer.textContent = text;
      } else {
        emptyStateContainer.style.display = 'flex';
        emptyStateContainer.querySelector('.empty-text').textContent = '🎉 맞춤법 및 띄어쓰기 오류가 탐지되지 않았습니다!';
        renderedTextContainer.style.display = 'none';
      }
      return;
    }

    // Display Output Container
    emptyStateContainer.style.display = 'none';
    renderedTextContainer.style.display = 'block';
    btnApplyAll.style.display = 'inline-flex';

    // Render Highlights, Cards & Summary
    renderSummaryChips(currentIssues);
    renderHighlightedText(text, currentIssues);
    renderCorrectionCards(currentIssues);
  }

  // Render Highlighted HTML
  function renderHighlightedText(fullText, issues) {
    let resultHTML = '';
    let lastIdx = 0;

    issues.forEach(issue => {
      // Append unformatted text up to issue start
      resultHTML += escapeHTML(fullText.substring(lastIdx, issue.start));
      // Append highlighted span
      resultHTML += `<span class="mark-error ${issue.category}" data-id="${issue.id}" title="${escapeHTML(issue.reason)}">${escapeHTML(issue.original)}</span>`;
      lastIdx = issue.end;
    });

    resultHTML += escapeHTML(fullText.substring(lastIdx));
    renderedTextContainer.innerHTML = resultHTML;

    // Add Click Listener to Highlights to scroll to card
    renderedTextContainer.querySelectorAll('.mark-error').forEach(span => {
      span.addEventListener('click', () => {
        const id = span.getAttribute('data-id');
        const cardElem = document.getElementById(`card-${id}`);
        if (cardElem) {
          cardElem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          cardElem.style.borderColor = 'var(--brand-accent)';
          setTimeout(() => cardElem.style.borderColor = '', 1500);
        }
      });
    });
  }

  // Render the left-side "원문 입력" overlay: mirrors the textarea's plain
  // text (since the textarea itself is drawn with transparent text) and
  // underlines flagged words (colored underline + a small correction hint
  // floating just above, via a plain span rather than <ruby> so the
  // annotation never widens the line and desyncs it from the textarea's
  // own line-wrapping). Already-applied fixes are rendered the same way,
  // but with the hint showing the ORIGINAL word (i.e. what re-clicking will
  // restore).
  // NOTE: spacing issues (category 'red') are shown in BLUE, spelling issues
  // (category 'blue') are shown in RED — colors are intentionally swapped,
  // see the --error-red/--error-blue variable comment in index.css.
  function renderInputOverlay(fullText, issues) {
    const allMarks = issues
      .map((i) => ({ start: i.start, end: i.end, category: i.category, hint: i.replacement }))
      .sort((a, b) => a.start - b.start);

    // Only the marks actually rendered (overlaps dropped) — kept in the same
    // order as the DOM nodes so hint click handlers can be matched by index.
    const marks = [];
    let html = '';
    let lastIdx = 0;

    allMarks.forEach((m) => {
      if (m.start < lastIdx) return; // skip any accidental overlap
      html += escapeHTML(fullText.substring(lastIdx, m.start));
      html += `<span class="input-mark cat-${m.category}">${escapeHTML(fullText.substring(m.start, m.end))}<span class="hint">${escapeHTML(m.hint)}</span></span>`;
      lastIdx = m.end;
      marks.push(m);
    });

    html += escapeHTML(fullText.substring(lastIdx));
    // Trailing newline(s) need a placeholder so the layer's height keeps
    // matching the textarea when the last line is empty.
    inputHighlightLayer.innerHTML = html + '&nbsp;';

    // Only these marked spans (the flagged word itself and its floating hint)
    // are clickable — the surrounding layer is pointer-events:none, so blank
    // space and normal text never trigger a correction.
    inputHighlightLayer.querySelectorAll('.input-mark').forEach((markEl, i) => {
      const mark = marks[i];
      markEl.title = '클릭하면 이 교정을 적용합니다';
      markEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const issue = currentIssues.find((is) => is.start === mark.start && is.end === mark.end);
        if (issue) applyFix(issue);
      });
    });
  }

  // Mirror the raw (unchecked) text into the 교정 결과 panel while typing, so
  // the right-hand side always reflects the current document even before a
  // check has been run.
  function renderResultMirror(text) {
    summaryChipsContainer.innerHTML = '';
    cardsListContainer.innerHTML = '';
    btnApplyAll.style.display = 'none';

    if (!text.trim()) {
      emptyStateContainer.style.display = 'flex';
      emptyStateContainer.querySelector('.empty-text').textContent =
        '왼쪽에 문장을 입력하면 검사 결과가 여기에 표시됩니다.';
      renderedTextContainer.style.display = 'none';
      return;
    }

    emptyStateContainer.style.display = 'none';
    renderedTextContainer.style.display = 'block';
    renderedTextContainer.textContent = text;
  }

  // Render Summary Chips
  // NOTE: the circle emoji colors are swapped to match the (also swapped)
  // underline colors: spacing (red category) = blue circle, spelling (blue
  // category) = red circle.
  function renderSummaryChips(issues) {
    const counts = { red: 0, blue: 0, green: 0, purple: 0 };
    issues.forEach(i => counts[i.category] = (counts[i.category] || 0) + 1);

    summaryChipsContainer.innerHTML = `
      <span class="summary-chip red">🔵 띄어쓰기 ${counts.red}건</span>
      <span class="summary-chip blue">🔴 맞춤법 ${counts.blue}건</span>
      <span class="summary-chip green">🟢 어휘 ${counts.green}건</span>
      <span class="summary-chip purple">🟣 다듬은 표현 ${counts.purple}건</span>
    `;
  }

  // Render Correction Cards
  function renderCorrectionCards(issues) {
    cardsListContainer.innerHTML = '';

    issues.forEach(issue => {
      const card = document.createElement('div');
      card.className = `correction-card ${issue.category}`;
      card.id = `card-${issue.id}`;

      card.innerHTML = `
        <div class="card-top-info">
          <span class="error-tag ${issue.category}">${issue.categoryName}</span>
          ${issue.ruleReference ? `<span style="font-size:0.75rem; color:var(--text-subtle); font-weight:600;">${escapeHTML(issue.ruleReference)}</span>` : ''}
        </div>
        <div class="comparison-box">
          <span class="original-word">${escapeHTML(issue.original)}</span>
          <span class="arrow-icon">➔</span>
          <span class="suggested-word">${escapeHTML(issue.replacement)}</span>
        </div>
        <div class="card-explanation">${escapeHTML(issue.reason)}</div>
        <div class="card-actions">
          <button class="btn-ignore" data-action="exclude" data-word="${escapeHTML(issue.original)}">사전에 추가</button>
          <button class="btn-apply" data-action="apply" data-id="${issue.id}">수정 적용</button>
        </div>
      `;

      // Event delegation inside card
      card.querySelector('[data-action="apply"]').addEventListener('click', () => {
        applyFix(issue);
      });

      card.querySelector('[data-action="exclude"]').addEventListener('click', () => {
        addToCustomDict(issue.original);
      });

      cardsListContainer.appendChild(card);
    });
  }

  // Apply one correction (click on a flagged word/hint, or the "수정 적용"
  // button). Corrections are permanent — the text is simply rewritten.
  async function applyFix(issue) {
    const text = getTargetText();
    setTargetText(text.substring(0, issue.start) + issue.replacement + text.substring(issue.end));

    updateStats();
    await runSpellingCheck();
    showToast(`'${issue.original}' ➔ '${issue.replacement}' 교정을 적용했습니다.`);
  }

  // Apply every current issue at once (전체 교정 적용).
  function applyAllFixes(issues) {
    const sorted = [...issues].sort((a, b) => a.start - b.start);
    let text = getTargetText();
    let offset = 0;

    sorted.forEach((issue) => {
      const start = issue.start + offset;
      const end = issue.end + offset;
      text = text.substring(0, start) + issue.replacement + text.substring(end);
      offset += issue.replacement.length - issue.original.length;
    });

    setTargetText(text);
  }

  // Get full text with all corrections applied
  function getFullCorrectedText() {
    if (currentIssues.length === 0) return getTargetText();

    let text = getTargetText();
    // Process issues in reverse order to preserve string indices
    const reversedIssues = [...currentIssues].sort((a, b) => b.start - a.start);
    reversedIssues.forEach(issue => {
      const before = text.substring(0, issue.start);
      const after = text.substring(issue.end);
      text = before + issue.replacement + after;
    });

    return text;
  }

  // Stats Calculator
  function updateStats() {
    const text = inputTextarea.value;
    const withSpace = text.length;
    const noSpace = text.replace(/\s/g, '').length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const estMin = Math.ceil(words / 200);

    charCountWithSpace.textContent = withSpace.toLocaleString();
    charCountNoSpace.textContent = noSpace.toLocaleString();
    wordCount.textContent = words.toLocaleString();
    readTime.textContent = `${estMin} 분`;
  }

  // Custom Dictionary Functions
  function renderCustomDictTags() {
    dictTagsContainer.innerHTML = '';
    customDictionary.forEach(word => {
      const tag = document.createElement('span');
      tag.className = 'dict-tag';
      tag.innerHTML = `${escapeHTML(word)} <span class="dict-remove" data-word="${escapeHTML(word)}">&times;</span>`;
      
      tag.querySelector('.dict-remove').addEventListener('click', () => {
        customDictionary = customDictionary.filter(w => w !== word);
        localStorage.setItem('dadeum_custom_dict', JSON.stringify(customDictionary));
        renderCustomDictTags();
        runSpellingCheck();
        showToast(`'${word}' 단어가 사전에서 제거되었습니다.`);
      });

      dictTagsContainer.appendChild(tag);
    });
  }

  function addWordToCustomDict() {
    const val = dictInput.value.trim();
    if (val) {
      addToCustomDict(val);
      dictInput.value = '';
    }
  }

  function addToCustomDict(word) {
    if (!customDictionary.includes(word)) {
      customDictionary.push(word);
      localStorage.setItem('dadeum_custom_dict', JSON.stringify(customDictionary));
      renderCustomDictTags();
      runSpellingCheck();
      showToast(`'${word}' 단어가 사용자 제외 사전에 추가되었습니다.`);
    }
  }

  // Toast System
  function showToast(message) {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 2800);
  }

  // Helper
  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
