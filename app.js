/* English Tutor — первая версия.
   Мозг: Groq (OpenAI-совместимый API). Голос и распознавание — средства браузера.
   Ключ хранится только в браузере (localStorage) и никогда не попадает в код/GitHub. */
(() => {
  'use strict';

  const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const HISTORY_LIMIT = 16;          // сколько последних реплик отправлять ИИ (бережём лимит токенов)
  const LS = {
    settings: 'et_settings_v1',
    key: 'et_groq_key_v1',
    lesson: 'et_lesson_v1',
    words: 'et_words_v1',
    progress: 'et_progress_v1',
  };

  const DEFAULTS = {
    level: 'B1',
    topic: 'free conversation about anything the student likes',
    voice: '',
    rate: 0.95,
    recLang: 'en-GB',
    model: 'openai/gpt-oss-120b',
    autoMic: true,
  };

  const LEVEL_NOTES = {
    A1: 'absolute beginner: very short simple sentences, present simple, the most common 500 words, speak slowly and clearly',
    A2: 'elementary: short sentences, basic past and future, everyday vocabulary',
    B1: 'intermediate: natural everyday English, common phrasal verbs, mixed tenses',
    B2: 'upper-intermediate: natural fluent English, idioms occasionally, more complex structures',
    C1: 'advanced: rich natural English as with an educated native speaker, nuanced vocabulary',
  };

  // ---------- хранилище ----------
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch { return false; }
    },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let settings = { ...DEFAULTS, ...store.get(LS.settings, {}) };
  let apiKey = store.get(LS.key, '');
  // lesson.mode: 'free' (свободный разговор) | 'course' (урок программы) | 'placement' (вводный разговор)
  // сообщения: {role:'teacher'|'student'|'note', text, corrections?}
  let lesson = { messages: [], mode: 'free', lessonId: null, ...store.get(LS.lesson, {}) };
  let words = store.get(LS.words, []);                  // {word, translation}
  // progress.done[id] = {at}; progress.placed — уровень, с которого открыта программа
  let progress = { done: {}, placed: null, ...store.get(LS.progress, {}) };
  const CUR = window.CURRICULUM || { levels: [], lessons: [] };
  const MIN_TURNS_TO_FINISH = 7;   // раньше 7-й реплики ученика урок автоматически не завершается
  const MIN_TURNS_MANUAL = 4;      // кнопка «Завершить урок» доступна с 4-й реплики
  let viewLevel = progress.placed || CUR.levels[0] || 'A1';

  // ---------- элементы ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    avatarWrap: $('avatarWrap'), statePill: $('statePill'),
    mic: $('btnMic'), stop: $('btnStop'), autoMic: $('autoMic'),
    chat: $('chat'), composer: $('composer'), input: $('textInput'), send: $('btnSend'),
    wordsList: $('wordsList'), wordsCount: $('wordsCount'), clearWords: $('btnClearWords'),
    newLesson: $('btnNewLesson'), btnSettings: $('btnSettings'),
    levelChips: $('levelChips'), levelStart: $('levelStart'), lessonsList: $('lessonsList'), btnPlacement: $('btnPlacement'),
    lessonBar: $('lessonBar'), lessonBarTitle: $('lessonBarTitle'), btnFinish: $('btnFinishLesson'),
    dlg: $('settingsDlg'), setKey: $('setKey'), showKey: $('btnShowKey'),
    setLevel: $('setLevel'), setTopic: $('setTopic'), setVoice: $('setVoice'),
    setRate: $('setRate'), rateVal: $('rateVal'), setRecLang: $('setRecLang'), setModel: $('setModel'),
    deleteKey: $('btnDeleteKey'), testVoice: $('btnTestVoice'),
    cancelSettings: $('btnCancelSettings'), saveSettings: $('btnSaveSettings'),
    confirmDlg: $('confirmDlg'), confirmText: $('confirmText'), confirmYes: $('confirmYes'), confirmNo: $('confirmNo'),
    toast: $('toast'),
    mouthInner: document.getElementById('mouthInner'),
    mouthClip: document.getElementById('mouthClipShape'),
    lipLine: document.getElementById('lipLine'),
    lids: document.querySelectorAll('.lid'),
  };

  // ---------- состояние ----------
  let state = 'idle';            // idle | listening | thinking | speaking
  let busy = false;              // идёт запрос к ИИ
  let speakToken = 0;            // для отмены очереди речи
  let recognition = null;
  let recognitionActive = false;

  const STATE_LABEL = {
    idle: 'Ready for the lesson',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  };

  function setState(s) {
    state = s;
    el.avatarWrap.dataset.state = s;
    el.statePill.textContent = STATE_LABEL[s];
    el.mic.classList.toggle('listening', s === 'listening');
    el.send.disabled = busy;
    el.mic.disabled = busy;
  }

  // ---------- уведомления и подтверждения ----------
  let toastTimer;
  function toast(text, isError = false) {
    el.toast.textContent = text;
    el.toast.classList.toggle('error', isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 4500 : 2400);
  }

  function confirmAction(text, yesLabel = 'Yes') {
    return new Promise((resolve) => {
      el.confirmText.textContent = text;
      el.confirmYes.textContent = yesLabel;
      const done = (val) => {
        el.confirmYes.onclick = el.confirmNo.onclick = null;
        el.confirmDlg.removeEventListener('cancel', onCancel);
        if (el.confirmDlg.open) el.confirmDlg.close();
        resolve(val);
      };
      const onCancel = (e) => { e.preventDefault(); done(false); };
      el.confirmYes.onclick = () => done(true);
      el.confirmNo.onclick = () => done(false);
      el.confirmDlg.addEventListener('cancel', onCancel);
      el.confirmDlg.showModal();
      el.confirmNo.focus(); // по умолчанию фокус на «Отмена» — защита от случайного Enter
    });
  }

  // ---------- аватар: моргание и рот ----------
  function blink() {
    el.lids.forEach((l) => l.setAttribute('height', '31'));
    setTimeout(() => el.lids.forEach((l) => l.setAttribute('height', '0')), 130);
  }
  (function blinkLoop() {
    setTimeout(() => { blink(); blinkLoop(); }, 2600 + Math.random() * 3200);
  })();

  let mouthOpen = 0;       // 0..1 текущее
  let mouthTarget = 0;     // 0..1 цель
  let talking = false;
  let lastShape = 0;
  function setMouth(v) {
    const ry = 2 + v * 13;
    const rx = 17 - v * 3;
    el.mouthInner.setAttribute('ry', ry.toFixed(2));
    el.mouthInner.setAttribute('rx', rx.toFixed(2));
    el.mouthInner.setAttribute('cy', (208 + v * 3).toFixed(2));
    el.mouthClip.setAttribute('ry', ry.toFixed(2));
    el.mouthClip.setAttribute('rx', rx.toFixed(2));
    el.mouthClip.setAttribute('cy', (208 + v * 3).toFixed(2));
    el.lipLine.style.opacity = v > 0.15 ? '0' : '1';
  }
  (function mouthLoop(t) {
    if (talking && t - lastShape > 85) {
      lastShape = t;
      mouthTarget = Math.random() < 0.18 ? 0.1 : 0.35 + Math.random() * 0.65;
    }
    if (!talking) mouthTarget = 0;
    mouthOpen += (mouthTarget - mouthOpen) * 0.35;
    setMouth(mouthOpen);
    requestAnimationFrame(mouthLoop);
  })(0);

  // ---------- голос (синтез речи) ----------
  const synth = window.speechSynthesis;
  let voices = [];

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
    const preferred = ['Microsoft Sonia', 'Microsoft Libby', 'Google UK English Female', 'Microsoft Hazel', 'Microsoft Aria', 'Microsoft Jenny', 'Google US English', 'Microsoft Zira'];
    voices.sort((a, b) => {
      const ia = preferred.findIndex((p) => a.name.includes(p));
      const ib = preferred.findIndex((p) => b.name.includes(p));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
    el.setVoice.innerHTML = '';
    if (!voices.length) {
      el.setVoice.innerHTML = '<option value="">Default voice</option>';
      return;
    }
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      el.setVoice.appendChild(o);
    });
    el.setVoice.value = voices.some((v) => v.name === settings.voice) ? settings.voice : voices[0].name;
  }
  if (synth) {
    loadVoices();
    synth.onvoiceschanged = loadVoices;
  }

  function findVoice(name) {
    return voices.find((v) => v.name === name) || voices[0] || null;
  }

  function splitSentences(text) {
    const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [text];
    // склеиваем слишком короткие куски, длинные — режем по запятым (Chrome обрывает длинные фразы)
    const out = [];
    for (const p of parts) {
      if (p.length > 180) out.push(...p.split(/(?<=,)\s/));
      else if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += p;
      else out.push(p);
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function speakOne(text, token, opts) {
    return new Promise((resolve) => {
      if (!synth || token !== speakToken) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = findVoice(opts.voice);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-GB'; }
      u.rate = Number(opts.rate) || 1;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(guard); resolve(); } };
      // страховка: в некоторых браузерах onend не приходит
      const guard = setTimeout(finish, 2500 + (text.split(' ').length * 520) / u.rate);
      u.onboundary = () => { mouthTarget = 1; };
      u.onend = finish;
      u.onerror = finish;
      speakOne.current = u; // держим ссылку, чтобы Chrome не потерял фразу
      synth.speak(u);
    });
  }

  async function speak(text, opts = { voice: settings.voice, rate: settings.rate }) {
    if (!synth || !text) return false;
    const token = ++speakToken;
    synth.cancel();
    setState('speaking');
    talking = true;
    for (const s of splitSentences(text)) {
      if (token !== speakToken) break;
      await speakOne(s, token, opts);
    }
    if (token === speakToken) {
      talking = false;
      setState('idle');
    }
    return token === speakToken; // true — договорила до конца, не прервали
  }

  function stopSpeaking() {
    speakToken++;
    talking = false;
    if (synth) synth.cancel();
  }

  // ---------- распознавание речи ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function startListening() {
    if (!SR) {
      toast('This browser cannot recognise speech. Please open the app in Google Chrome or Microsoft Edge.', true);
      el.autoMic.checked = false;
      return;
    }
    if (busy || recognitionActive) return;
    if (!apiKey) { openSettings(); toast('Please paste your Groq key first', true); return; }
    stopSpeaking();
    recognition = new SR();
    recognition.lang = settings.recLang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = '';
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      el.input.value = (finalText + interim).trim();
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('No access to the microphone. Allow it in the site settings (the lock icon in the address bar).', true);
        el.autoMic.checked = false;
      } else if (e.error === 'network') {
        toast('Speech recognition is unavailable: no connection to the browser service', true);
      } else if (e.error === 'no-speech') {
        // тишина — просто выходим из режима ожидания и не перезапускаем авто-микрофон
        autoMicPaused = true;
      }
    };
    const rec = recognition;
    rec.onend = () => {
      if (rec !== recognition) return; // устаревший сеанс
      recognitionActive = false;
      if (state === 'listening') setState('idle');
      if (rec._discard) return;        // прервали вручную — ничего не отправляем
      const text = (finalText || el.input.value).trim();
      if (text) sendMessage(text);
    };
    try {
      recognition.start();
      recognitionActive = true;
      autoMicPaused = false;
      el.input.value = '';
      setState('listening');
    } catch {
      recognitionActive = false;
    }
  }

  function stopListening(discard = false) {
    if (recognition && recognitionActive) {
      if (discard) { recognition._discard = true; recognition.onresult = null; recognition.abort(); }
      else recognition.stop();
    }
  }

  let autoMicPaused = false;

  // ---------- ИИ-преподаватель ----------
  function studentTurns() {
    return lesson.messages.filter((m) => m.role === 'student' && m.text !== '[START]').length;
  }

  function currentLesson() {
    return lesson.mode === 'course' ? CUR.lessons.find((l) => l.id === lesson.lessonId) || null : null;
  }

  const TEACHER_INTRO = 'You are Emily, a warm, patient and encouraging English teacher giving a live one-to-one spoken lesson by video call to an adult Russian-speaking student.';
  const NO_MARKUP = '- Never use emojis, markdown, lists or special symbols in the reply: it is read aloud.';
  const WORDS_RULES = '- new_words is the student\'s personal list of words to practise, so keep it very short. Add a word ONLY when (a) the student did not know it: they wrote in Russian, asked how to say something, or used a wrong word and you corrected the word choice (reason "asked" or "mistake"), or (b) you use a word or phrase that is clearly above the student\'s level and they are unlikely to know it (reason "new"). NEVER add basic words that any learner already knows: greetings, yes/no, please, thanks, sorry, numbers, colours, days, family members, or phrases like "my name is", "how are you", "nice to meet you". Most turns must have an empty new_words array; at most 1 word per turn.';
  const WORDS_SHAPE = ' "new_words": [{"word": "English word or phrase", "translation_ru": "перевод", "reason": "asked, mistake or new"}]';
  const CORR_SHAPE = ' "corrections": [{"wrong": "student\'s exact wrong fragment", "right": "corrected fragment", "explain_ru": "короткое объяснение по-русски, 1 предложение"}],';

  function freePrompt() {
    return [
      TEACHER_INTRO,
      `Student level (CEFR): ${settings.level} — ${LEVEL_NOTES[settings.level]}.`,
      `Lesson topic: ${settings.topic}.`,
      '',
      'How to teach:',
      '- Keep each reply short and conversational: 1–3 sentences, like real speech. Usually end with one question so the student keeps talking.',
      '- The student talks much more than you. Do not lecture.',
      '- Adapt vocabulary and grammar strictly to the student level.',
      '- The student\'s words come from speech recognition: ignore missing punctuation, capital letters and obvious recognition glitches. Never correct those.',
      '- Correct real grammar, word choice and word order mistakes. Pick at most the 2 most useful corrections per turn. In your spoken reply you may naturally repeat the correct form, but do not list mistakes in the reply itself.',
      '- If the student writes in Russian or asks how to say something, give the English phrase in the reply and invite them to say it.',
      '- If the message is exactly [START], greet the student by introducing yourself briefly and ask an easy opening question on the topic.',
      WORDS_RULES,
      NO_MARKUP,
      '',
      'Answer ONLY with a JSON object of this exact shape:',
      '{"reply": "what you say aloud, in English",',
      CORR_SHAPE,
      WORDS_SHAPE + '}',
      'Use empty arrays when there are no corrections or no new words.',
    ].join('\n');
  }

  function phaseHint(n) {
    if (n === 0) return 'Phase: opening. Greet the student, say in one very simple sentence what you will practise today, then ask an easy warm-up question.';
    if (n <= 2) return 'Phase: warm-up and presentation. Present the first 2-3 target phrases or words with a short example, and ask the student to repeat or use them.';
    if (n <= 5) return 'Phase: presentation and controlled practice. Present the remaining target language in small steps and ask questions that make the student use it.';
    if (n <= 8) return 'Phase: freer practice. Ask open questions and short role-play prompts that need the target language and the key vocabulary.';
    if (n <= 10) return 'Phase: final speaking task. Run the final speaking task and let the student speak as much as possible.';
    if (n <= 13) return 'Phase: wrap-up. Praise the student, give a one-sentence recap in English, say goodbye and set lesson_done to true.';
    return 'Phase: overtime. Finish immediately: short praise, say goodbye and set lesson_done to true.';
  }

  function coursePrompt(l) {
    const n = studentTurns();
    return [
      TEACHER_INTRO,
      `Student level (CEFR): ${l.level} — ${LEVEL_NOTES[l.level]}.`,
      `This is a structured lesson: "${l.en}".`,
      `Lesson goal: ${l.goal}`,
      `Target language: ${l.language}`,
      `Key vocabulary: ${l.vocab}`,
      `Final speaking task: ${l.task}`,
      '',
      'Rules:',
      '- Speak ONLY English, in short, simple, clear sentences suited to the level. Never use Russian in your reply.',
      '- If the student seems lost, simplify, rephrase, give an example sentence and ask them to repeat it.',
      '- Keep every reply to 1-3 short sentences, like real speech, and end with one question or a small task so the student speaks. The student talks much more than you. Do not lecture.',
      '- Stay on the lesson goal. Do not jump ahead and do not skip the final speaking task.',
      '- If the student writes in Russian or asks how to say something, give the English phrase and invite them to say it.',
      '- The student\'s words come from speech recognition: ignore missing punctuation, capital letters and obvious recognition glitches. Never correct those.',
      '- Correct real mistakes, most of all in the target language. Pick at most the 2 most useful corrections per turn. In your spoken reply you may naturally repeat the correct form, but do not list mistakes in the reply itself.',
      '- Set lesson_done to true only in the reply where you say goodbye, and never before the student has spoken at least 7 times.',
      WORDS_RULES,
      NO_MARKUP,
      '',
      `Student turns so far: ${n}. ${phaseHint(n)}`,
      '',
      'Answer ONLY with a JSON object of this exact shape:',
      '{"reply": "what you say aloud, in English",',
      CORR_SHAPE,
      WORDS_SHAPE + ',',
      ' "lesson_done": false,',
      ' "recap_ru": ""}',
      'Use empty arrays when there are no corrections or no new words. recap_ru: empty until lesson_done is true; then 2-3 short Russian sentences: what the student practised today and one thing to improve.',
    ].join('\n');
  }

  function placementPrompt() {
    const n = studentTurns();
    return [
      TEACHER_INTRO,
      'You are running a short spoken placement conversation to estimate the student\'s CEFR level (A1, A2, B1, B2 or C1).',
      'Speak English in short, clear sentences. Ask exactly 6 questions, ONE per turn, in this order of difficulty:',
      '1) their name and where they are from (A1); 2) their daily routine (A1-A2); 3) what they did last weekend (A2); 4) a trip or an experience they have had (B1); 5) their opinion about something, with a reason, for example advantages and disadvantages of remote work (B1-B2); 6) a hypothetical or abstract question, for example what they would change in the world if they could (B2-C1).',
      'Do not teach or correct during the test: always return empty corrections and new_words arrays. React briefly and naturally to each answer before the next question.',
      'If the student clearly cannot answer even the first two questions in simple English, stop early and give the verdict A1.',
      NO_MARKUP,
      '',
      n === 0
        ? 'Now: greet the student, say in one simple sentence that you will ask a few questions to find their level, and ask question 1.'
        : n < 6
          ? `The student has answered ${n} question${n === 1 ? '' : 's'}. Now ask question ${n + 1}.`
          : 'The student has answered all 6 questions. Now give the verdict: thank them warmly in 1-2 simple sentences, tell them their level in English and set "level".',
      '',
      'Answer ONLY with a JSON object of this exact shape:',
      '{"reply": "what you say aloud, in English", "corrections": [], "new_words": [], "level": ""}',
      '"level" must stay an empty string until the verdict; in the verdict it is exactly one of A1, A2, B1, B2, C1.',
    ].join('\n');
  }

  function systemPrompt() {
    if (lesson.mode === 'placement') return placementPrompt();
    const l = currentLesson();
    return l ? coursePrompt(l) : freePrompt();
  }

  function buildMessages() {
    const history = lesson.messages
      .filter((m) => m.role === 'teacher' || m.role === 'student')
      .slice(-HISTORY_LIMIT)
      .map((m) => (
        m.role === 'teacher'
          ? { role: 'assistant', content: JSON.stringify({ reply: m.text, corrections: [], new_words: [] }) }
          : { role: 'user', content: m.text }
      ));
    return [{ role: 'system', content: systemPrompt() }, ...history];
  }

  class ApiError extends Error {
    constructor(msg, status) { super(msg); this.status = status; }
  }

  async function callGroq(messages, useJsonMode = true) {
    const body = {
      model: settings.model,
      messages,
      temperature: 0.7,
      max_completion_tokens: 700,
    };
    if (useJsonMode) body.response_format = { type: 'json_object' };
    if (settings.model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Cannot reach Groq. Check your internet connection (the service is not available from Russia).', 0);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      if (res.status === 401) throw new ApiError('The Groq key was not accepted. Check it in Settings.', 401);
      if (res.status === 403) throw new ApiError('Groq refused access (possibly because of your region).', 403);
      if (res.status === 429) {
        const wait = res.headers.get('retry-after') || (detail.match(/try again in ([\d.]+)s/i) || [])[1];
        throw new ApiError(wait
          ? `The free per-minute limit is used up. Wait ~${Math.ceil(Number(wait))} s and try again.`
          : 'The free limit is used up. Wait a little and try again.', 429);
      }
      if (res.status === 400 && useJsonMode && /json/i.test(detail)) {
        return callGroq(messages, false); // модель не уложилась в JSON — пробуем без строгого режима
      }
      throw new ApiError(`Groq error (${res.status})${detail ? ': ' + detail : ''}`, res.status);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  function parseTeacher(raw) {
    const clean = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    let obj = null;
    try { obj = JSON.parse(clean); } catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch { /* ignore */ } }
    }
    if (!obj || typeof obj.reply !== 'string') {
      return { reply: clean || 'Sorry, could you say that again?', corrections: [], new_words: [], lesson_done: false, recap_ru: '', level: '' };
    }
    const corrections = Array.isArray(obj.corrections) ? obj.corrections
      .filter((c) => c && c.wrong && c.right && String(c.wrong).trim().toLowerCase() !== String(c.right).trim().toLowerCase())
      .slice(0, 3) : [];
    const newWords = Array.isArray(obj.new_words) ? obj.new_words
      .filter((w) => w && w.word && w.translation_ru)
      .map((w) => ({ ...w, reason: typeof w.reason === 'string' ? w.reason.trim().toLowerCase() : '' }))
      .slice(0, 2) : [];
    const lvl = typeof obj.level === 'string' ? obj.level.trim().toUpperCase() : '';
    return {
      reply: obj.reply.trim(),
      corrections,
      new_words: newWords,
      lesson_done: obj.lesson_done === true || obj.lesson_done === 'true',
      recap_ru: typeof obj.recap_ru === 'string' ? obj.recap_ru.trim() : '',
      level: ['A1', 'A2', 'B1', 'B2', 'C1'].includes(lvl) ? lvl : '',
    };
  }

  async function sendMessage(text, { hidden = false } = {}) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!apiKey) { openSettings(); toast('Please paste your Groq key first', true); return; }

    stopSpeaking();
    el.input.value = '';
    const studentMsg = { role: 'student', text };
    if (!hidden) { lesson.messages.push(studentMsg); renderMessage(studentMsg); }
    else lesson.messages.push(studentMsg);
    saveLesson();
    updateLessonBar();

    busy = true;
    setState('thinking');
    try {
      const raw = await callGroq(buildMessages());
      const t = parseTeacher(raw);
      if (!hidden && t.corrections.length) {
        studentMsg.corrections = t.corrections;
        renderCorrections(studentMsg);
      }
      const teacherMsg = { role: 'teacher', text: t.reply };
      lesson.messages.push(teacherMsg);
      saveLesson();
      renderMessage(teacherMsg);
      addWords(t.new_words);
      let ended = false;
      if (lesson.mode === 'course' && t.lesson_done && studentTurns() >= MIN_TURNS_TO_FINISH) {
        completeLesson(t.recap_ru);
        ended = true;
      } else if (lesson.mode === 'placement' && t.level && studentTurns() >= 3) {
        finishPlacement(t.level);
        ended = true;
      }
      busy = false;
      setState('idle');
      const finished = await speak(t.reply);
      if (finished && el.autoMic.checked && !autoMicPaused && !ended) startListening();
    } catch (err) {
      busy = false;
      setState('idle');
      // убираем неотвеченную реплику из истории, чтобы её можно было повторить
      const idx = lesson.messages.lastIndexOf(studentMsg);
      if (idx >= 0) lesson.messages.splice(idx, 1);
      saveLesson();
      updateLessonBar();
      if (!hidden) {
        removeLastStudentBubble();
        el.input.value = text;
      }
      systemNote(err.message || 'Something went wrong', true);
      if (err.status === 401) openSettings();
    }
  }

  // ---------- отрисовка ----------
  function systemNote(text, isError = false) {
    const d = document.createElement('div');
    d.className = 'system-note' + (isError ? ' error' : '');
    d.textContent = text;
    el.chat.appendChild(d);
    scrollChat();
  }

  function renderMessage(m) {
    if (m.text === '[START]') return; // служебная команда начала урока — не показываем
    if (m.role === 'note') {
      const card = document.createElement('div');
      card.className = 'note-card';
      if (m.kind === 'recap') {
        const h = document.createElement('div'); h.className = 'note-title'; h.textContent = 'Lesson summary';
        card.appendChild(h);
      }
      const p = document.createElement('div'); p.textContent = m.text;
      card.appendChild(p);
      m._el = card;
      el.chat.appendChild(card);
      scrollChat();
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.text;
    wrap.appendChild(b);
    if (m.role === 'teacher') {
      const tools = document.createElement('div');
      tools.className = 'msg-tools';
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'icon-btn';
      again.textContent = 'Retry';
      again.onclick = () => { stopListening(true); speak(m.text); };
      tools.appendChild(again);
      wrap.appendChild(tools);
    }
    m._el = wrap;
    el.chat.appendChild(wrap);
    if (m.corrections) renderCorrections(m);
    scrollChat();
  }

  function renderCorrections(m) {
    if (!m._el) return;
    m._el.querySelectorAll('.fix').forEach((f) => f.remove());
    m.corrections.forEach((c) => {
      const f = document.createElement('div');
      f.className = 'fix';
      const line = document.createElement('div');
      const w = document.createElement('span'); w.className = 'wrong'; w.textContent = c.wrong;
      const r = document.createElement('span'); r.className = 'right'; r.textContent = c.right;
      line.append(w, ' → ', r);
      f.appendChild(line);
      if (c.explain_ru) {
        const why = document.createElement('div'); why.className = 'why'; why.textContent = c.explain_ru;
        f.appendChild(why);
      }
      m._el.appendChild(f);
    });
    scrollChat();
  }

  function removeLastStudentBubble() {
    const all = el.chat.querySelectorAll('.msg.student');
    const last = all[all.length - 1];
    if (last) last.remove();
  }

  function scrollChat() { el.chat.scrollTop = el.chat.scrollHeight; }

  function renderChat() {
    el.chat.innerHTML = '';
    lesson.messages.forEach(renderMessage);
  }

  function saveLesson() {
    store.set(LS.lesson, {
      mode: lesson.mode,
      lessonId: lesson.lessonId,
      messages: lesson.messages.map(({ _el, ...m }) => m),
    });
  }

  function saveProgress() { return store.set(LS.progress, progress); }

  // ---------- слова ----------
  // Совсем базовые слова и фразы никогда не попадают в список, даже если ИИ их предложил.
  const TRIVIAL_WORDS = new Set([
    'hello', 'hi', 'hey', 'bye', 'goodbye', 'good morning', 'good afternoon', 'good evening', 'good night',
    'yes', 'no', 'ok', 'okay', 'please', 'thanks', 'thank you', 'thank you very much', 'sorry', 'excuse me',
    'fine', 'good', 'bad', 'great', 'nice', 'well', 'very', 'and', 'or', 'but', 'the', 'a', 'an',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'is', 'am', 'are', 'my', 'your',
    'my name is', "i'm", 'i am', 'i am fine', "i'm fine", 'nice to meet you', 'how are you', 'see you', 'see you later',
    'what is your name', "what's your name", 'name', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'red', 'blue', 'green', 'black', 'white', 'yellow', 'mother', 'father', 'sister', 'brother', 'family', 'friend',
  ]);
  const normWord = (w) => String(w).toLowerCase().replace(/[.,!?;:"“”]/g, '').replace(/\s+/g, ' ').trim();

  function addWords(list) {
    if (!list || !list.length) return;
    let added = 0;
    list.forEach((w) => {
      const word = String(w.word).trim();
      if (!word || TRIVIAL_WORDS.has(normWord(word))) return;
      if (words.some((x) => x.word.toLowerCase() === word.toLowerCase())) return;
      words.unshift({ word, translation: String(w.translation_ru).trim(), reason: w.reason || '' });
      added++;
    });
    if (added) { store.set(LS.words, words); renderWords(); }
  }

  function renderWords() {
    el.wordsCount.textContent = words.length;
    el.wordsList.innerHTML = '';
    el.clearWords.disabled = !words.length;
    if (!words.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing here yet';
      el.wordsList.appendChild(li);
      return;
    }
    words.forEach((w) => {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const a = document.createElement('span'); a.className = 'w'; a.textContent = w.word;
      const t = document.createElement('span'); t.className = 't'; t.textContent = ' — ' + w.translation;
      left.append(a, t);
      const say = document.createElement('button');
      say.type = 'button'; say.className = 'icon-btn'; say.textContent = 'Say it';
      say.onclick = () => speak(w.word);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'icon-btn danger'; del.textContent = 'Remove';
      del.onclick = async () => {
        if (!(await confirmAction(`Remove the word “${w.word}” from the list?`, 'Remove'))) return;
        const i = words.indexOf(w);
        if (i < 0) return;
        words.splice(i, 1);
        const ok = store.set(LS.words, words);
        renderWords();
        toast(ok ? 'Word removed' : 'Could not save the word list in this browser', !ok);
      };
      const actions = document.createElement('div');
      actions.className = 'word-actions';
      actions.append(say, del);
      li.append(left, actions);
      el.wordsList.appendChild(li);
    });
  }

  // ---------- настройки ----------
  function openSettings() {
    el.setKey.value = apiKey;
    el.setKey.type = 'password';
    el.showKey.textContent = 'Show';
    el.setLevel.value = settings.level;
    el.setTopic.value = settings.topic;
    el.setRate.value = settings.rate;
    el.rateVal.textContent = Number(settings.rate).toFixed(2);
    el.setRecLang.value = settings.recLang;
    el.setModel.value = settings.model;
    loadVoices();
    el.deleteKey.disabled = !apiKey;
    if (!el.dlg.open) el.dlg.showModal();
  }

  function readSettingsForm() {
    return {
      ...settings,
      level: el.setLevel.value,
      topic: el.setTopic.value,
      voice: el.setVoice.value,
      rate: Number(el.setRate.value),
      recLang: el.setRecLang.value,
      model: el.setModel.value,
    };
  }

  function saveSettingsFromForm() {
    const key = el.setKey.value.trim();
    if (key && !/^gsk_\S{10,}$/.test(key)) {
      toast('The key looks incomplete: it should start with gsk_', true);
      el.setKey.focus();
      return;
    }
    const prevLevelTopic = settings.level + '|' + settings.topic;
    settings = readSettingsForm();
    apiKey = key;
    const ok = store.set(LS.settings, settings) && store.set(LS.key, apiKey);
    el.dlg.close();
    toast(ok ? 'Settings saved' : 'Could not save the settings in this browser', !ok);
    if (ok && apiKey && prevLevelTopic !== settings.level + '|' + settings.topic && lesson.messages.length && lesson.mode === 'free') {
      systemNote('The new level or topic will apply from the next message');
    }
  }

  // ---------- программа и уроки ----------
  const levelIdx = (lv) => CUR.levels.indexOf(lv);
  const lessonsOf = (lv) => CUR.lessons.filter((l) => l.level === lv);

  function isLessonOpen(l) {
    if (progress.done[l.id]) return true;
    const list = lessonsOf(l.level);
    const i = list.findIndex((x) => x.id === l.id);
    if (i > 0) return !!progress.done[list[i - 1].id];
    const li = levelIdx(l.level);
    if (li <= 0) return true;                                        // первый урок A1 открыт всегда
    if (progress.placed && li <= levelIdx(progress.placed)) return true; // уровень выбран вручную или по вводному разговору
    const prev = lessonsOf(CUR.levels[li - 1]);
    return prev.length ? !!progress.done[prev[prev.length - 1].id] : true;
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    ['program', 'chat', 'words'].forEach((n) => $('tab-' + n).classList.toggle('hidden', n !== name));
  }

  function renderProgram() {
    el.levelChips.innerHTML = '';
    CUR.levels.forEach((lv) => {
      const list = lessonsOf(lv);
      const doneCount = list.filter((l) => progress.done[l.id]).length;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (lv === viewLevel ? ' active' : '');
      b.dataset.level = lv;
      b.textContent = `${lv} · ${doneCount}/${list.length}`;
      b.onclick = () => { viewLevel = lv; renderProgram(); };
      el.levelChips.appendChild(b);
    });

    const list = lessonsOf(viewLevel);
    el.levelStart.innerHTML = '';
    if (list.length && !isLessonOpen(list[0])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = 'btnStartLevel';
      b.className = 'btn ghost small';
      b.textContent = `Start from level ${viewLevel}`;
      b.onclick = () => startFromLevel(viewLevel);
      el.levelStart.appendChild(b);
    }

    el.lessonsList.innerHTML = '';
    list.forEach((l) => {
      const open = isLessonOpen(l);
      const done = !!progress.done[l.id];
      const active = lesson.mode === 'course' && lesson.lessonId === l.id;
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = l.id;
      b.className = 'lesson-item' + (done ? ' done' : '') + (!open ? ' locked' : '') + (active ? ' active' : '');
      b.disabled = !open;
      const num = document.createElement('span'); num.className = 'lesson-num'; num.textContent = String(l.n);
      const txt = document.createElement('span'); txt.className = 'lesson-text';
      const en = document.createElement('span'); en.className = 'lesson-ru'; en.textContent = l.en;
      txt.append(en);
      const st = document.createElement('span'); st.className = 'lesson-status';
      st.textContent = active ? 'In progress' : done ? 'Completed' : open ? 'Start' : 'Locked';
      b.append(num, txt, st);
      b.onclick = () => openLesson(l.id);
      li.appendChild(b);
      el.lessonsList.appendChild(li);
    });
  }

  function updateLessonBar() {
    const l = currentLesson();
    const placement = lesson.mode === 'placement';
    el.lessonBar.classList.toggle('hidden', !l && !placement);
    if (l) el.lessonBarTitle.textContent = `${l.level} · Lesson ${l.n}: ${l.en}`;
    else if (placement) el.lessonBarTitle.textContent = 'Placement chat';
    el.btnFinish.classList.toggle('hidden', !l);
    el.btnFinish.disabled = !l || studentTurns() < MIN_TURNS_MANUAL;
  }

  function startFromLevel(level) {
    progress.placed = level;
    settings.level = level;
    store.set(LS.settings, settings);
    const ok = saveProgress();
    renderProgram();
    toast(ok ? `Level ${level} unlocked` : 'Could not save your progress in this browser', !ok);
  }

  async function beginSession(next, confirmText, yesLabel) {
    if (busy) return;
    if (!apiKey) { openSettings(); toast('Please paste your Groq key first', true); return; }
    if (lesson.messages.length) {
      if (!(await confirmAction(confirmText, yesLabel))) return;
      if (busy) return;
    }
    stopListening(true);
    stopSpeaking();
    lesson = { messages: [], mode: next.mode, lessonId: next.lessonId || null };
    saveLesson();
    renderChat();
    renderProgram();
    updateLessonBar();
    showTab('chat');
    autoMicPaused = false;
    sendMessage('[START]', { hidden: true });
  }

  function newLesson() {
    return beginSession({ mode: 'free' },
      'Start a new lesson? The current conversation will be deleted (the words in “My words” stay).', 'Start new')
      .then(() => { if (lesson.mode === 'free' && lesson.messages.length) toast('New lesson started'); });
  }

  function startPlacement() {
    return beginSession({ mode: 'placement' },
      'Start the placement chat? The current conversation will be deleted.', 'Start');
  }

  async function openLesson(id) {
    if (busy) return;
    const l = CUR.lessons.find((x) => x.id === id);
    if (!l || !isLessonOpen(l)) return;
    if (lesson.mode === 'course' && lesson.lessonId === id && lesson.messages.length) { showTab('chat'); return; }
    await beginSession({ mode: 'course', lessonId: id },
      `Start the lesson “${l.en}”? The current conversation will be deleted (your words and completed lessons stay).`, 'Start');
  }

  function completeLesson(recapRu) {
    const id = lesson.lessonId;
    if (id) progress.done[id] = { at: new Date().toISOString() };
    const ok = saveProgress();
    const note = { role: 'note', kind: 'recap', text: recapRu || 'Lesson completed' };
    lesson.messages.push(note);
    lesson.mode = 'free';
    lesson.lessonId = null;
    saveLesson();
    renderMessage(note);
    renderProgram();
    updateLessonBar();
    toast(ok ? 'Lesson completed' : 'Could not save your progress in this browser', !ok);
  }

  function finishPlacement(level) {
    const start = CUR.levels.includes(level) ? level : CUR.levels[CUR.levels.length - 1];
    progress.placed = start;
    settings.level = level;
    store.set(LS.settings, settings);
    const ok = saveProgress();
    const note = { role: 'note', kind: 'level', text: `Your level: ${level}` };
    lesson.messages.push(note);
    lesson.mode = 'free';
    lesson.lessonId = null;
    saveLesson();
    renderMessage(note);
    viewLevel = start;
    renderProgram();
    updateLessonBar();
    toast(ok ? `Level set: ${level}` : 'Could not save your progress in this browser', !ok);
  }

  // ---------- события ----------
  el.mic.addEventListener('click', () => {
    if (recognitionActive) stopListening(false);
    else { autoMicPaused = false; startListening(); }
  });
  el.stop.addEventListener('click', () => {
    autoMicPaused = true;
    if (recognitionActive) el.input.value = '';
    stopListening(true);
    stopSpeaking();
    if (!busy) setState('idle');
  });
  el.autoMic.addEventListener('change', () => {
    settings.autoMic = el.autoMic.checked;
    store.set(LS.settings, settings);
    toast(settings.autoMic ? 'Auto-mic on' : 'Auto-mic off');
  });
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value;
    stopListening(true);
    sendMessage(text);
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  el.btnPlacement.addEventListener('click', startPlacement);
  el.btnFinish.addEventListener('click', async () => {
    if (busy || lesson.mode !== 'course' || studentTurns() < MIN_TURNS_MANUAL) return;
    if (!(await confirmAction('Finish the lesson and mark it as completed?', 'Finish'))) return;
    if (busy || lesson.mode !== 'course') return;
    autoMicPaused = true;
    stopListening(true);
    stopSpeaking();
    completeLesson('');
    setState('idle');
  });

  el.clearWords.addEventListener('click', async () => {
    if (!words.length) return;
    if (!(await confirmAction(`Delete all words from the list (${words.length})?`, 'Delete'))) return;
    words = [];
    store.set(LS.words, words);
    renderWords();
    toast('Word list cleared');
  });

  el.newLesson.addEventListener('click', newLesson);
  el.btnSettings.addEventListener('click', openSettings);
  el.cancelSettings.addEventListener('click', () => el.dlg.close());
  el.saveSettings.addEventListener('click', saveSettingsFromForm);
  el.setKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSettingsFromForm(); } });
  el.showKey.addEventListener('click', () => {
    const hidden = el.setKey.type === 'password';
    el.setKey.type = hidden ? 'text' : 'password';
    el.showKey.textContent = hidden ? 'Hide' : 'Show';
  });
  el.setRate.addEventListener('input', () => { el.rateVal.textContent = Number(el.setRate.value).toFixed(2); });
  el.testVoice.addEventListener('click', () => {
    speak("Hello! I'm Emily, your English teacher. Shall we begin?",
      { voice: el.setVoice.value, rate: Number(el.setRate.value) });
  });
  el.deleteKey.addEventListener('click', async () => {
    if (!apiKey) return;
    el.dlg.close();
    const ok = await confirmAction('Delete the Groq key from this browser?', 'Delete');
    if (ok) {
      apiKey = '';
      store.del(LS.key);
      toast('Key deleted');
    }
    openSettings();
  });

  window.addEventListener('beforeunload', () => { if (synth) synth.cancel(); });

  // ---------- запуск ----------
  el.autoMic.checked = !!settings.autoMic;
  renderChat();
  renderWords();
  renderProgram();
  updateLessonBar();
  setState('idle');
  showTab(lesson.messages.length ? 'chat' : 'program');
  if (!SR) systemNote('Voice input works in Google Chrome and Microsoft Edge. Here you can type instead.');
  if (!apiKey) openSettings();

  // для автотестов
  window.__tutor = {
    parseTeacher, splitSentences, studentTurns, isLessonOpen, addWords,
    get state() { return state; }, get lesson() { return lesson; }, get progress() { return progress; },
  };
})();
