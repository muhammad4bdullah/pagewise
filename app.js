/* Pagewise is a static, browser-first PDF reader. AI is optional and uses the reader's own Gemini key. */
(() => {
  'use strict';

  const DEFAULT_TEXT_MODEL = 'gemini-3.8-flash';
  const RETIRED_TEXT_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  const KNOWN_TEXT_MODELS = [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · current default' }
  ];
  const TTS_MODEL = 'gemini-3.8-flash-tts';
  const LIVE_MODEL = 'gemini-3.8-live';
  const CHAT_STORAGE_PREFIX = 'pagewise-chat-v1:';
  const MAX_SAVED_CHAT_MESSAGES = 80;
  const MAX_SAVED_CHAT_MESSAGE_LENGTH = 5000;
  const AI_PAGE_WINDOW_SIZE = 10;
  const AI_PAGE_CONTEXT_LIMIT = 35000;
  const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
  const LIVE_ROOT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const SYSTEM_INSTRUCTION = 'Your name is Zeemal. When greeting the student or introducing yourself, say exactly: “I’m Zeemal, very intelligent. How can I help you?” Do not repeat this introduction at the start of every reply. You are a warm, patient, encouraging teacher, not a strict examiner. Teach thoroughly and accurately, not as a brief summary. When asked to explain or teach a page, cover each important idea, term, step, and relationship on that page in a clear order; do not skip the difficult parts or reduce the page to a few sentences. Explain what each idea means and why it matters, and give concrete examples, comparisons, or everyday analogies that make it understandable. Distinguish what the PDF says from any example you add, and never invent facts or claim the page says something it does not. Adapt to the student’s questions and understanding. Check understanding gently, without turning every reply into a test. When the student says “continue” or asks to learn more, continue naturally from where you left off, covering material not yet explained without repeating the same explanation or abruptly ending the lesson. If a page is too dense to cover well in one reply, explain it in parts and clearly offer to continue with the next part. Answer only in English. Do not answer in Urdu or any other language, even if the student speaks or writes in another language; understand their question if possible and reply in English. The user may ask you to jump to a chapter, section, or page; use the PDF outline and current page context to help them.';
  const LIVE_USAGE_WINDOW_MS = 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const el = {
    fileInput: $('fileInput'), choosePdfBtn: $('choosePdfBtn'), heroChooseBtn: $('heroChooseBtn'), samplePdfBtn: $('samplePdfBtn'),
    emptyState: $('emptyState'), studyRoom: $('studyRoom'), bookTitle: $('bookTitle'),
    bookMeta: $('bookMeta'), topBookTitle: $('topBookTitle'), pageCountBadge: $('pageCountBadge'),
    outlineList: $('outlineList'), outlineCaption: $('outlineCaption'), chapterHeading: $('chapterHeading'),
    progressLine: $('progressLine'), progressBar: $('progressBar'), progressPercent: $('progressPercent'),
    pageLabel: $('pageLabel'), pageCounter: $('pageCounter'), pageText: $('pageText'),
    runningBookTitle: $('runningBookTitle'), runningPageNumber: $('runningPageNumber'),
    prevPageBtn: $('prevPageBtn'), nextPageBtn: $('nextPageBtn'), copyPageBtn: $('copyPageBtn'),
    teachPdfBtn: $('teachPdfBtn'), teachPdfLabel: $('teachPdfLabel'), chatStream: $('chatStream'),
    welcomeCard: $('welcomeCard'), chatForm: $('chatForm'), chatInput: $('chatInput'), sendBtn: $('sendBtn'),
    liveVoiceBtn: $('liveVoiceBtn'), liveVoiceLabel: $('liveVoiceLabel'), voiceHint: $('voiceHint'),
    teacherStatus: $('teacherStatus'), teacherDisclaimer: $('teacherDisclaimer'), clearChatBtn: $('clearChatBtn'),
    liveTokenUsage: $('liveTokenUsage'),
    settingsDialog: $('settingsDialog'), settingsBtn: $('settingsBtn'), topSettingsBtn: $('topSettingsBtn'),
    settingsInlineBtn: $('settingsInlineBtn'), apiKeyInput: $('apiKeyInput'), rememberKey: $('rememberKey'),
    testKeyBtn: $('testKeyBtn'), keyTestStatus: $('keyTestStatus'), fileModeNotice: $('fileModeNotice'),
    textModelSelect: $('textModelSelect'), checkModelsBtn: $('checkModelsBtn'), modelAccessStatus: $('modelAccessStatus'),
    voiceSelect: $('voiceSelect'), saveSettingsBtn: $('saveSettingsBtn'), removeKeyBtn: $('removeKeyBtn'),
    toggleKeyBtn: $('toggleKeyBtn'), toast: $('toast')
  };

  let pdfDoc = null;
  let pages = [];
  let sections = [];
  let pageImageCache = new Map();
  let currentPage = 1;
  let currentFileName = '';
  let currentChatStorageKey = '';
  let conversation = [];
  let isAutoTeaching = false;
  let autoTeachTask = null;
  let explainedPages = new Set();
  let toastTimer = 0;
  let currentAudio = null;
  let currentAudioUrl = '';
  let currentSpeakResolve = null;
  let liveSocket = null;
  let liveReady = false;
  let micStream = null;
  let micContext = null;
  let micProcessor = null;
  let micSilence = null;
  let liveAudioContext = null;
  let liveSources = new Set();
  let nextLivePlaybackAt = 0;
  let liveReplyText = '';
  let liveInputText = '';
  let liveAssistantBubble = null;
  let liveUserBubble = null;
  let liveStarting = false;
  let liveConnectTimer = 0;
  let liveUsageTimer = 0;
  let liveUsageReports = [];
  let hasLiveUsageData = false;
  let liveSessionTotalTokens = 0;

  function key() {
    return sessionStorage.getItem('pagewise-gemini-key') || localStorage.getItem('pagewise-gemini-key') || '';
  }
  function getVoice() { return localStorage.getItem('pagewise-voice') || 'Kore'; }
  function getTextModel() {
    const savedModel = localStorage.getItem('pagewise-text-model') || DEFAULT_TEXT_MODEL;
    if (RETIRED_TEXT_MODELS.has(savedModel)) {
      localStorage.setItem('pagewise-text-model', DEFAULT_TEXT_MODEL);
      return DEFAULT_TEXT_MODEL;
    }
    return savedModel;
  }
  function showToast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.toast.classList.remove('visible'), 3000);
  }
  function updateKeyState() {
    const connected = Boolean(key());
    el.teacherDisclaimer.hidden = connected;
    if (connected && !isLive()) el.teacherStatus.textContent = 'Ready to explore this page';
    el.voiceHint.textContent = connected ? 'Live voice · keep this tab open' : 'Live voice needs a free API key';
  }
  function isLive() { return Boolean(liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)); }
  function clearLiveUsage() {
    liveUsageReports = [];
    hasLiveUsageData = false;
    liveSessionTotalTokens = 0;
    if (el.liveTokenUsage) {
      el.liveTokenUsage.textContent = 'Live tokens/min: waiting · session total: waiting';
      el.liveTokenUsage.title = 'Waiting for Gemini to report token usage.';
    }
  }
  function recordLiveUsage(metadata) {
    if (!metadata || typeof metadata !== 'object') return;
    const prompt = Number(metadata.promptTokenCount ?? metadata.prompt_token_count) || 0;
    const response = Number(metadata.responseTokenCount ?? metadata.response_token_count) || 0;
    const total = Number(metadata.totalTokenCount ?? metadata.total_token_count) || prompt + response;
    if (!Number.isFinite(total) || total <= 0) return;
    const now = Date.now();
    liveUsageReports.push({ timestamp: now, tokens: total, prompt, response });
    liveSessionTotalTokens += total;
    hasLiveUsageData = true;
    refreshLiveUsage(now);
  }
  function refreshLiveUsage(now) {
    if (!el.liveTokenUsage) return;
    const cutoff = now - LIVE_USAGE_WINDOW_MS;
    liveUsageReports = liveUsageReports.filter((report) => report.timestamp > cutoff);
    if (!hasLiveUsageData) {
      el.liveTokenUsage.textContent = 'Live tokens/min: waiting · session total: waiting';
      el.liveTokenUsage.title = 'Waiting for Gemini to report token usage.';
      return;
    }
    const total = liveUsageReports.reduce((sum, report) => sum + report.tokens, 0);
    const prompt = liveUsageReports.reduce((sum, report) => sum + report.prompt, 0);
    const response = liveUsageReports.reduce((sum, report) => sum + report.response, 0);
    el.liveTokenUsage.textContent = 'Live tokens/min: ' + total.toLocaleString() + ' · session total: ' + liveSessionTotalTokens.toLocaleString();
    el.liveTokenUsage.title = 'Gemini-reported tokens in the rolling last 60 seconds and across this Live Voice session. Input in last minute: ' + prompt.toLocaleString() + ', output: ' + response.toLocaleString() + '. Values are based only on usage metadata received from Gemini; they are not a quota limit or prediction.';
  }
  function safeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  async function requestTextGeneration(apiKey, payload, consumeResponse, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 25000;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(API_ROOT + '/models/' + (opts.modelId || getTextModel()) + ':streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        throw parseApiError(await response.text(), response.status);
      }
      return await consumeResponse(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Gemini did not respond within ' + Math.ceil(timeoutMs / 1000) + ' seconds. Check your internet connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function openSettings() {
    const savedKey = key();
    el.apiKeyInput.value = savedKey;
    el.rememberKey.checked = Boolean(localStorage.getItem('pagewise-gemini-key'));
    const savedTextModel = getTextModel();
    if (!Array.from(el.textModelSelect.options).some((option) => option.value === savedTextModel)) {
      el.textModelSelect.add(new Option(savedTextModel + ' · saved selection', savedTextModel));
    }
    el.textModelSelect.value = savedTextModel;
    el.voiceSelect.value = getVoice();
    if (typeof el.settingsDialog.showModal === 'function') el.settingsDialog.showModal();
    else el.settingsDialog.setAttribute('open', '');
  }
  function saveSettings() {
    const apiKey = el.apiKeyInput.value.trim();
    sessionStorage.removeItem('pagewise-gemini-key');
    localStorage.removeItem('pagewise-gemini-key');
    if (apiKey) {
      (el.rememberKey.checked ? localStorage : sessionStorage).setItem('pagewise-gemini-key', apiKey);
    }
    localStorage.setItem('pagewise-text-model', el.textModelSelect.value || DEFAULT_TEXT_MODEL);
    localStorage.setItem('pagewise-voice', el.voiceSelect.value);
    el.settingsDialog.close();
    updateKeyState();
    showToast(apiKey ? 'Settings saved. Your key stays in this browser.' : 'Voice settings saved.');
  }
  function requireKey() {
    if (key()) return true;
    openSettings();
    showToast('Add your Gemini key to turn on the AI teacher.');
    return false;
  }

  function extractPageText(textContent) {
    const items = textContent.items || [];
    const lines = [];
    let lastY = null;
    for (const item of items) {
      const piece = (item.str || '').trim();
      if (!piece) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(lastY - y) > 3.5) lines.push('\n');
      else if (lines.length && lines[lines.length - 1] !== '\n') lines.push(' ');
      lines.push(piece);
      lastY = y;
    }
    return lines.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function loadPdf(file) {
    if (location.protocol === 'file:') {
      showToast('Run start-local.bat first, then open the browser page it launches.');
      return;
    }
    if (!file || file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Please choose a PDF file.');
      return;
    }
    if (!window.pdfjsLib) {
      showToast('PDF reader is still loading. Check your connection and try again.');
      return;
    }
    stopLesson();
    closeLive(false);
    el.bookTitle.textContent = 'Reading PDF…';
    el.bookMeta.textContent = 'Extracting pages';
    el.emptyState.hidden = true;
    el.studyRoom.hidden = false;
    el.pageText.textContent = 'Opening your PDF…';
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const buffer = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
      pdfDoc = await loadingTask.promise;
      pages = new Array(pdfDoc.numPages);
      pageImageCache.clear();
      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
        const page = await pdfDoc.getPage(pageNumber);
        const content = await page.getTextContent();
        pages[pageNumber - 1] = extractPageText(content);
      }
      currentFileName = file.name.replace(/\.pdf$/i, '');
      currentPage = 1;
      conversation = [];
      currentChatStorageKey = getChatStorageKey();
      explainedPages = new Set();
      renderBook();
      showToast('Your PDF is ready. It stays in this browser.');
    } catch (error) {
      console.error(error);
      pdfDoc = null;
      pages = [];
      el.emptyState.hidden = false;
      el.studyRoom.hidden = true;
      showToast('I could not read this PDF. Scanned image PDFs may need OCR.');
    }
  }

  async function readOutline() {
    const found = [];
    try {
      const outline = await pdfDoc.getOutline();
      async function add(items, depth) {
        for (const item of (items || [])) {
          let pageNumber = 1;
          try {
            let destination = item.dest;
            if (typeof destination === 'string') destination = await pdfDoc.getDestination(destination);
            if (destination && destination[0]) pageNumber = (await pdfDoc.getPageIndex(destination[0])) + 1;
          } catch (_) { /* A malformed bookmark does not prevent reading the file. */ }
          found.push({ title: safeText(item.title) || 'Untitled section', page: pageNumber, depth });
          if (item.items && item.items.length) await add(item.items, depth + 1);
        }
      }
      if (outline) await add(outline, 0);
    } catch (_) { /* Some PDFs have no embedded outline. */ }
    return found.filter((entry) => entry.page >= 1 && entry.page <= pages.length);
  }

  function inferSections() {
    const found = [];
    const headingPatterns = [
      /^\s*(chapter|section|part)\s+([ivxlcdm\d]+)\b\s*[:.\-–—]?\s*(.{0,90})$/i,
      /^\s*\d+(?:\.\d+){0,2}\s+[A-Z][\p{L}\d ,:;’'()&–—-]{4,72}$/u,
      /^\s*[A-Z][A-Z\d ,:;’'()&–—-]{8,65}$/
    ];
    pages.forEach((pageText, index) => {
      const lines = String(pageText || '').split('\n').map((line) => line.trim()).filter((line) => line.length >= 5 && line.length <= 110);
      const heading = lines.find((line) => headingPatterns.some((pattern) => pattern.test(line)));
      if (heading && !found.some((item) => item.page === index + 1 && item.title === heading)) {
        found.push({ title: heading.replace(/\s+/g, ' ').slice(0, 82), page: index + 1, depth: 0 });
      }
    });
    if (found.length) return found;
    const groupSize = pages.length > 40 ? 10 : pages.length > 12 ? 6 : 3;
    for (let page = 1; page <= pages.length; page += groupSize) {
      found.push({ title: 'Pages ' + page + '–' + Math.min(page + groupSize - 1, pages.length), page, depth: 0 });
    }
    return found;
  }

  function renderBook() {
    el.emptyState.hidden = true;
    el.studyRoom.hidden = false;
    el.bookTitle.textContent = currentFileName;
    el.bookMeta.textContent = pages.length + (pages.length === 1 ? ' page' : ' pages') + ' · ready to study';
    el.topBookTitle.textContent = currentFileName;
    el.runningBookTitle.textContent = currentFileName.toUpperCase().slice(0, 34);
    el.pageCountBadge.textContent = String(pages.length).padStart(2, '0');
    el.teacherStatus.textContent = pages.every((text) => !text) ? 'No selectable text found' : 'Ready to explore this page';
    renderOutline();
    renderPage();
    updateKeyState();
    restoreChatMemory();
  }

  function renderOutline() {
    el.outlineList.replaceChildren();
    const tocItems = sections.length ? sections : [];
    el.outlineCaption.textContent = tocItems.length + (tocItems.length === 1 ? ' section' : ' sections');
    if (!tocItems.length) {
      el.outlineList.innerHTML = '<div class="outline-empty">Page navigation will appear here.</div>';
      return;
    }
    tocItems.forEach((section, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item' + (section.depth ? ' sub-item' : '');
      button.dataset.sectionIndex = String(index);
      button.innerHTML = '<span class="outline-marker">' + String(section.page).padStart(2, '0') + '</span><span class="outline-title"></span>';
      button.querySelector('.outline-title').textContent = section.title;
      button.addEventListener('click', () => goToPage(section.page));
      el.outlineList.append(button);
    });
  }

  function activeSection() {
    let result = sections[0] || { title: 'Your PDF', page: 1 };
    for (const section of sections) if (section.page <= currentPage) result = section; else break;
    return result;
  }
  function renderPage() {
    if (!pages.length) return;
    const text = pages[currentPage - 1] || '';
    const section = activeSection();
    const percentage = Math.round(currentPage / pages.length * 100);
    el.chapterHeading.textContent = section.title;
    el.progressLine.textContent = 'Page ' + currentPage + ' of ' + pages.length + ' · ' + currentFileName;
    el.progressBar.style.width = percentage + '%';
    el.progressPercent.textContent = percentage + '%';
    el.pageLabel.textContent = 'PAGE ' + String(currentPage).padStart(2, '0');
    el.pageCounter.textContent = currentPage + ' / ' + pages.length;
    el.runningPageNumber.textContent = String(currentPage).padStart(2, '0');
    el.pageText.textContent = text || 'No selectable text was found on this page. It may be a scanned image. Try another page or use OCR before opening it.';
    el.pageText.classList.toggle('empty', !text);
    el.prevPageBtn.disabled = currentPage <= 1;
    el.nextPageBtn.disabled = currentPage >= pages.length;
    el.outlineList.querySelectorAll('.outline-item').forEach((button) => {
      const index = Number(button.dataset.sectionIndex);
      const section = sections[index];
      const next = sections[index + 1];
      const isActive = section && currentPage >= section.page && (!next || currentPage < next.page);
      button.classList.toggle('active', Boolean(isActive));
    });
  }

  function goToPage(pageNumber, updateLive) {
    if (!pages.length) return;
    const target = Math.max(1, Math.min(pages.length, Number(pageNumber) || 1));
    currentPage = target;
    renderPage();
    if (updateLive !== false && isLive() && liveReady) {
      sendLiveText('We are now on page ' + currentPage + ' of the PDF. Section: ' + activeSection().title + '. Here is the text of this page and the next pages for reference:\n' + getPagesContext(currentPage, Math.min(pages.length, currentPage + AI_PAGE_WINDOW_SIZE - 1), AI_PAGE_CONTEXT_LIMIT));
      sendLivePageImage(currentPage);
    }
  }

  function getPageContext(pageNumber, limit) {
    const index = pageNumber - 1;
    const parts = [];
    for (let offset = -1; offset <= 1; offset += 1) {
      const at = index + offset;
      if (at < 0 || at >= pages.length) continue;
      const text = String(pages[at] || '').slice(0, Math.ceil(limit / 2));
      if (text) parts.push('[Page ' + (at + 1) + (offset === 0 ? ', current' : '') + ']\n' + text);
    }
    return parts.join('\n\n').slice(0, limit);
  }

  function getPagesContext(startPage, endPage, limit) {
    const start = Math.max(1, Math.min(pages.length, Number(startPage) || currentPage));
    const end = Math.max(start, Math.min(pages.length, Number(endPage) || start));
    const pageCount = end - start + 1;
    const perPageLimit = Math.max(1, Math.floor((limit || AI_PAGE_CONTEXT_LIMIT) / pageCount));
    const parts = [];
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const text = String(pages[pageNumber - 1] || '').slice(0, perPageLimit);
      parts.push('[Page ' + pageNumber + (pageNumber === currentPage ? ', current' : '') + ']\n' + (text || '[No selectable text was extracted from this page.]'));
    }
    return parts.join('\n\n');
  }

  function getRequestedPageRange(question, fallbackPage) {
    const text = String(question || '');
    const rangeMatch = text.match(/\bpages?\s*(\d{1,5})\s*(?:-|–|—|to|through|thru)\s*(?:pages?\s*)?(\d{1,5})\b/i)
      || text.match(/\b(\d{1,5})\s*(?:-|–|—|to|through|thru)\s*(\d{1,5})\b/i);
    const pageMatch = text.match(/\bpage\s+(\d{1,5})\b/i);
    let start = fallbackPage || currentPage;
    let end = Math.min(pages.length, start + AI_PAGE_WINDOW_SIZE - 1);
    let explicit = false;
    if (rangeMatch) {
      const first = Number(rangeMatch[1]);
      const last = Number(rangeMatch[2]);
      if (first >= 1 && last >= first && first <= pages.length) {
        start = first;
        end = Math.min(last, first + AI_PAGE_WINDOW_SIZE - 1, pages.length);
        explicit = true;
      }
    } else if (pageMatch) {
      const requested = Number(pageMatch[1]);
      if (requested >= 1 && requested <= pages.length) {
        start = requested;
        end = Math.min(pages.length, start + AI_PAGE_WINDOW_SIZE - 1);
      }
    }
    return { start, end, explicit };
  }

  async function getPageImagePart(pageNumber) {
    if (!pdfDoc) return null;
    if (pageImageCache.has(pageNumber)) return pageImageCache.get(pageNumber);
    const page = await pdfDoc.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.45, 1100 / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const encoded = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
    canvas.width = 0;
    canvas.height = 0;
    const result = { inlineData: { mimeType: 'image/jpeg', data: encoded } };
    pageImageCache.set(pageNumber, result);
    while (pageImageCache.size > 3) pageImageCache.delete(pageImageCache.keys().next().value);
    return result;
  }

  function getSectionContext(pageNumber) {
    const section = activeSection();
    const position = sections.indexOf(section);
    const endPage = sections[position + 1] ? sections[position + 1].page - 1 : pages.length;
    let combined = '';
    for (let page = section.page; page <= endPage; page += 1) {
      const text = pages[page - 1] || '';
      if (text) combined += '\n\n[Page ' + page + ']\n' + text;
      if (combined.length > 14000) break;
    }
    return { title: section.title, start: section.page, end: endPage, text: combined.slice(0, 14000) || getPageContext(pageNumber, 10000) };
  }

  function findTargetPage(query, fromPage) {
    const text = String(query || '');
    const current = Math.max(1, Math.min(pages.length, Number(fromPage) || currentPage));
    if (/\b(?:next|following)(?:\s+(?:one\s+)?page)?\b|\b(?:go\s+)?(?:forward|advance)(?:\s+(?:one\s+)?page)?\b|\bturn\s+(?:the\s+)?page\b/i.test(text)) {
      return Math.min(pages.length, current + 1);
    }
    if (/\b(?:previous|prior|preceding)(?:\s+(?:one\s+)?page)?\b|\b(?:go\s+)?back(?:\s+(?:one\s+)?page)?\b/i.test(text)) {
      return Math.max(1, current - 1);
    }
    if (/\bfirst\s+page\b/i.test(text)) return 1;
    if (/\blast\s+page\b/i.test(text)) return pages.length;
    const pageMatch = text.match(/\bpage\s+(\d{1,5})\b/i);
    if (pageMatch) return Math.max(1, Math.min(pages.length, Number(pageMatch[1])));
    const normalized = text.toLowerCase();
    let match = text.match(/\b(?:chapter|section|part)\s+([ivxlcdm\d]+)\b/i);
    if (match) {
      const numeral = match[1].toLowerCase();
      const candidate = sections.find((section) => {
        const title = section.title.toLowerCase();
        return title.includes('chapter ' + numeral) || title.includes('section ' + numeral) || title.includes('part ' + numeral) || title.match(new RegExp('^' + numeral + '[. :–—-]'));
      });
      if (candidate) return candidate.page;
      const number = Number(numeral);
      if (number && number <= sections.length) return sections[number - 1].page;
    }
    const named = sections.filter((section) => section.title.length > 4).sort((a, b) => b.title.length - a.title.length).find((section) => normalized.includes(section.title.toLowerCase()));
    return named ? named.page : null;
  }

  function createMessage(role, text, options) {
    const opts = options || {};
    el.welcomeCard.hidden = true;
    const message = document.createElement('div');
    message.className = 'message ' + (role === 'assistant' ? 'assistant' : 'user') + (opts.streaming ? ' streaming' : '');
    const copy = document.createElement('div');
    copy.className = 'message-copy';
    copy.textContent = text || '';
    message.append(copy);
    if (opts.meta) {
      const meta = document.createElement('span');
      meta.className = 'message-meta';
      meta.textContent = opts.meta;
      message.append(meta);
    }
    if (role === 'assistant' && !opts.streaming) {
      const tools = document.createElement('div');
      tools.className = 'message-tools';
      const listen = document.createElement('button');
      listen.type = 'button';
      listen.className = 'listen-button';
      listen.textContent = '◖ Listen';
      listen.addEventListener('click', () => speak(copy.textContent));
      tools.append(listen);
      message.append(tools);
    }
    el.chatStream.append(message);
    el.chatStream.scrollTop = el.chatStream.scrollHeight;
    return { message, copy };
  }

  function resetChat() {
    conversation = [];
    el.chatStream.replaceChildren(el.welcomeCard);
    el.welcomeCard.hidden = false;
    if (currentChatStorageKey) {
      try {
        localStorage.removeItem(currentChatStorageKey);
      } catch (error) {
        console.error('Could not clear the saved chat.', error);
        showToast('The chat was cleared from view, but saved chat memory could not be removed from this browser.');
      }
    }
  }

  function getChatStorageKey() {
    const samples = pages.map((page) => {
      const text = String(page || '');
      return text.slice(0, 128) + text.slice(-128);
    }).join('\u001f');
    let hash = 2166136261;
    const fingerprint = currentFileName.toLowerCase() + '|' + pages.length + '|' + samples;
    for (let index = 0; index < fingerprint.length; index += 1) {
      hash ^= fingerprint.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return CHAT_STORAGE_PREFIX + encodeURIComponent(currentFileName.toLowerCase()) + ':' + pages.length + ':' + (hash >>> 0).toString(16);
  }

  function saveChatMemory() {
    if (!currentChatStorageKey) return;
    const saved = conversation.slice(-MAX_SAVED_CHAT_MESSAGES).map((entry) => ({
      role: entry.role,
      text: String(entry.text || '').slice(0, MAX_SAVED_CHAT_MESSAGE_LENGTH)
    }));
    try {
      localStorage.setItem(currentChatStorageKey, JSON.stringify(saved));
    } catch (error) {
      console.error('Could not save the local chat memory.', error);
      showToast('Chat memory could not be saved in this browser. Check available local storage.');
    }
  }

  function restoreChatMemory() {
    conversation = [];
    el.chatStream.replaceChildren(el.welcomeCard);
    el.welcomeCard.hidden = false;
    if (!currentChatStorageKey) return;
    let stored;
    try {
      stored = localStorage.getItem(currentChatStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error('Saved chat data is not a message list.');
      conversation = parsed.filter((entry) =>
        entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.trim()
      ).slice(-MAX_SAVED_CHAT_MESSAGES).map((entry) => ({
        role: entry.role,
        text: entry.text.slice(0, MAX_SAVED_CHAT_MESSAGE_LENGTH)
      }));
    } catch (error) {
      conversation = [];
      console.error('Could not restore the local chat memory.', error);
      showToast('Saved chat memory could not be read. Starting a new conversation for this PDF.');
      return;
    }
    conversation.forEach((entry) => {
      const bubble = createMessage(entry.role, entry.text);
      if (entry.role === 'assistant') addListenButton(bubble.message, bubble.copy);
    });
  }

  function setTeacherBusy(isBusy, message) {
    el.sendBtn.disabled = isBusy;
    el.teacherStatus.textContent = message || (isBusy ? 'Thinking through the page…' : 'Ready to explore this page');
  }

  async function askAI(question, options) {
    const opts = options || {};
    if (!requireKey()) return null;
    if (!pages.length) { showToast('Open a PDF first so your teacher has something to explain.'); return null; }
    const pageNumber = opts.page || currentPage;
    const pageRange = getRequestedPageRange(question, pageNumber);
    const sectionData = opts.section ? getSectionContext(pageNumber) : null;
    const source = sectionData ? sectionData.text : getPagesContext(pageRange.start, pageRange.end, AI_PAGE_CONTEXT_LIMIT);
    const sourceLabel = sectionData
      ? 'Chapter or section: ' + sectionData.title + ' (pages ' + sectionData.start + '–' + sectionData.end + ')'
      : 'Current section: ' + activeSection().title + ' · reference pages: ' + pageRange.start + '–' + pageRange.end + (pageRange.explicit && Number(question.match(/\bpages?\s*(\d{1,5})\s*(?:-|–|—|to|through|thru)\s*(?:pages?\s*)?(\d{1,5})\b/i)?.[2]) > pageRange.end ? ' (limited to 10 pages)' : '');
    const enriched = sourceLabel + '\n\nPDF text for reference:\n' + (source || '[No selectable text was extracted from the requested pages.]') + '\n\nUse the page labels to distinguish the source text. When the student asks about a page range, compare and explain all requested pages represented below, not just the currently open page. For an explicitly requested range, the following page images, if any, are in ascending page order starting with page ' + pageRange.start + '. Clearly say if any requested page has no extracted text.\n\nStudent request: ' + question;
    const history = conversation.slice(-8).map((entry) => ({ role: entry.role === 'assistant' ? 'model' : 'user', parts: [{ text: entry.text }] }));
    setTeacherBusy(true, 'Preparing the page for your teacher…');
    const bubble = createMessage('assistant', '', { streaming: true, meta: sectionData ? 'TEACHING ' + sectionData.title.toUpperCase() : 'PAGE ' + String(pageNumber).padStart(2, '0') });
    let currentPageImage = null;
    try { currentPageImage = await getPageImagePart(pageRange.start); } catch (_) { /* Text explanation still works if rendering fails. */ }
    const userParts = [{ text: enriched }];
    if (currentPageImage) userParts.push(currentPageImage);
    if (pageRange.explicit && pageRange.end > pageRange.start) {
      for (let imagePage = pageRange.start + 1; imagePage <= pageRange.end; imagePage += 1) {
        try {
          const image = await getPageImagePart(imagePage);
          if (image) userParts.push(image);
        } catch (error) {
          console.warn('Could not render requested PDF page ' + imagePage + '; its extracted text remains available.', error);
        }
      }
    }
    const contents = history.concat([{ role: 'user', parts: userParts }]);
    setTeacherBusy(true, 'Thinking through the page…');
    try {
      const consumeResponse = async (response) => {
        let text = '';
        if (response.body && response.body.getReader) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            let splitAt = buffer.search(/\r?\n\r?\n/);
            while (splitAt >= 0) {
              const event = buffer.slice(0, splitAt);
              const delimiter = buffer.slice(splitAt).match(/^\r?\n\r?\n/)[0];
              buffer = buffer.slice(splitAt + delimiter.length);
              text += appendSseText(event);
              bubble.copy.textContent = text;
              el.chatStream.scrollTop = el.chatStream.scrollHeight;
              splitAt = buffer.search(/\r?\n\r?\n/);
            }
          }
          if (buffer.trim()) {
            text += appendSseText(buffer);
            bubble.copy.textContent = text;
          }
        } else {
          const data = await response.json();
          text = ((data.candidates || [])[0] || {}).content?.parts?.map((part) => part.text || '').join('') || '';
          bubble.copy.textContent = text;
        }
        if (!text.trim()) throw modelResponseError('The model returned an empty answer.');
        return text;
      };
      const payload = { systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }, contents, generationConfig: { temperature: 0.55, maxOutputTokens: opts.maxOutputTokens || 1800 } };
      let output;
      const selectedModel = getTextModel();
      const triedModels = [];
      let lastModelError;
      const tryModel = async (modelId) => {
        triedModels.push(modelId);
        bubble.copy.textContent = '';
        el.teacherStatus.textContent = 'Asking ' + modelId + '…';
        return requestTextGeneration(key(), payload, consumeResponse, { modelId });
      };
      try {
        output = await tryModel(selectedModel);
      } catch (error) {
        if (!error.modelResponseError) throw error;
        lastModelError = error;
        let availableModels;
        try {
          availableModels = await loadTextModelCatalog(key(), selectedModel);
        } catch (catalogError) {
          throw new Error(error.message + ' Could not load fallback models: ' + catalogError.message);
        }
        const fallbackModels = availableModels
          .filter((model) => model.available && model.id !== selectedModel)
          .sort((a, b) => {
            if (a.id === DEFAULT_TEXT_MODEL) return -1;
            if (b.id === DEFAULT_TEXT_MODEL) return 1;
            return a.title.localeCompare(b.title);
          });
        for (const fallback of fallbackModels) {
          try {
            output = await tryModel(fallback.id);
            localStorage.setItem('pagewise-text-model', fallback.id);
            el.textModelSelect.value = fallback.id;
            el.modelAccessStatus.dataset.state = 'good';
            el.modelAccessStatus.textContent = 'Switched to ' + fallback.id + ' after an error. This model will be used until it errors.';
            break;
          } catch (fallbackError) {
            if (!fallbackError.modelResponseError) throw fallbackError;
            lastModelError = fallbackError;
          }
        }
        if (!output) {
          throw new Error(lastModelError.message + (fallbackModels.length
            ? ' Tried available models: ' + triedModels.join(', ') + '.'
            : ' No other text models are listed for this API key.'));
        }
      }
      bubble.message.classList.remove('streaming');
      addListenButton(bubble.message, bubble.copy);
      conversation.push({ role: 'user', text: question });
      conversation.push({ role: 'assistant', text: output });
      saveChatMemory();
      setTeacherBusy(false);
      if (opts.autoSpeak) await speak(output);
      return output;
    } catch (error) {
      bubble.message.classList.remove('streaming');
      bubble.message.classList.add('error');
      const guidance = location.protocol === 'file:'
        ? 'Run start-local.bat and use the localhost page it opens.'
        : isTemporaryGeminiError(error)
          ? 'Gemini is temporarily busy. Please try again in a moment.'
          : isUnavailableModelError(error)
            ? 'The selected model is unavailable to this API key. Open Voice & AI settings and select Gemini 3.8 Flash, then save settings.'
          : isQuotaError(error)
            ? 'Gemini reported a quota or rate limit. Check Google AI Studio usage and limits before trying again.'
            : isTimeoutError(error)
              ? 'The request timed out. Check your connection and try again.'
            : 'Check the Gemini key, model access, and internet connection.';
      bubble.copy.textContent = 'I could not reach the AI teacher. ' + (error.message || guidance) + '\n' + guidance;
      setTeacherBusy(false, 'Ready to explore this page');
      showToast(error.message || 'The teacher could not connect. Check your key and try again.');
      return null;
    }
  }

  function appendSseText(eventText) {
    const data = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return '';
    let json;
    try {
      json = JSON.parse(data);
    } catch (error) {
      throw modelResponseError('Could not read Gemini’s streamed response: ' + error.message);
    }
    if (json.error) throw modelResponseError(typeof json.error === 'string' ? json.error : (json.error.message || 'Gemini failed while streaming the answer.'));
    return (((json.candidates || [])[0] || {}).content?.parts || []).map((part) => part.text || '').join('');
  }
  function readTextGenerationResponse(responseText) {
    const text = String(responseText || '').trim();
    if (!text) return { text: '', detail: 'Gemini returned an empty response body.' };
    let output = '';
    let finishReason = '';
    let blockReason = '';
    const collect = (data) => {
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      for (const candidate of candidates) {
        output += (candidate.content?.parts || []).map((part) => part.text || '').join('');
        finishReason = finishReason || candidate.finishReason || candidate.finish_reason || '';
      }
      blockReason = blockReason || data.promptFeedback?.blockReason || data.prompt_feedback?.block_reason || '';
    };
    try {
      collect(JSON.parse(text));
    } catch (_) {
      for (const eventText of text.split(/\r?\n\r?\n/)) {
        const data = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          collect(JSON.parse(data));
        } catch (error) {
          throw modelResponseError('Could not read Gemini’s text test response: ' + error.message);
        }
      }
    }
    const details = [];
    if (blockReason) details.push('Prompt block reason: ' + blockReason + '.');
    if (finishReason) details.push('Finish reason: ' + finishReason + '.');
    return { text: output.trim(), detail: details.join(' ') || 'The API returned no text candidate.' };
  }
  function parseApiError(text, status) {
    let detail = '';
    try {
      const body = JSON.parse(text);
      detail = body.error?.message || '';
    } catch (_) {}
    if (!detail) detail = 'Gemini request failed.';
    const error = new Error(detail + ' (HTTP ' + status + ').');
    error.modelResponseError = true;
    return error;
  }
  function isTemporaryGeminiError(error) {
    return /HTTP 503|high demand|temporarily unavailable|temporarily busy/i.test(error.message || '');
  }
  function isQuotaError(error) {
    return /HTTP 429|quota|rate.?limit|resource exhausted/i.test(error.message || '');
  }
  function isUnavailableModelError(error) {
    return /HTTP 404|no longer available|not found/i.test(error.message || '');
  }
  function modelResponseError(message) {
    const error = new Error(message);
    error.modelResponseError = true;
    return error;
  }
  function isTimeoutError(error) {
    return /timed out|did not respond within/i.test(error.message || '');
  }
  async function liveMessageText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return String(data);
  }

  function testLiveConnection(apiKey) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let websocketOpened = false;
      let setupSent = false;
      let serverMessageReceived = false;
      let serverMessageDetail = '';
      let timer = 0;
      let socket;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Connection test complete');
        if (error) reject(error); else resolve();
      };
      try {
        socket = new WebSocket(LIVE_ROOT + '?key=' + encodeURIComponent(apiKey));
        socket.addEventListener('open', () => {
          websocketOpened = true;
          try {
            socket.send(JSON.stringify({ setup: {
              model: 'models/' + LIVE_MODEL,
              generationConfig: { responseModalities: ['AUDIO'] }
            } }));
            setupSent = true;
          } catch (error) {
            finish(new Error('Could not send the Gemini Live setup: ' + error.message));
          }
        });
        socket.addEventListener('message', async (event) => {
          serverMessageReceived = true;
          let rawMessage;
          try {
            rawMessage = await liveMessageText(event.data);
          } catch (error) {
            serverMessageDetail = 'Could not read server frame: ' + error.message;
            return;
          }
          let message;
          try {
            message = JSON.parse(rawMessage);
          } catch (error) {
            serverMessageDetail = 'Received non-JSON server frame: ' + rawMessage.slice(0, 240);
            return;
          }
          if (message.setupComplete) finish();
          else if (message.error) {
            const detail = typeof message.error === 'string' ? message.error : (message.error.message || JSON.stringify(message.error));
            finish(new Error(detail));
          } else serverMessageDetail = 'Received server message without setupComplete: ' + JSON.stringify(message).slice(0, 240);
        });
        socket.addEventListener('close', (event) => {
          if (settled) return;
          finish(new Error('Gemini Live closed during setup (code ' + event.code + ')' + (event.reason ? ': ' + event.reason : '') + '. Check Live model access and the network.'));
        });
        socket.addEventListener('error', () => {
          if (!settled) finish(new Error('Gemini Live WebSocket failed. Check Live API access, firewall/network restrictions, and the API key.'));
        });
        timer = window.setTimeout(() => finish(new Error(
          websocketOpened && setupSent
            ? 'WebSocket connected, but Gemini Live did not confirm setup within 30 seconds' + (serverMessageReceived ? '. ' + serverMessageDetail : '; no server message was received.') + ' Check Live model access, API-key restrictions, and Live quota.'
            : 'Gemini Live WebSocket did not open within 30 seconds. Check internet, firewall/proxy restrictions, and API-key restrictions.'
        )), 30000);
      } catch (error) {
        finish(error);
      }
    });
  }

  async function checkTextModelAccess() {
    const apiKey = el.apiKeyInput.value.trim() || key();
    if (!apiKey) {
      el.modelAccessStatus.dataset.state = 'bad';
      el.modelAccessStatus.textContent = 'Paste a Gemini key first.';
      return;
    }
    el.checkModelsBtn.disabled = true;
    el.modelAccessStatus.dataset.state = '';
    el.modelAccessStatus.textContent = 'Checking models available to this API key…';
    try {
      const selectedModel = el.textModelSelect.value || getTextModel();
      const options = await loadTextModelCatalog(apiKey, selectedModel);
      const selectedAvailable = options.some((model) => model.id === selectedModel && model.available);
      el.modelAccessStatus.dataset.state = selectedAvailable ? 'good' : 'bad';
      el.modelAccessStatus.textContent = selectedAvailable
        ? selectedModel + ' is listed for this key. Remaining quota is not checked.'
        : selectedModel + ' is not listed for this key. Access may be restricted or the model may be unavailable.';
    } catch (error) {
      el.modelAccessStatus.dataset.state = 'bad';
      el.modelAccessStatus.textContent = error.message || 'Could not check model access.';
    } finally {
      el.checkModelsBtn.disabled = false;
    }
  }

  async function loadTextModelCatalog(apiKey, selectedModel) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(API_ROOT + '/models?pageSize=1000', {
        headers: { 'x-goog-api-key': apiKey },
        signal: controller.signal
      });
      if (!response.ok) throw parseApiError(await response.text(), response.status);
      const data = await response.json();
      const listed = (Array.isArray(data.models) ? data.models : [])
        .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
        .filter((model) => !RETIRED_TEXT_MODELS.has(String(model.name || '').replace(/^models\//, '')));
      const availableById = new Map(listed.map((model) => [String(model.name || '').replace(/^models\//, ''), model]));
      const modelIds = new Set([...KNOWN_TEXT_MODELS.map((model) => model.id), ...availableById.keys(), selectedModel]);
      const options = Array.from(modelIds, (id) => {
        const known = KNOWN_TEXT_MODELS.find((model) => model.id === id);
        const apiModel = availableById.get(id);
        return { id, title: known ? known.label : (apiModel && apiModel.displayName) || id, available: Boolean(apiModel), recommended: Boolean(known) };
      }).sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
      el.textModelSelect.replaceChildren(...options.map((model) => {
        const option = new Option(model.title + (model.available ? ' · API access' : ' · unavailable to this key'), model.id);
        option.dataset.available = String(model.available);
        return option;
      }));
      el.textModelSelect.value = selectedModel;
      return options;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Model access check timed out. Check your internet connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function testKeyConnection() {
    const apiKey = el.apiKeyInput.value.trim() || key();
    if (!apiKey) {
      el.keyTestStatus.dataset.state = 'bad';
      el.keyTestStatus.textContent = 'Paste a Gemini key first.';
      return;
    }
    if (location.protocol === 'file:') {
      el.keyTestStatus.dataset.state = 'bad';
      el.keyTestStatus.textContent = 'Run start-local.bat; file:// pages block API connections.';
      return;
    }
    el.testKeyBtn.disabled = true;
    el.keyTestStatus.dataset.state = '';
    el.keyTestStatus.textContent = 'Checking Gemini access…';
    let textResult = '';
    let liveResult = '';
    try {
      const testedModel = el.textModelSelect.value || getTextModel();
      try {
        const result = await requestTextGeneration(apiKey, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 256 } }, async (response) => {
          return readTextGenerationResponse(await response.text());
        }, { modelId: testedModel, timeoutMs: 15000 });
        if (!result.text) throw new Error('Gemini returned no text. ' + result.detail + ' Check model access, quota, and finish status.');
        textResult = testedModel + ': works';
      } catch (error) {
        textResult = testedModel + ': ' + (error.message || 'failed');
      }
      el.keyTestStatus.textContent = 'Text check complete; checking Live Voice separately…';
      try {
        await testLiveConnection(apiKey);
        liveResult = 'Live Voice: connected';
      } catch (error) {
        liveResult = 'Live Voice: ' + (error.message || 'failed');
      }
      el.keyTestStatus.dataset.state = liveResult === 'Live Voice: connected' && textResult.endsWith(': works') ? 'good' : 'bad';
      el.keyTestStatus.textContent = textResult + '. ' + liveResult + '.';
    } finally {
      el.testKeyBtn.disabled = false;
    }
  }
  function addListenButton(message, copy) {
    if (message.querySelector('.message-tools')) return;
    const tools = document.createElement('div');
    tools.className = 'message-tools';
    const listen = document.createElement('button');
    listen.type = 'button';
    listen.className = 'listen-button';
    listen.textContent = '◖ Listen';
    listen.addEventListener('click', () => speak(copy.textContent));
    tools.append(listen);
    message.append(tools);
  }

  function requestSuggestJump(question) {
    const match = findTargetPage(question, currentPage);
    const hasIntent = /\b(go to|jump to|take me|start (?:at|from)|open|skip to|begin at|move to|turn to|next(?: page)?|following(?: page)?|forward(?: one)?(?: page)?|previous(?: page)?|prior(?: page)?|back(?: one)?(?: page)?|first page|last page)\b/i.test(question);
    if (match !== null && (hasIntent || /\b(chapter|section|part|page)\s+/i.test(question))) {
      goToPage(match);
      return match;
    }
    return null;
  }

  async function onChatSubmit(event) {
    event.preventDefault();
    if (el.sendBtn.disabled) return;
    const question = el.chatInput.value.trim();
    if (!question) return;
    if (!pages.length) { showToast('Open a PDF first.'); return; }
    if (!requireKey()) return;
    el.chatInput.value = '';
    el.chatInput.style.height = 'auto';
    const jumped = requestSuggestJump(question);
    createMessage('user', question);
    const pageContext = jumped ? 'The student navigated to page ' + jumped + ', which is in ' + activeSection().title + '. Explain that location if asked.' : '';
    await askAI(question + (pageContext ? '\n\nNavigation context: ' + pageContext : ''), { page: currentPage });
  }

  async function explainCurrent() {
    if (!pages.length) { showToast('Open a PDF first.'); return null; }
    createMessage('user', 'Teach me this page carefully, with examples.');
    return askAI('Teach page ' + currentPage + ' as a complete, careful lesson. Work through every important idea and term shown on this page in order; explain what each means and how the ideas connect. Use at least two concrete examples or analogies where the material allows. Do not compress the lesson into a few lines or impose a short word limit. Stay accurate to the PDF and explain any uncertainty. If the page is too dense for one response, teach the first part thoroughly and clearly offer to continue with the rest.', { page: currentPage, autoSpeak: true, maxOutputTokens: 1800 });
  }

  async function lessonLoop() {
    while (isAutoTeaching && currentPage <= pages.length) {
      if (explainedPages.has(currentPage)) {
        if (currentPage >= pages.length) break;
        goToPage(currentPage + 1);
        continue;
      }
      const startPage = currentPage;
      createMessage('user', 'Teach me page ' + startPage + ' carefully, with examples.');
      const explanation = await askAI('Teach page ' + startPage + ' as a complete, careful lesson. Explain every important idea and term on the page in order, show how the ideas connect, and use at least two concrete examples or analogies where appropriate. Do not reduce the page to a few lines or use a short word limit. Be accurate to the PDF; if the page is too dense for one response, teach a substantial first part and offer to continue with the rest.', { page: startPage, maxOutputTokens: 1800 });
      if (!explanation || !isAutoTeaching) break;
      explainedPages.add(startPage);
      await speak(explanation);
      if (!isAutoTeaching) break;
      if (currentPage >= pages.length) {
        isAutoTeaching = false;
        el.teachPdfLabel.textContent = 'Teach from here';
        el.teacherStatus.textContent = 'You reached the end of the PDF';
        showToast('That’s the end of this PDF. Nice work.');
        break;
      }
      goToPage(startPage + 1);
    }
  }
  function startLesson() {
    if (!pages.length) { showToast('Open a PDF first.'); return; }
    if (!requireKey()) return;
    if (isAutoTeaching) { stopLesson(); return; }
    isAutoTeaching = true;
    el.teachPdfLabel.textContent = 'Pause lesson';
    el.teacherStatus.textContent = 'Lesson is in progress';
    autoTeachTask = lessonLoop().finally(() => {
      autoTeachTask = null;
      if (isAutoTeaching) {
        isAutoTeaching = false;
        el.teachPdfLabel.textContent = 'Teach from here';
        setTeacherBusy(false);
      }
    });
  }
  function stopLesson() {
    isAutoTeaching = false;
    el.teachPdfLabel.textContent = 'Teach from here';
    stopSpeechOnly();
    setTeacherBusy(false);
  }

  async function speak(text) {
    const spoken = String(text || '').trim();
    if (!spoken) return;
    stopSpeechOnly();
    const lessonSpeech = isAutoTeaching;
    let voiceFallbackReason = '';
    if (key()) {
      try {
        el.teacherStatus.textContent = 'Preparing your teacher’s voice…';
        const response = await fetch(API_ROOT + '/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key() },
          body: JSON.stringify({
            model: TTS_MODEL,
            input: [{ type: 'user_input', content: [{ type: 'text', text: spoken.slice(0, 9000), annotations: [{ type: 'speech_metadata', style: 'warm, natural, expressive, like a patient teacher explaining a fascinating idea' }] }] }],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: getVoice() }] }
          })
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw parseApiError(errorText, response.status);
        }
        const data = await response.json();
        if (lessonSpeech && !isAutoTeaching) return;
        let encoded = data.output_audio?.data || '';
        if (!encoded && Array.isArray(data.steps)) {
          for (const step of data.steps) for (const content of (step.content || [])) if (content.type === 'audio' && content.data) encoded = content.data;
        }
        if (!encoded) throw new Error('The voice model returned no audio.');
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        currentAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        currentAudio = new Audio(currentAudioUrl);
        el.teacherStatus.textContent = 'Speaking your explanation';
        await new Promise((resolve, reject) => {
          currentSpeakResolve = resolve;
          currentAudio.addEventListener('ended', resolve, { once: true });
          currentAudio.addEventListener('error', () => reject(new Error('Audio playback failed.')), { once: true });
          currentAudio.play().catch(reject);
        });
        currentSpeakResolve = null;
        el.teacherStatus.textContent = 'Ready to explore this page';
        return;
      } catch (error) {
        currentSpeakResolve = null;
        if (isAutoTeaching && error.name === 'AbortError') return;
        console.warn('Natural voice unavailable; using a device voice.', error);
        voiceFallbackReason = error.message || 'Check TTS model access.';
      }
    }
    const playback = speakWithBrowserVoice(spoken);
    if (voiceFallbackReason) return playback.then(() => {
      el.teacherStatus.textContent = 'Browser voice used; Gemini voice failed: ' + voiceFallbackReason;
    });
    return playback;
  }
  function stopSpeechOnly() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (currentSpeakResolve) { currentSpeakResolve(); currentSpeakResolve = null; }
    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = ''; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
  function speakWithBrowserVoice(text) {
    if (!('speechSynthesis' in window)) {
      showToast('Speech playback is not available in this browser.');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find((voice) => /^en/i.test(voice.lang) && /natural|premium|enhanced/i.test(voice.name)) || voices.find((voice) => /^en/i.test(voice.lang)) || null;
      utterance.rate = 0.96;
      utterance.onend = resolve;
      utterance.onerror = resolve;
      el.teacherStatus.textContent = 'Speaking with your browser voice';
      window.speechSynthesis.speak(utterance);
    });
  }

  function liveSystemInstruction() {
    const outline = sections.slice(0, 80).map((section) => 'Page ' + section.page + ': ' + section.title).join('\n');
    return SYSTEM_INSTRUCTION + '\n\nThe student is studying "' + currentFileName + '" (' + pages.length + ' pages). Use the supplied PDF content as your source. You have the current page and following pages below. If asked about a range not included in the supplied pages, call read_pdf_pages to retrieve the requested pages before answering; do not change the visible reader page just to retrieve text. When the student asks you to teach, explain, or walk through a page or concept, do not give a 3-4-line summary: deliver a substantial spoken lesson (normally about 2-4 minutes), covering the important ideas and terms in a logical order, explaining how they connect, and giving at least two concrete examples or analogies when the material allows. Explain enough for the student to understand, not just hear a list of facts. Stay accurate to the PDF, clearly distinguish examples from source material, and do not invent details. Keep ordinary greetings and narrow factual follow-ups conversational and appropriately brief; the longer teaching style applies to requests to learn or understand a topic. When the student says “continue,” continue the lesson with material not yet covered rather than repeating or ending early. Always answer only in English. Do not speak or write in Urdu or any other language, even if the student speaks another language. If the student asks to move to a chapter, section, or page, including the next or previous page, call navigate_to_pdf with the requested location; then teach the selected location. Do not claim to have changed pages unless the navigation tool succeeds.\n\nPDF outline:\n' + (outline || 'No chapter outline was detected.') + '\n\nCurrent location: page ' + currentPage + ', in ' + activeSection().title + '.\nCurrent page and following pages (up to 10 total):\n' + getPagesContext(currentPage, Math.min(pages.length, currentPage + AI_PAGE_WINDOW_SIZE - 1), AI_PAGE_CONTEXT_LIMIT);
  }

  async function startLive() {
    if (!pages.length) { showToast('Open a PDF first so your teacher can study along.'); return; }
    if (location.protocol === 'file:') {
      showToast('Run start-local.bat first. Voice and AI do not connect from a file:// page.');
      return;
    }
    if (!requireKey()) return;
    if (!window.isSecureContext) {
      showToast('Open Pagewise on localhost or HTTPS before starting live voice.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone access needs a secure browser page, such as localhost or HTTPS.');
      return;
    }
    if (liveStarting) return;
    liveStarting = true;
    el.liveVoiceBtn.classList.add('active');
    el.liveVoiceLabel.textContent = 'Connecting…';
    el.teacherStatus.textContent = 'Connecting to your voice teacher…';
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('This browser does not support live audio. Try a current version of Chrome or Edge.');
      // Resume both audio contexts directly from the user's click, before the permission prompt.
      liveAudioContext = liveAudioContext || new AudioContextClass();
      micContext = micContext || new AudioContextClass();
      await Promise.all([liveAudioContext.resume(), micContext.resume()]);
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const wsUrl = LIVE_ROOT + '?key=' + encodeURIComponent(key());
      liveSocket = new WebSocket(wsUrl);
      let websocketOpened = false;
      liveSocket.addEventListener('open', () => {
        websocketOpened = true;
        el.teacherStatus.textContent = 'Connected; setting up Live Voice…';
        try {
          liveSocket.send(JSON.stringify({ setup: {
            model: 'models/' + LIVE_MODEL,
            generationConfig: {
              responseModalities: ['AUDIO'],
              maxOutputTokens: 3072,
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: getVoice() } } }
            },
            systemInstruction: { parts: [{ text: liveSystemInstruction() }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ functionDeclarations: [
              {
                name: 'navigate_to_pdf',
                description: 'Move the student to a named chapter, section, or numbered page, or to the next, previous, first, or last page when requested.',
                parameters: { type: 'OBJECT', properties: { target: { type: 'STRING', description: 'The requested destination, for example next page, previous page, page 12, or chapter 3' } }, required: ['target'] }
              },
              {
                name: 'read_pdf_pages',
                description: 'Retrieve text from a requested range of PDF pages without changing the visible reader page. Use this when the student asks about a range not included in the provided page context.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    startPage: { type: 'INTEGER', description: 'First requested page number' },
                    endPage: { type: 'INTEGER', description: 'Last requested page number; at most 10 pages will be returned' }
                  },
                  required: ['startPage', 'endPage']
                }
              }
            ] }]
          } }));
        } catch (error) {
          closeLive(false);
          showLiveConnectionError('Could not send Gemini Live setup: ' + error.message);
        }
      });
      liveSocket.addEventListener('message', onLiveMessage);
      liveSocket.addEventListener('error', () => {
        el.teacherStatus.textContent = 'Live voice connection failed. Check the Gemini API key and Live model access.';
      });
      const connectedSocket = liveSocket;
      liveConnectTimer = window.setTimeout(() => {
        if (liveSocket === connectedSocket && !liveReady) {
          closeLive(false);
          showLiveConnectionError(websocketOpened
            ? 'WebSocket connected, but Gemini Live did not confirm setup within 30 seconds. Check Live model access, API-key restrictions, and Live quota.'
            : 'Gemini Live WebSocket did not open within 30 seconds. Check internet, firewall/proxy restrictions, and API-key restrictions.');
        }
      }, 30000);
      connectedSocket.addEventListener('close', (event) => {
        if (liveSocket === connectedSocket) {
          closeLive(false);
          const reason = event.reason ? ' ' + event.reason : '';
          showLiveConnectionError('Gemini Live closed before the session ended (code ' + event.code + ').' + reason + ' Check the API key, Live model access, and network.');
        }
      });
    } catch (error) {
      console.error(error);
      closeLive(false);
      showLiveConnectionError(error.name === 'NotAllowedError' ? 'Allow microphone access to talk with your teacher.' : (error.message || 'Could not start live voice.'));
    } finally {
      liveStarting = false;
    }
  }

  async function onLiveMessage(event) {
    let message;
    try {
      message = JSON.parse(await liveMessageText(event.data));
    } catch (error) {
      showLiveConnectionError('Could not read Gemini Live server message: ' + error.message);
      closeLive(false);
      return;
    }
    if (message.error) {
      const detail = typeof message.error === 'string' ? message.error : (message.error.message || JSON.stringify(message.error));
      closeLive(false);
      showLiveConnectionError(detail);
      return;
    }
    if (message.setupComplete) {
      window.clearTimeout(liveConnectTimer);
      liveConnectTimer = 0;
      liveReady = true;
      clearLiveUsage();
      window.clearInterval(liveUsageTimer);
      liveUsageTimer = window.setInterval(() => refreshLiveUsage(Date.now()), 1000);
      el.liveVoiceLabel.textContent = 'Stop talking';
      el.voiceHint.textContent = 'Listening · keep this tab open';
      el.teacherStatus.textContent = 'Listening to your question…';
      startMicrophoneStream();
      sendLiveText('For reference, the currently open page and following pages are available here:\n' + getPagesContext(currentPage, Math.min(pages.length, currentPage + AI_PAGE_WINDOW_SIZE - 1), AI_PAGE_CONTEXT_LIMIT));
      sendLivePageImage(currentPage);
      return;
    }
    if (message.usageMetadata || message.usage_metadata) {
      recordLiveUsage(message.usageMetadata || message.usage_metadata);
    }
    if (message.toolCall && Array.isArray(message.toolCall.functionCalls)) handleLiveTools(message.toolCall.functionCalls);
    const server = message.serverContent;
    if (!server) return;
    if (server.interrupted) {
      stopLiveAudio();
      liveReplyText = '';
      liveAssistantBubble = null;
    }
    if (server.inputTranscription && server.inputTranscription.text) updateLiveTranscript(server.inputTranscription.text, 'user');
    if (server.outputTranscription && server.outputTranscription.text) updateLiveTranscript(server.outputTranscription.text, 'assistant');
    if (server.modelTurn && Array.isArray(server.modelTurn.parts)) {
      for (const part of server.modelTurn.parts) {
        const audio = part.inlineData || part.inline_data;
        if (audio && audio.data) playLivePcm(audio.data);
        if (part.text) updateLiveTranscript(part.text, 'assistant');
      }
    }
    if (server.turnComplete) {
      el.teacherStatus.textContent = 'Listening · ask a follow-up';
      if (liveAssistantBubble) liveAssistantBubble.message.classList.remove('streaming');
      if (liveInputText.trim()) conversation.push({ role: 'user', text: liveInputText });
      if (liveReplyText.trim()) conversation.push({ role: 'assistant', text: liveReplyText });
      if (liveInputText.trim() || liveReplyText.trim()) saveChatMemory();
      liveInputText = '';
      liveUserBubble = null;
      liveReplyText = '';
      liveAssistantBubble = null;
    }
  }

  function updateLiveTranscript(text, role) {
    const value = String(text || '');
    if (role === 'user') {
      if (!liveUserBubble || liveInputText.length === 0) liveUserBubble = createMessage('user', '', { meta: 'LIVE VOICE' });
      if (value.length >= liveInputText.length && value.startsWith(liveInputText)) liveInputText = value;
      else liveInputText += value;
      liveUserBubble.copy.textContent = liveInputText;
    } else {
      if (!liveAssistantBubble || liveReplyText.length === 0) liveAssistantBubble = createMessage('assistant', '', { streaming: true, meta: 'LIVE TEACHER' });
      if (value.length >= liveReplyText.length && value.startsWith(liveReplyText)) liveReplyText = value;
      else liveReplyText += value;
      liveAssistantBubble.copy.textContent = liveReplyText;
      el.chatStream.scrollTop = el.chatStream.scrollHeight;
    }
  }

  function startMicrophoneStream() {
    if (!micStream || !liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
    try {
      if (!micContext) micContext = new (window.AudioContext || window.webkitAudioContext)();
      if (micContext.state === 'suspended') micContext.resume().catch(() => {});
      const source = micContext.createMediaStreamSource(micStream);
      micProcessor = micContext.createScriptProcessor(2048, 1, 1);
      micSilence = micContext.createGain();
      micSilence.gain.value = 0;
      micProcessor.onaudioprocess = (audioEvent) => {
        if (!liveReady || !liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
        const input = audioEvent.inputBuffer.getChannelData(0);
        const data = resampleToPcm16(input, micContext.sampleRate, 16000);
        if (data) liveSocket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } }));
      };
      source.connect(micProcessor);
      micProcessor.connect(micSilence);
      micSilence.connect(micContext.destination);
    } catch (error) {
      console.error(error);
      showToast('Microphone audio could not be processed in this browser.');
      closeLive(false);
    }
  }

  function resampleToPcm16(input, inputRate, outputRate) {
    const ratio = inputRate / outputRate;
    const length = Math.floor(input.length / ratio);
    if (!length) return '';
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
      pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function playLivePcm(base64) {
    try {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i] / 32768;
      const buffer = liveAudioContext.createBuffer(1, floats.length, 24000);
      buffer.copyToChannel(floats, 0);
      const source = liveAudioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(liveAudioContext.destination);
      source.onended = () => liveSources.delete(source);
      nextLivePlaybackAt = Math.max(nextLivePlaybackAt, liveAudioContext.currentTime + 0.02);
      source.start(nextLivePlaybackAt);
      nextLivePlaybackAt += buffer.duration;
      liveSources.add(source);
    } catch (error) { console.warn('Could not play a voice chunk.', error); }
  }
  function stopLiveAudio() {
    liveSources.forEach((source) => { try { source.stop(); } catch (_) {} });
    liveSources.clear();
    nextLivePlaybackAt = liveAudioContext ? liveAudioContext.currentTime : 0;
  }

  function sendLiveText(text) {
    if (liveSocket && liveSocket.readyState === WebSocket.OPEN && liveReady) {
      liveSocket.send(JSON.stringify({ realtimeInput: { text } }));
    }
  }

  async function sendLivePageImage(pageNumber) {
    try {
      const image = await getPageImagePart(pageNumber);
      if (image && liveSocket && liveSocket.readyState === WebSocket.OPEN && liveReady) {
        liveSocket.send(JSON.stringify({ realtimeInput: { video: image.inlineData } }));
      }
    } catch (_) { /* Text context remains available if this page cannot be rendered. */ }
  }

  async function handleLiveTools(calls) {
    const responses = [];
    for (const call of calls) {
      if (call.name === 'read_pdf_pages') {
        const args = call.args || {};
        const requestedStart = Number(args.startPage ?? args.start_page);
        const requestedEnd = Number(args.endPage ?? args.end_page);
        if (!Number.isInteger(requestedStart) || !Number.isInteger(requestedEnd) || requestedStart < 1 || requestedEnd < requestedStart || requestedStart > pages.length) {
          responses.push({ id: call.id, name: call.name, response: { result: 'Invalid page range. Provide startPage and endPage from 1 to ' + pages.length + '.' } });
          continue;
        }
        const end = Math.min(requestedEnd, requestedStart + AI_PAGE_WINDOW_SIZE - 1, pages.length);
        responses.push({ id: call.id, name: call.name, response: { result: 'PDF text for pages ' + requestedStart + '–' + end + ':\n' + getPagesContext(requestedStart, end, AI_PAGE_CONTEXT_LIMIT) } });
        continue;
      }
      if (call.name !== 'navigate_to_pdf') continue;
      const target = call.args && call.args.target ? call.args.target : '';
      const page = findTargetPage(target, currentPage);
      if (page) {
        goToPage(page, false);
        sendLivePageImage(page);
        liveReplyText = '';
        liveAssistantBubble = null;
        responses.push({ id: call.id, name: call.name, response: { result: 'Navigated to page ' + page + ', section ' + activeSection().title + '. Text for this page and following pages:\n' + getPagesContext(page, Math.min(pages.length, page + AI_PAGE_WINDOW_SIZE - 1), AI_PAGE_CONTEXT_LIMIT) } });
      } else {
        responses.push({ id: call.id, name: call.name, response: { result: 'I could not find that location in the outline. Available chapter names: ' + sections.map((section) => section.title).join('; ') } });
      }
    }
    if (responses.length && liveSocket && liveSocket.readyState === WebSocket.OPEN) liveSocket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }

  function closeLive(showMessage) {
    const socket = liveSocket;
    window.clearTimeout(liveConnectTimer);
    liveConnectTimer = 0;
    window.clearInterval(liveUsageTimer);
    liveUsageTimer = 0;
    liveReady = false;
    liveSocket = null;
    liveStarting = false;
    if (micProcessor) { try { micProcessor.disconnect(); } catch (_) {} micProcessor.onaudioprocess = null; micProcessor = null; }
    if (micSilence) { try { micSilence.disconnect(); } catch (_) {} micSilence = null; }
    if (micContext) { micContext.close().catch(() => {}); micContext = null; }
    if (micStream) { micStream.getTracks().forEach((track) => track.stop()); micStream = null; }
    stopLiveAudio();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'User ended the session');
    el.liveVoiceBtn.classList.remove('active');
    el.liveVoiceLabel.textContent = 'Talk to your teacher';
    el.voiceHint.textContent = key() ? 'Real-time voice · Gemini Live' : 'Live voice needs a free API key';
    el.teacherStatus.textContent = 'Ready to explore this page';
    clearLiveUsage();
    if (showMessage) showToast('Live voice ended.');
  }

  function showLiveConnectionError(message) {
    const detail = String(message || 'Live voice could not connect.').slice(0, 450);
    el.teacherStatus.textContent = 'Live voice error: ' + detail;
    showToast(detail);
  }

  function escapeKeyFromDialog() {
    if (el.settingsDialog.open) el.settingsDialog.close();
  }

  el.choosePdfBtn.addEventListener('click', () => el.fileInput.click());
  el.heroChooseBtn.addEventListener('click', () => el.fileInput.click());
  el.samplePdfBtn.addEventListener('click', async () => {
    el.samplePdfBtn.disabled = true;
    try {
      const response = await fetch(new URL('assets/pasted_text_transcript.pdf', document.baseURI));
      if (!response.ok) throw new Error('The sample PDF could not be downloaded (HTTP ' + response.status + ').');
      const sample = new File([await response.blob()], 'pasted_text_transcript.pdf', { type: 'application/pdf' });
      await loadPdf(sample);
    } catch (error) {
      console.error('Could not load the included OCR sample book.', error);
      showToast(error.message || 'Could not load the OCR sample book. Check your connection and try again.');
    } finally {
      el.samplePdfBtn.disabled = false;
    }
  });
  el.fileInput.addEventListener('change', (event) => { if (event.target.files && event.target.files[0]) loadPdf(event.target.files[0]); event.target.value = ''; });
  el.prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
  el.nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));
  el.teachPdfBtn.addEventListener('click', startLesson);
  el.chatForm.addEventListener('submit', onChatSubmit);
  el.chatInput.addEventListener('input', () => { el.chatInput.style.height = 'auto'; el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 90) + 'px'; });
  el.chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el.chatForm.requestSubmit(); } });
  el.liveVoiceBtn.addEventListener('click', () => isLive() ? closeLive(true) : startLive());
  el.settingsBtn.addEventListener('click', openSettings);
  el.topSettingsBtn.addEventListener('click', openSettings);
  el.settingsInlineBtn.addEventListener('click', openSettings);
  el.saveSettingsBtn.addEventListener('click', saveSettings);
  el.testKeyBtn.addEventListener('click', testKeyConnection);
  el.checkModelsBtn.addEventListener('click', checkTextModelAccess);
  el.textModelSelect.addEventListener('change', () => {
    el.modelAccessStatus.dataset.state = '';
    el.modelAccessStatus.textContent = 'Selected model changed. Check model access to refresh its status.';
  });
  el.apiKeyInput.addEventListener('input', () => {
    el.modelAccessStatus.dataset.state = '';
    el.modelAccessStatus.textContent = 'Key changed. Check model access to refresh availability.';
  });
  el.removeKeyBtn.addEventListener('click', () => { el.apiKeyInput.value = ''; sessionStorage.removeItem('pagewise-gemini-key'); localStorage.removeItem('pagewise-gemini-key'); updateKeyState(); showToast('API key removed from this browser.'); });
  el.toggleKeyBtn.addEventListener('click', () => { const reveal = el.apiKeyInput.type === 'password'; el.apiKeyInput.type = reveal ? 'text' : 'password'; el.toggleKeyBtn.textContent = reveal ? 'Hide' : 'Show'; });
  el.clearChatBtn.addEventListener('click', resetChat);
  el.copyPageBtn.addEventListener('click', async () => {
    const text = pages[currentPage - 1] || '';
    if (!text) { showToast('There is no selectable text on this page.'); return; }
    try { await navigator.clipboard.writeText(text); showToast('Page text copied.'); }
    catch (_) { showToast('Clipboard access is unavailable in this browser.'); }
  });
  el.chatStream.addEventListener('click', (event) => {
    const chip = event.target.closest('.suggestion-chip');
    if (chip) { el.chatInput.value = chip.dataset.prompt || ''; el.chatForm.requestSubmit(); }
  });
  document.querySelectorAll('.app-frame').forEach((target) => {
    target.addEventListener('dragover', (event) => { event.preventDefault(); target.classList.add('drag-active'); });
    target.addEventListener('dragleave', (event) => { if (!target.contains(event.relatedTarget)) target.classList.remove('drag-active'); });
    target.addEventListener('drop', (event) => { event.preventDefault(); target.classList.remove('drag-active'); const file = event.dataTransfer.files && event.dataTransfer.files[0]; if (file) loadPdf(file); });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); el.fileInput.click(); }
    if (event.key === 'Escape' && isLive()) closeLive(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !isLive()) return;
    const resumeTasks = [];
    if (micContext && micContext.state === 'suspended') resumeTasks.push(micContext.resume());
    if (liveAudioContext && liveAudioContext.state === 'suspended') resumeTasks.push(liveAudioContext.resume());
    Promise.all(resumeTasks).then(() => {
      if (liveReady) el.teacherStatus.textContent = 'Listening to your question…';
    }).catch((error) => {
      console.warn('Could not resume Live Voice audio after returning to the tab.', error);
      el.teacherStatus.textContent = 'Live Voice may be paused. Tap “Stop talking” and reconnect if it does not resume.';
    });
  });
  el.settingsDialog.addEventListener('click', (event) => { if (event.target === el.settingsDialog) el.settingsDialog.close(); });

  const originalRenderBook = renderBook;
  renderBook = async function renderBookWithOutline() {
    sections = await readOutline();
    if (!sections.length) sections = inferSections();
    originalRenderBook();
  };

  updateKeyState();
  if (location.protocol === 'file:') el.fileModeNotice.hidden = false;
})();
