const $ = (selector) => document.querySelector(selector);

const milestones = [10, 25, 50, 100, 200, 500, 1000];
const moodNames = { happy: 'Happy', love: 'Love', sad: 'Sad', angry: 'Angry' };

const countersKey = 'azharCounters';
const themeKey = 'azharTheme';
const customKey = 'azharCustomTheme';
const darkKey = 'azharDark';
const offsetKey = 'azharOffset';
const sessionKey = 'azharSession';
const liveApi = 'https://princess-azhar.global-calendula.workers.dev';

function isLocalHost(host) {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host.startsWith('192.168.')
    || host.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function apiRoot() {
  return isLocalHost(location.hostname) ? '' : liveApi;
}

function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const session = sessionStorage.getItem(sessionKey);
  if (session && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${session}`);
  return fetch(`${apiRoot()}${path}`, { ...options, headers });
}

let counters = loadCounters();
let quickSend = false;
let configured = false;
let polling = false;
const queue = [];
let working = false;
const seen = new Set();
let toastTimer = 0;
let audioCtx = null;

const toast = $('#toast');
const inbox = $('#inbox');
const inboxEmpty = $('#inboxEmpty');
const music = $('#bgMusic');

function loadCounters() {
  const today = new Date().toDateString();
  const saved = JSON.parse(localStorage.getItem(countersKey) || 'null');
  if (!saved || saved.lastReset !== today) {
    return { miss: 0, love: 0, need: 0, lastReset: today };
  }
  return saved;
}

function saveCounters() {
  localStorage.setItem(countersKey, JSON.stringify(counters));
}

function total() {
  return counters.miss + counters.love + counters.need;
}

function renderCounters() {
  $('#totalCount').textContent = total();
  $('#missCount').textContent = counters.miss;
  $('#loveCount').textContent = counters.love;
  $('#needCount').textContent = counters.need;
}

function showToast(message, type = 'success') {
  toast.hidden = false;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function playTap() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 620;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch {
    /* sound is optional */
  }
}

function confetti() {
  const colors = ['#ff6fa8', '#ffd1e3', '#e2a322', '#ff4f93', '#3cbfa0'];
  for (let i = 0; i < 36; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3200);
  }
}

function bump(type) {
  counters[type] += 1;
  saveCounters();
  renderCounters();
  const count = total();
  if (milestones.includes(count)) {
    confetti();
    showToast(`You sent ${count} messages today`);
  }
}

function undo(type) {
  counters[type] = Math.max(0, counters[type] - 1);
  saveCounters();
  renderCounters();
}

async function sendText(text) {
  const response = await api('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await response.json().catch(() => ({ ok: false, error: 'Could not send.' }));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Could not send.');
}

async function processQueue() {
  if (working || queue.length === 0) return;
  working = true;
  const job = queue[0];
  job.button?.classList.add('loading');

  try {
    await sendText(job.text);
    queue.shift();
    playTap();
    if (!quickSend) showToast('Message sent');
  } catch (error) {
    job.tries = (job.tries || 0) + 1;
    if (job.tries >= 3) {
      queue.shift();
      if (job.type) undo(job.type);
      const message = /load failed|failed to fetch|networkerror/i.test(error.message || '')
        ? 'Could not send.'
        : (error.message || 'Could not send.');
      showToast(message, 'error');
    }
  } finally {
    job.button?.classList.remove('loading');
    working = false;
    if (queue.length) setTimeout(processQueue, job.tries ? 1000 : 120);
  }
}

function enqueue(text, button, type) {
  if (type) bump(type);
  queue.push({ text, button, type, tries: 0 });
  processQueue();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(themeKey, theme);
  const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', themeColor || '#ff6fa8');
}

function applyCustom(colors) {
  let style = $('#customStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'customStyle';
    document.head.appendChild(style);
  }
  style.textContent = `[data-theme="custom"] {
    --primary: ${colors.primary};
    --secondary: ${colors.secondary};
    --bg: ${colors.background};
    --bg-2: ${colors.secondary};
    --text: #3d2433;
    --card: rgba(255,255,255,.88);
    --line: ${colors.primary}55;
  }`;
  applyTheme('custom');
}

function addMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  inboxEmpty.hidden = true;

  const item = document.createElement('article');
  item.className = 'message';
  const text = document.createElement('p');
  text.dir = 'auto';
  text.textContent = message.text;
  const time = document.createElement('time');
  time.dateTime = new Date(message.date * 1000).toISOString();
  time.textContent = new Date(message.date * 1000).toLocaleString();
  const reply = document.createElement('button');
  reply.className = 'reply-btn';
  reply.type = 'button';
  reply.textContent = 'Reply';
  reply.addEventListener('click', () => {
    $('#customMessage').focus();
    $('#customMessage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  item.append(text, time, reply);
  inbox.prepend(item);
}

async function pollInbox() {
  if (polling || !configured) return;
  polling = true;
  try {
    const offset = localStorage.getItem(offsetKey) || '0';
    const response = await api(`/api/updates?offset=${encodeURIComponent(offset)}`);
    const data = await response.json();
    if (!data.ok) return;
    if (data.nextOffset) localStorage.setItem(offsetKey, String(data.nextOffset));
    const fresh = (data.messages || []).filter((message) => !seen.has(message.id));
    fresh.forEach(addMessage);
    if (fresh.length) {
      playTap();
      showToast('New message');
    }
  } catch {
    /* keep the last inbox if the network blips */
  } finally {
    polling = false;
  }
}

function setConnection(status) {
  configured = Boolean(status.hasToken && status.hasChat);
}

async function refreshStatus() {
  try {
    const response = await api('/api/status');
    const status = await response.json();
    setConnection(status);
    if (configured) pollInbox();
    return status;
  } catch {
    return null;
  }
}

document.querySelectorAll('.sentiment').forEach((button) => {
  button.addEventListener('click', () => {
    playTap();
    enqueue(button.dataset.message, button, button.dataset.type);
  });
});

$('#quickSend').addEventListener('click', () => {
  quickSend = !quickSend;
  $('#quickSend').classList.toggle('active', quickSend);
  $('#quickSend').setAttribute('aria-pressed', String(quickSend));
  $('#quickSend').textContent = quickSend ? '⚡ Quick Send Mode: ON' : '⚡ Quick Send Mode';
  showToast(quickSend ? 'Quick Send is on' : 'Quick Send is off', 'info');
});

$('#customForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#customMessage');
  const text = input.value.trim();
  if (!text) {
    showToast('Type a message first.', 'error');
    return;
  }
  enqueue(text, event.submitter);
  input.value = '';
});

document.querySelectorAll('.mood-btn').forEach((button) => {
  button.addEventListener('click', () => {
    const mood = button.dataset.mood;
    playTap();
    enqueue(moodNames[mood], button);
  });
});

let musicWanted = false;
let musicIntent = 0;
const visitKey = 'azharUnlocked';
music.loop = false;

function setMusicPlaying(playing) {
  const button = $('#toggleMusic');
  button.setAttribute('aria-pressed', String(playing));
  button.setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
  button.textContent = playing ? '⏸️ Pause' : '🎵 Music';
}

function stopMusic() {
  musicWanted = false;
  musicIntent += 1;
  music.pause();
  music.loop = false;
  setMusicPlaying(false);
}

async function startMusic() {
  musicWanted = true;
  const intent = ++musicIntent;
  music.loop = true;
  try {
    await music.play();
    if (!musicWanted || intent !== musicIntent) {
      music.pause();
      music.loop = false;
      setMusicPlaying(false);
      return;
    }
    setMusicPlaying(true);
  } catch {
    if (musicWanted && intent === musicIntent) showToast('The song could not play.', 'error');
    if (intent === musicIntent) {
      musicWanted = false;
      music.loop = false;
      setMusicPlaying(false);
    }
  }
}

$('#toggleMusic').addEventListener('click', (event) => {
  event.stopPropagation();
  if (musicWanted || !music.paused) stopMusic();
  else startMusic();
});

const themeMenu = $('#themeMenu');
const themeCreator = $('#themeCreator');

function closeColors() {
  themeMenu.classList.remove('open');
  themeCreator.classList.remove('open');
}

$('#themeButton').addEventListener('click', (event) => {
  event.stopPropagation();
  const willOpen = !themeMenu.classList.contains('open');
  closeColors();
  if (willOpen) themeMenu.classList.add('open');
});

$('#themeMenu').addEventListener('click', (event) => {
  event.stopPropagation();
  const choice = event.target.closest('[data-theme]');
  if (choice) {
    applyTheme(choice.dataset.theme);
    closeColors();
    return;
  }
  if (event.target.id === 'customThemeButton') {
    themeMenu.classList.remove('open');
    themeCreator.classList.add('open');
  }
});

$('#themeCreator').addEventListener('click', (event) => {
  event.stopPropagation();
});

$('#themeCreator').addEventListener('submit', (event) => {
  event.preventDefault();
  const colors = {
    primary: $('#primaryColor').value,
    secondary: $('#secondaryColor').value,
    background: $('#backgroundColor').value,
  };
  localStorage.setItem(customKey, JSON.stringify(colors));
  applyCustom(colors);
  closeColors();
});

$('#darkButton').addEventListener('click', () => {
  const on = document.body.classList.toggle('dark');
  $('#darkButton').textContent = on ? '☀️ Light' : '🌙 Dark';
  $('#darkButton').setAttribute('aria-pressed', String(on));
  localStorage.setItem(darkKey, String(on));
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest('#themeButton, #themeMenu, #themeCreator')) return;
  closeColors();
});

$('#refreshInbox').addEventListener('click', () => {
  $('#refreshInbox').classList.add('loading');
  pollInbox().finally(() => $('#refreshInbox').classList.remove('loading'));
});

const savedTheme = localStorage.getItem(themeKey) || 'pink';
if (savedTheme === 'custom') {
  const colors = JSON.parse(localStorage.getItem(customKey) || 'null');
  if (colors) applyCustom(colors);
  else applyTheme('pink');
} else {
  applyTheme(savedTheme);
}

if (localStorage.getItem(darkKey) === 'true') {
  document.body.classList.add('dark');
  $('#darkButton').textContent = '☀️ Light';
  $('#darkButton').setAttribute('aria-pressed', 'true');
}

renderCounters();

const loadingStarted = Date.now();
function finishLoading() {
  const wait = Math.max(0, 1800 - (Date.now() - loadingStarted));
  setTimeout(() => {
    const loading = $('#loading');
    if (!loading) return;
    loading.classList.add('hide');
    setTimeout(() => loading.remove(), 500);
  }, wait);
}

const lock = $('#lock');
let passEntry = '';

function renderPasscode() {
  document.querySelectorAll('#lockDots span').forEach((dot, index) => {
    dot.classList.toggle('filled', index < passEntry.length);
  });
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === `${name}View`);
  });
  document.body.classList.toggle('in-cinema', name === 'cinema');
  if (name === 'cinema') {
    stopMusic();
    window.AzharCinema?.open();
  } else {
    window.AzharCinema?.close();
  }
}

function unlockApp() {
  sessionStorage.setItem(visitKey, '1');
  lock.classList.add('hide');
  setTimeout(() => lock.remove(), 400);
  showView('home');
}

function rejectPasscode() {
  const error = $('#lockError');
  error.hidden = false;
  lock.classList.remove('shake');
  void lock.offsetWidth;
  lock.classList.add('shake');
  setTimeout(() => {
    passEntry = '';
    renderPasscode();
    lock.classList.remove('shake');
  }, 450);
}

const savedUnlock = sessionStorage.getItem(visitKey) === '1';
if (savedUnlock) {
  api('/api/session')
    .then((response) => response.json())
    .then((data) => {
      if (data.ok) lock.remove();
      else sessionStorage.removeItem(visitKey);
    })
    .catch(() => sessionStorage.removeItem(visitKey));
}
document.querySelectorAll('.keypad [data-digit]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (passEntry.length >= 4) return;
      passEntry += button.dataset.digit;
      $('#lockError').hidden = true;
      renderPasscode();
      if (passEntry.length < 4) return;
      const code = passEntry;
      try {
        const response = await api('/api/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const type = response.headers.get('content-type') || '';
        if (!type.includes('application/json')) {
          if (code === '3108') unlockApp();
          else rejectPasscode();
          return;
        }
        const data = await response.json();
        if (data.ok) {
          if (data.session) sessionStorage.setItem(sessionKey, data.session);
          unlockApp();
          refreshStatus();
        } else rejectPasscode();
      } catch {
        if (code === '3108') unlockApp();
        else rejectPasscode();
      }
    });
  });

  $('#lockBack').addEventListener('click', () => {
    passEntry = passEntry.slice(0, -1);
    $('#lockError').hidden = true;
    renderPasscode();
  });

document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.open));
});
$('#backHome').addEventListener('click', () => showView('home'));
$('#cinemaHome').addEventListener('click', () => showView('home'));

$('#lockClear').addEventListener('click', () => {
  passEntry = '';
  $('#lockError').hidden = true;
  renderPasscode();
});

if (document.readyState === 'complete') finishLoading();
else window.addEventListener('load', finishLoading);

refreshStatus();
setInterval(pollInbox, 5000);
