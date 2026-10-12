/* English Tutor — первая версия.
   Мозг: Groq (OpenAI-совместимый API). Голос и распознавание — средства браузера.
   Ключ хранится только в браузере (localStorage) и никогда не попадает в код/GitHub. */
(() => {
  'use strict';

  const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const HISTORY_LIMIT = 14;          // сколько последних реплик отправлять ИИ (бережём лимит токенов)
  const LS = {
    settings: 'et_settings_v1',
    key: 'et_groq_key_v1',
    lesson: 'et_lesson_v1',
    words: 'et_words_v1',
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
  let lesson = store.get(LS.lesson, { messages: [] }); // {role:'teacher'|'student', text, corrections?, words?}
  let words = store.get(LS.words, []);                  // {word, translation}

  // ---------- элементы ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    avatarWrap: $('avatarWrap'), statePill: $('statePill'),
    mic: $('btnMic'), stop: $('btnStop'), autoMic: $('autoMic'),
    chat: $('chat'), composer: $('composer'), input: $('textInput'), send: $('btnSend'),
    wordsList: $('wordsList'), wordsCount: $('wordsCount'), clearWords: $('btnClearWords'),
    newLesson: $('btnNewLesson'), btnSettings: $('btnSettings'),
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
    idle: 'Готова к уроку',
    listening: 'Слушаю…',
    thinking: 'Думаю…',
    speaking: 'Говорю…',
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

  function confirmAction(text, yesLabel = 'Да') {
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
    el.lids.forEach((l) => l.setAttribute('height', '26'));
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
      el.setVoice.innerHTML = '<option value="">Голос по умолчанию</option>';
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
      toast('Этот браузер не умеет распознавать речь. Откройте приложение в Google Chrome или Microsoft Edge.', true);
      el.autoMic.checked = false;
      return;
    }
    if (busy || recognitionActive) return;
    if (!apiKey) { openSettings(); toast('Сначала вставьте ключ Groq', true); return; }
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
        toast('Нет доступа к микрофону. Разрешите его в настройках сайта (значок замка в адресной строке).', true);
        el.autoMic.checked = false;
      } else if (e.error === 'network') {
        toast('Распознавание речи недоступно: нет связи с сервисом браузера', true);
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
  function systemPrompt() {
    return [
      'You are Emily, a warm, patient and encouraging English teacher giving a live one-to-one spoken lesson by video call to an adult Russian-speaking student.',
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
      '- Never use emojis, markdown, lists or special symbols in the reply: it is read aloud.',
      '',
      'Answer ONLY with a JSON object of this exact shape:',
      '{"reply": "what you say aloud, in English",',
      ' "corrections": [{"wrong": "student\'s exact wrong fragment", "right": "corrected fragment", "explain_ru": "короткое объяснение по-русски, 1 предложение"}],',
      ' "new_words": [{"word": "useful English word or phrase from your reply", "translation_ru": "перевод"}]}',
      'Use empty arrays when there are no corrections or no new words. new_words: at most 2 items, only words likely new for this level.',
    ].join('\n');
  }

  function buildMessages() {
    const history = lesson.messages.slice(-HISTORY_LIMIT).map((m) => (
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
      throw new ApiError('Нет связи с Groq. Проверьте интернет (из России сервис недоступен).', 0);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      if (res.status === 401) throw new ApiError('Ключ Groq не подошёл. Проверьте его в настройках.', 401);
      if (res.status === 403) throw new ApiError('Groq отказал в доступе (возможно, из-за региона).', 403);
      if (res.status === 429) {
        const wait = res.headers.get('retry-after') || (detail.match(/try again in ([\d.]+)s/i) || [])[1];
        throw new ApiError(wait
          ? `Бесплатный лимит на минуту исчерпан. Подождите ~${Math.ceil(Number(wait))} сек. и повторите.`
          : 'Бесплатный лимит исчерпан. Подождите немного и повторите.', 429);
      }
      if (res.status === 400 && useJsonMode && /json/i.test(detail)) {
        return callGroq(messages, false); // модель не уложилась в JSON — пробуем без строгого режима
      }
      throw new ApiError(`Ошибка Groq (${res.status})${detail ? ': ' + detail : ''}`, res.status);
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
      return { reply: clean || 'Sorry, could you say that again?', corrections: [], new_words: [] };
    }
    const corrections = Array.isArray(obj.corrections) ? obj.corrections
      .filter((c) => c && c.wrong && c.right && String(c.wrong).trim().toLowerCase() !== String(c.right).trim().toLowerCase())
      .slice(0, 3) : [];
    const newWords = Array.isArray(obj.new_words) ? obj.new_words
      .filter((w) => w && w.word && w.translation_ru).slice(0, 3) : [];
    return { reply: obj.reply.trim(), corrections, new_words: newWords };
  }

  async function sendMessage(text, { hidden = false } = {}) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!apiKey) { openSettings(); toast('Сначала вставьте ключ Groq', true); return; }

    stopSpeaking();
    el.input.value = '';
    const studentMsg = { role: 'student', text };
    if (!hidden) { lesson.messages.push(studentMsg); renderMessage(studentMsg); }
    else lesson.messages.push(studentMsg);
    saveLesson();

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
      busy = false;
      setState('idle');
      const finished = await speak(t.reply);
      if (finished && el.autoMic.checked && !autoMicPaused) startListening();
    } catch (err) {
      busy = false;
      setState('idle');
      // убираем неотвеченную реплику из истории, чтобы её можно было повторить
      const idx = lesson.messages.lastIndexOf(studentMsg);
      if (idx >= 0) lesson.messages.splice(idx, 1);
      saveLesson();
      if (!hidden) {
        removeLastStudentBubble();
        el.input.value = text;
      }
      systemNote(err.message || 'Что-то пошло не так', true);
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
      again.textContent = 'Повторить';
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
    store.set(LS.lesson, { messages: lesson.messages.map(({ _el, ...m }) => m) });
  }

  // ---------- слова ----------
  function addWords(list) {
    if (!list || !list.length) return;
    let added = 0;
    list.forEach((w) => {
      const word = String(w.word).trim();
      if (!word || words.some((x) => x.word.toLowerCase() === word.toLowerCase())) return;
      words.unshift({ word, translation: String(w.translation_ru).trim() });
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
      li.textContent = 'Пока пусто';
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
      say.type = 'button'; say.className = 'icon-btn'; say.textContent = 'Произнести';
      say.onclick = () => speak(w.word);
      li.append(left, say);
      el.wordsList.appendChild(li);
    });
  }

  // ---------- настройки ----------
  function openSettings() {
    el.setKey.value = apiKey;
    el.setKey.type = 'password';
    el.showKey.textContent = 'Показать';
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
      toast('Похоже, ключ вставлен не полностью: он должен начинаться с gsk_', true);
      el.setKey.focus();
      return;
    }
    const prevLevelTopic = settings.level + '|' + settings.topic;
    settings = readSettingsForm();
    apiKey = key;
    const ok = store.set(LS.settings, settings) && store.set(LS.key, apiKey);
    el.dlg.close();
    toast(ok ? 'Настройки сохранены' : 'Не удалось сохранить настройки в браузере', !ok);
    if (ok && apiKey && prevLevelTopic !== settings.level + '|' + settings.topic && lesson.messages.length) {
      systemNote('Новый уровень или тема применятся со следующей реплики');
    }
  }

  // ---------- новый урок ----------
  async function newLesson() {
    if (busy) return;
    if (lesson.messages.length) {
      const ok = await confirmAction('Начать новый урок? Текущий диалог будет удалён (слова в «Моих словах» останутся).', 'Начать новый');
      if (!ok) return;
    }
    stopListening(true);
    stopSpeaking();
    lesson = { messages: [] };
    saveLesson();
    renderChat();
    toast('Новый урок начат');
    startLesson();
  }

  function startLesson() {
    if (!apiKey) { openSettings(); return; }
    autoMicPaused = false;
    sendMessage('[START]', { hidden: true });
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
    toast(settings.autoMic ? 'Авто-микрофон включён' : 'Авто-микрофон выключен');
  });
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value;
    stopListening(true);
    sendMessage(text);
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('tab-chat').classList.toggle('hidden', t.dataset.tab !== 'chat');
    $('tab-words').classList.toggle('hidden', t.dataset.tab !== 'words');
  }));

  el.clearWords.addEventListener('click', async () => {
    if (!words.length) return;
    if (!(await confirmAction(`Удалить все слова из списка (${words.length})?`, 'Удалить'))) return;
    words = [];
    store.set(LS.words, words);
    renderWords();
    toast('Список слов очищен');
  });

  el.newLesson.addEventListener('click', newLesson);
  el.btnSettings.addEventListener('click', openSettings);
  el.cancelSettings.addEventListener('click', () => el.dlg.close());
  el.saveSettings.addEventListener('click', saveSettingsFromForm);
  el.setKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSettingsFromForm(); } });
  el.showKey.addEventListener('click', () => {
    const hidden = el.setKey.type === 'password';
    el.setKey.type = hidden ? 'text' : 'password';
    el.showKey.textContent = hidden ? 'Скрыть' : 'Показать';
  });
  el.setRate.addEventListener('input', () => { el.rateVal.textContent = Number(el.setRate.value).toFixed(2); });
  el.testVoice.addEventListener('click', () => {
    speak("Hello! I'm Emily, your English teacher. Shall we begin?",
      { voice: el.setVoice.value, rate: Number(el.setRate.value) });
  });
  el.deleteKey.addEventListener('click', async () => {
    if (!apiKey) return;
    el.dlg.close();
    const ok = await confirmAction('Удалить ключ Groq из этого браузера?', 'Удалить');
    if (ok) {
      apiKey = '';
      store.del(LS.key);
      toast('Ключ удалён');
    }
    openSettings();
  });

  window.addEventListener('beforeunload', () => { if (synth) synth.cancel(); });

  // ---------- запуск ----------
  el.autoMic.checked = !!settings.autoMic;
  renderChat();
  renderWords();
  setState('idle');
  if (!SR) systemNote('Голосовой ввод работает в Google Chrome и Microsoft Edge. Здесь можно писать текстом.');
  if (!apiKey) {
    openSettings();
  } else if (!lesson.messages.length) {
    systemNote('Нажмите «Новый урок», чтобы начать');
  }

  // для автотестов
  window.__tutor = { parseTeacher, splitSentences, get state() { return state; }, get lesson() { return lesson; } };
})();
