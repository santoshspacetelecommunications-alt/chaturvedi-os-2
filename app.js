'use strict';

/* ══════════════════════════════════════════════════════════
   CONFIG
   No AI provider keys here. Ever. They live server-side in
   /api/chat.js and /api/search.js as environment variables.

   APP_SECRET is a soft anti-abuse layer, not real security:
   it stops random bots from finding /api/chat and burning
   your quota. Change it anytime — just keep this value and
   the Vercel env var of the same name in sync.

   Supabase's key below is meant to be public. It's protected
   by row-level security policies on the database side, not
   by secrecy. That's the correct way to use it.
   ══════════════════════════════════════════════════════════ */
const APP_SECRET = "chaturvedi-secret-2026";
const SB_URL = "https://pitbpuiqlgtrndwfgmjb.supabase.co";
const SB_KEY = "sb_publishable_CtW-ucEpfrBZ62Ln2Q9R6Q_ORA30JLB";

if (window.marked) marked.setOptions({ breaks: true, gfm: true });

/* ══════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════ */
let history = [];
let busy = false;
let voiceOn = true;
let theme = 'dark';
let listening = false;
let recognition = null;
let pendingAttachments = [];
let sbClient = null;
let sbReady = false;

/* ══════════════════════════════════════════════════════════
   BACKEND CALLS — the only network calls that carry secrets
   go through these two functions, and the secrets never
   leave the server.
   ══════════════════════════════════════════════════════════ */
async function askAI(messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chaturvedi-Key': APP_SECRET },
    body: JSON.stringify({ messages: messages })
  });
  if (!res.ok) throw new Error('backend_http_' + res.status);
  const data = await res.json();
  if (!data.reply) throw new Error('backend_empty_reply');
  return data.reply;
}

async function liveContext(text) {
  if (!LIVE_PATTERN.test(text)) return '';
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chaturvedi-Key': APP_SECRET },
      body: JSON.stringify({ query: text })
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.context || '';
  } catch (e) {
    return '';
  }
}

/* ══════════════════════════════════════════════════════════
   LIVE-SEARCH TRIGGER — only used to decide WHETHER to ask
   the backend for context, no keys involved here
   ══════════════════════════════════════════════════════════ */
const LIVE_PATTERN = /\b(latest|current|currently|today|right now|this week|this month|this year|2025|2026|price of|stock price|score|who won|scores|standings|breaking news|news about|weather in)\b/i;

/* ══════════════════════════════════════════════════════════
   QUICK MATH — instant compute for clean expressions
   ══════════════════════════════════════════════════════════ */
function quickMath(text) {
  const t = text.trim();
  if (t.length > 50) return null;
  if (!/\d/.test(t)) return null;
  if (!/[+\-*/^%]/.test(t) && !/^(what is|calculate|compute)/i.test(t)) return null;
  if (!/^[\d\s+\-*/^().,%a-zA-Z]+\??$/.test(t)) return null;
  if (!window.math) return null;
  try {
    const cleaned = t.replace(/^(what is|calculate|compute|solve)\s*/i, '').replace(/\^/g, '**').replace(/\?\s*$/, '');
    const val = math.evaluate(cleaned);
    if (typeof val === 'number' && isFinite(val)) {
      return Number.isInteger(val) ? String(val) : String(Number(val.toPrecision(10)));
    }
  } catch (e) {}
  return null;
}

/* ══════════════════════════════════════════════════════════
   IMAGE GENERATION — Pollinations is public and keyless,
   no secret needed, correctly stays client-side
   ══════════════════════════════════════════════════════════ */
const IMAGE_PATTERN = /\b(draw|sketch|generate (an|a) image( of)?|create (an|a) (image|picture|photo|illustration)( of)?|picture of|paint(ing)? of|render (an|a) image)\b/i;

function isImageIntent(text) { return IMAGE_PATTERN.test(text); }

function buildImageUrl(text) {
  const clean = text.replace(IMAGE_PATTERN, '').replace(/^\s*of\s+/i, '').trim() || text;
  const enhanced = clean + ', highly detailed, beautiful lighting, professional quality';
  let w = 1024, h = 1024;
  if (/\b(wide|landscape|panoramic)\b/i.test(text)) { w = 1344; h = 768; }
  else if (/\b(tall|portrait|vertical)\b/i.test(text)) { w = 768; h = 1344; }
  const seed = Math.floor(Math.random() * 1000000);
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(enhanced)
    + '?width=' + w + '&height=' + h + '&seed=' + seed + '&model=flux&nologo=true';
  return { url: url, clean: clean, seed: seed };
}

/* ══════════════════════════════════════════════════════════
   SYSTEM PROMPT — sent to backend, backend forwards to model
   ══════════════════════════════════════════════════════════ */
function systemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return "You are Chaturvedi, a personal AI assistant created by Raunak Chaturvedi. If asked who made you or who you belong to, say Raunak Chaturvedi built you \u2014 never mention any other company. Address the person as \"buddy\" naturally, not in every sentence.\n\n"
    + "Be direct and genuinely useful. Match your depth to the question \u2014 thorough when it matters, brief when it doesn't. Use markdown formatting (headings, lists, code blocks) only when it actually helps comprehension. If you're unsure about something, say so plainly rather than guessing confidently.\n\n"
    + "For medical, legal, or financial questions, give useful information but note you're not a licensed professional.\n\n"
    + "Today is " + dateStr + ".";
}

/* ══════════════════════════════════════════════════════════
   RENDER HELPERS
   ══════════════════════════════════════════════════════════ */
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function scrollToEnd() {
  const s = document.getElementById('stream');
  s.scrollTop = s.scrollHeight;
}
function renderMarkdown(text) {
  if (window.marked) return marked.parse(text);
  return escapeHtml(text);
}
function decorateCode(container) {
  container.querySelectorAll('pre').forEach(function (pre) {
    const code = pre.querySelector('code');
    if (!code) return;
    if (window.hljs) { try { hljs.highlightElement(code); } catch (e) {} }
    const btn = el('button', 'copy-btn', 'Copy');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
    pre.appendChild(btn);
  });
}

function addUserMessage(text) {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg user');
  wrap.textContent = text;
  stream.appendChild(wrap);
  scrollToEnd();
}
function addAssistantMessage(markdown) {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg assistant', renderMarkdown(markdown));
  decorateCode(wrap);
  stream.appendChild(wrap);
  scrollToEnd();
  return wrap;
}
function addQuickAnswer(value) {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg quick', '= ' + escapeHtml(value));
  stream.appendChild(wrap);
  scrollToEnd();
}
function addThinking() {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg thinking', '<span class="d"></span><span class="d"></span><span class="d"></span>');
  stream.appendChild(wrap);
  scrollToEnd();
  return wrap;
}
function addSystemNote(text) {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg system-note', escapeHtml(text));
  stream.appendChild(wrap);
  scrollToEnd();
}

function addImageCard(promptText) {
  const stream = document.getElementById('stream');
  const wrap = el('div', 'msg assistant image-card');
  wrap.innerHTML = '<div class="image-frame loading"><div class="spinner"></div></div>'
    + '<div class="image-caption">' + escapeHtml(promptText) + '</div>';
  stream.appendChild(wrap);
  scrollToEnd();
  return wrap;
}
function fillImageCard(card, url, promptText) {
  const frame = card.querySelector('.image-frame');
  const img = new Image();
  img.onload = function () {
    frame.classList.remove('loading');
    frame.innerHTML = '';
    frame.appendChild(img);
    const dl = el('button', 'image-download', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13m0 0l-4-4m4 4l4-4M5 21h14"/></svg>');
    dl.addEventListener('click', function (e) {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = url; a.download = 'chaturvedi.png'; a.target = '_blank';
      a.click();
    });
    frame.appendChild(dl);
    frame.addEventListener('click', function () { openLightbox(url); });
    scrollToEnd();
  };
  img.onerror = function () {
    frame.classList.remove('loading');
    frame.innerHTML = '<div class="image-error">Couldn\u2019t create that image, buddy \u2014 try describing it a little differently.</div>';
  };
  img.alt = promptText;
  img.src = url;
}

function openLightbox(url) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('on');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('on');
}

/* ══════════════════════════════════════════════════════════
   VOICE — output + input
   ══════════════════════════════════════════════════════════ */
function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'code block omitted')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .trim();
}
function chunkText(text, max) {
  max = max || 200;
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = []; let cur = '';
  sentences.forEach(function (s) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  });
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find(function (v) { return v.lang && v.lang.indexOf('en') === 0; }) || voices[0];
}
window.speechSynthesis.onvoiceschanged = function () { window.speechSynthesis.getVoices(); };

let keepAliveTimer = null;
function speak(text) {
  if (!voiceOn || !text) return;
  window.speechSynthesis.cancel();
  const chunks = chunkText(text);
  if (!chunks.length) return;
  setOrbState('speaking');
  let i = 0;
  function next() {
    if (i >= chunks.length) {
      setOrbState('idle');
      clearInterval(keepAliveTimer);
      return;
    }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.rate = 1.0; u.pitch = 1.0;
    const v = pickVoice(); if (v) u.voice = v;
    u.onend = next;
    u.onerror = next;
    window.speechSynthesis.speak(u);
  }
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(function () {
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 9000);
  next();
}

function setOrbState(state) {
  const orb = document.getElementById('orbBtn');
  orb.classList.remove('idle', 'listening', 'thinking', 'speaking');
  orb.classList.add(state);
}

function toggleMic() {
  if (listening) { if (recognition) recognition.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { addSystemNote('Voice input needs Chrome, buddy.'); return; }
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  let finalText = '';
  let silenceTimer = null;
  listening = true;
  setOrbState('listening');

  recognition.onresult = function (e) {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    const composer = document.getElementById('composer');
    composer.value = (finalText + interim).trim();
    autosize();
    updateSendState();
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(function () { if (listening && recognition) recognition.stop(); }, 1800);
  };
  recognition.onend = function () {
    listening = false;
    setOrbState('idle');
    clearTimeout(silenceTimer);
    const composer = document.getElementById('composer');
    const text = composer.value.trim();
    if (text) {
      composer.value = '';
      autosize(); updateSendState();
      sendMessage(text);
    }
  };
  recognition.onerror = function () {
    listening = false;
    setOrbState('idle');
  };
  recognition.start();
}

/* ══════════════════════════════════════════════════════════
   COMPOSER
   ══════════════════════════════════════════════════════════ */
function autosize() {
  const c = document.getElementById('composer');
  c.style.height = 'auto';
  c.style.height = Math.min(c.scrollHeight, 150) + 'px';
}
function updateSendState() {
  const has = document.getElementById('composer').value.trim().length > 0;
  document.getElementById('sendBtn').classList.toggle('active', has);
}
function updateComposerState() {
  const c = document.getElementById('composer');
  const sendBtn = document.getElementById('sendBtn');
  c.disabled = busy;
  sendBtn.disabled = busy;
  if (!busy) c.focus();
}

/* ══════════════════════════════════════════════════════════
   ATTACHMENTS
   ══════════════════════════════════════════════════════════ */
function handleFiles(files) {
  Array.from(files).forEach(function (file) {
    if (file.size > 8 * 1024 * 1024) return;
    if (file.type.indexOf('image/') === 0) {
      const reader = new FileReader();
      reader.onload = function (e) {
        pendingAttachments.push({ name: file.name, kind: 'image', content: e.target.result });
        renderAttachRow();
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = function (e) {
        pendingAttachments.push({ name: file.name, kind: 'text', content: String(e.target.result).slice(0, 6000) });
        renderAttachRow();
      };
      reader.readAsText(file);
    }
  });
}
function renderAttachRow() {
  const row = document.getElementById('attachRow');
  row.innerHTML = '';
  row.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach(function (a, i) {
    const chip = el('div', 'attach-chip');
    chip.appendChild(document.createTextNode((a.kind === 'image' ? '\uD83D\uDDBC ' : '\uD83D\uDCC4 ') + a.name));
    const x = el('button', 'attach-remove', '\u00d7');
    x.addEventListener('click', function () { pendingAttachments.splice(i, 1); renderAttachRow(); });
    chip.appendChild(x);
    row.appendChild(chip);
  });
}
function attachmentContext() {
  let text = '';
  pendingAttachments.forEach(function (a) {
    if (a.kind === 'image') {
      text += '\n\n[Attached image: ' + a.name + ' \u2014 visual analysis isn\u2019t available in this build yet.]';
    } else {
      text += '\n\n[Attached file: ' + a.name + ']\n```\n' + a.content + '\n```\n';
    }
  });
  return text;
}

/* ══════════════════════════════════════════════════════════
   SEND — the entire pipeline
   ══════════════════════════════════════════════════════════ */
async function sendMessage(rawText) {
  const text = (rawText || '').trim();
  if (!text || busy) return;
  busy = true;
  updateComposerState();

  addUserMessage(text);
  history.push({ role: 'user', content: text });
  persistTurn('user', text);

  const attachedNow = pendingAttachments;
  pendingAttachments = [];
  renderAttachRow();

  if (isImageIntent(text) && !attachedNow.length) {
    const built = buildImageUrl(text);
    const card = addImageCard(built.clean);
    fillImageCard(card, built.url, built.clean);
    const note = '[Generated an image: ' + built.clean + ']';
    history.push({ role: 'assistant', content: note });
    persistTurn('assistant', note);
    if (voiceOn) speak('Here\u2019s your image, buddy.');
    busy = false;
    updateComposerState();
    return;
  }

  const thinking = addThinking();
  setOrbState('thinking');

  let liveCtx = '';
  try { liveCtx = await liveContext(text); } catch (e) {}
  const mathAns = quickMath(text);
  if (mathAns) addQuickAnswer(mathAns);

  const attachCtx = attachmentContext();

  const apiHistory = history.slice(-16).map(function (m) { return { role: m.role, content: m.content }; });
  if (apiHistory.length) {
    apiHistory[apiHistory.length - 1] = { role: 'user', content: text + liveCtx + attachCtx };
  }
  const msgs = [{ role: 'system', content: systemPrompt() }].concat(apiHistory);

  let reply;
  try {
    reply = await askAI(msgs);
    if (!reply) reply = 'I didn\u2019t quite catch that, buddy \u2014 could you try again?';
  } catch (e) {
    reply = 'I\u2019m having trouble reaching my reasoning engine right now, buddy. Give it a moment and try again.';
  }

  thinking.remove();
  addAssistantMessage(reply);
  history.push({ role: 'assistant', content: reply });
  persistTurn('assistant', reply);

  if (voiceOn) speak(cleanForSpeech(reply));
  else setOrbState('idle');

  busy = false;
  updateComposerState();
}

/* ══════════════════════════════════════════════════════════
   MEMORY — Supabase primary, localStorage fallback
   ══════════════════════════════════════════════════════════ */
async function initMemory() {
  try {
    if (window.supabase) {
      sbClient = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
      const result = await sbClient.from('memories').select('role,content').order('created_at', { ascending: false }).limit(30);
      if (!result.error && result.data) {
        sbReady = true;
        setSyncDot(true);
        const rows = result.data.slice().reverse();
        rows.forEach(function (m) {
          history.push({ role: m.role, content: m.content });
          if (m.role === 'user') addUserMessage(m.content);
          else addAssistantMessage(m.content);
        });
        return;
      }
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem('chaturvedi_history');
    if (raw) {
      const arr = JSON.parse(raw).slice(-30);
      arr.forEach(function (m) {
        history.push(m);
        if (m.role === 'user') addUserMessage(m.content);
        else addAssistantMessage(m.content);
      });
    }
  } catch (e) {}
  setSyncDot(false);
}
function persistTurn(role, content) {
  try {
    const raw = localStorage.getItem('chaturvedi_history');
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({ role: role, content: content });
    while (arr.length > 200) arr.shift();
    localStorage.setItem('chaturvedi_history', JSON.stringify(arr));
  } catch (e) {}
  if (sbReady && sbClient) {
    sbClient.from('memories').insert({
      role: role, content: String(content).slice(0, 4000), created_at: new Date().toISOString()
    }).then(function () {}).catch(function () {});
  }
}
function setSyncDot(on) {
  const dot = document.getElementById('syncDot');
  if (dot) dot.classList.toggle('on', on);
}

/* ══════════════════════════════════════════════════════════
   MENU ACTIONS
   ══════════════════════════════════════════════════════════ */
function greet() {
  addAssistantMessage('Hi, I\u2019m Chaturvedi. Ask me anything, or describe an image to create one.');
}
function newChat() {
  history = [];
  document.getElementById('stream').innerHTML = '';
  greet();
  closeMenu();
}
function exportChat() {
  const lines = history.map(function (m) {
    return (m.role === 'user' ? '**You:** ' : '**Chaturvedi:** ') + m.content;
  }).join('\n\n');
  const blob = new Blob(['# Conversation with Chaturvedi\n\n' + lines], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chaturvedi-' + Date.now() + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
  closeMenu();
}
function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('chaturvedi_theme', theme); } catch (e) {}
  updateMenuLabels();
}
function toggleVoiceSetting() {
  voiceOn = !voiceOn;
  try { localStorage.setItem('chaturvedi_voice', voiceOn ? '1' : '0'); } catch (e) {}
  if (!voiceOn) window.speechSynthesis.cancel();
  updateMenuLabels();
}
function updateMenuLabels() {
  document.getElementById('voiceLabel').textContent = voiceOn ? 'On' : 'Off';
  document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
}
function openMenu() {
  document.getElementById('menuPanel').hidden = false;
  document.getElementById('overlay').classList.add('on');
  updateMenuLabels();
}
function closeMenu() {
  document.getElementById('menuPanel').hidden = true;
  document.getElementById('overlay').classList.remove('on');
}
function openAbout() {
  closeMenu();
  document.getElementById('aboutPanel').hidden = false;
  document.getElementById('overlay').classList.add('on');
}
function closeAbout() {
  document.getElementById('aboutPanel').hidden = true;
  document.getElementById('overlay').classList.remove('on');
}

/* ══════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════ */
async function boot() {
  try {
    const savedTheme = localStorage.getItem('chaturvedi_theme');
    if (savedTheme) { theme = savedTheme; document.documentElement.setAttribute('data-theme', theme); }
    const savedVoice = localStorage.getItem('chaturvedi_voice');
    if (savedVoice !== null) voiceOn = savedVoice === '1';
  } catch (e) {}

  await initMemory();
  if (history.length === 0) greet();

  updateComposerState();
  setOrbState('idle');
}

/* ══════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════ */
const composerEl = document.getElementById('composer');
composerEl.addEventListener('input', function () { autosize(); updateSendState(); });
composerEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const t = composerEl.value;
    composerEl.value = '';
    autosize(); updateSendState();
    sendMessage(t);
  }
});
document.getElementById('sendBtn').addEventListener('click', function () {
  const t = composerEl.value;
  composerEl.value = '';
  autosize(); updateSendState();
  sendMessage(t);
});
document.getElementById('orbBtn').addEventListener('click', toggleMic);
document.getElementById('attachBtn').addEventListener('click', function () {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', function (e) {
  handleFiles(e.target.files);
  e.target.value = '';
});
document.getElementById('moreBtn').addEventListener('click', function (e) {
  e.stopPropagation();
  if (document.getElementById('menuPanel').hidden) openMenu(); else closeMenu();
});
document.getElementById('overlay').addEventListener('click', function () {
  closeMenu(); closeAbout();
});
document.getElementById('newChatItem').addEventListener('click', newChat);
document.getElementById('exportItem').addEventListener('click', exportChat);
document.getElementById('voiceItem').addEventListener('click', toggleVoiceSetting);
document.getElementById('themeItem').addEventListener('click', toggleTheme);
document.getElementById('aboutItem').addEventListener('click', openAbout);
document.getElementById('aboutClose').addEventListener('click', closeAbout);
document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
document.getElementById('lightbox').addEventListener('click', function (e) {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeMenu(); closeAbout(); closeLightbox(); }
});

boot();
