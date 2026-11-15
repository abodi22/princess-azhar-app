import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const ROOM_ID = 'princess-rnm';
const ROOM_STATE_ID = 'main';
const NICKNAME_KEY = 'princess_rnm_nickname';
const USER_KEY = 'princess_rnm_user_id';

const db = createClient(
  'https://ixfssitjswomrmsppbnq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZnNzaXRqc3dvbXJtc3BwYm5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0NDQ5OTgsImV4cCI6MjA5OTAyMDk5OH0.0l0znTrKID4PVU_KtZ_msZPXujv6BZOMi3Yn2iUUWz4',
);

let running = false;
let player = null;
let joined = false;
let applying = false;
let localUpdate = false;
let currentVideo = '';
let pendingState = null;
let channels = [];
let timers = [];

function byId(id) {
  return document.getElementById(id);
}

function userId() {
  let id = localStorage.getItem(USER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_KEY, id);
  }
  return id;
}

function nickname() {
  return localStorage.getItem(NICKNAME_KEY) || '';
}

function showError(message) {
  const error = byId('cinemaError');
  error.hidden = !message;
  error.textContent = message || '';
}

function extractVideoId(input) {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/watch\?.*&v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }
  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get('v');
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
  } catch {
    /* not a url */
  }
  return null;
}

function ensureYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
}

async function pushState(updates) {
  localUpdate = true;
  const { error } = await db.from('room_state').update({
    ...updates,
    updated_at: new Date().toISOString(),
    updated_by: userId(),
    updated_by_nickname: nickname(),
  }).eq('id', ROOM_STATE_ID).eq('room_id', ROOM_ID);
  setTimeout(() => {
    localUpdate = false;
  }, 500);
  if (error) showError('The video could not be shared.');
}

function applyState(state) {
  if (!player || !joined || !state || state.updated_by === userId()) return;
  if (state.video_id && state.video_id !== currentVideo) return;
  applying = true;
  const current = player.getCurrentTime();
  if (Math.abs(current - Number(state.playback_time || 0)) > 2) {
    player.seekTo(Number(state.playback_time || 0), true);
  }
  const playing = player.getPlayerState() === window.YT.PlayerState.PLAYING;
  if (state.is_playing && !playing) player.playVideo();
  if (!state.is_playing && playing) player.pauseVideo();
  setTimeout(() => {
    applying = false;
  }, 400);
}

async function mountPlayer(videoId) {
  await ensureYouTube();
  joined = false;
  byId('joinWatch').hidden = false;
  if (player) {
    player.destroy();
    player = null;
  }
  const slot = byId('playerSlot');
  slot.innerHTML = '';
  const holder = document.createElement('div');
  slot.appendChild(holder);
  player = new window.YT.Player(holder, {
    videoId,
    playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onStateChange: (event) => {
        if (!joined || localUpdate || applying) return;
        const playing = event.data === window.YT.PlayerState.PLAYING;
        const paused = event.data === window.YT.PlayerState.PAUSED;
        if (!playing && !paused) return;
        pushState({ is_playing: playing, playback_time: player.getCurrentTime() });
      },
    },
  });
}

async function chooseVideo(videoId, title) {
  currentVideo = videoId;
  byId('videoTitle').textContent = title || 'Video';
  showError('');
  await pushState({
    video_id: videoId,
    video_title: title || 'Video',
    is_playing: false,
    playback_time: 0,
  });
  await mountPlayer(videoId);
}

function addChatLine(message) {
  const chat = byId('cinemaChat');
  const line = document.createElement('article');
  line.className = `cinema-line${message.user_id === userId() ? ' mine' : ''}`;
  const name = document.createElement('small');
  name.textContent = message.nickname || 'Someone';
  const text = document.createElement('p');
  text.textContent = message.body;
  line.append(name, text);
  chat.append(line);
  chat.scrollTop = chat.scrollHeight;
}

async function refreshPresence() {
  const { data } = await db.from('presence').select('*').eq('room_id', ROOM_ID);
  const now = Date.now();
  const online = (data || []).filter((person) => now - new Date(person.last_seen).getTime() < 30000);
  byId('cinemaPresence').textContent = online.length >= 2
    ? 'Watching together'
    : 'Waiting for her';
}

async function beat() {
  await db.from('presence').upsert({
    user_id: userId(),
    room_id: ROOM_ID,
    nickname: nickname(),
    last_seen: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  refreshPresence();
}

async function openRoom() {
  if (running) return;
  running = true;
  byId('nameForm').hidden = true;
  byId('cinemaRoom').hidden = false;
  const { data } = await db.from('room_state').select('*').eq('id', ROOM_STATE_ID).single();
  if (data?.video_id) {
    currentVideo = data.video_id;
    pendingState = data;
    byId('videoTitle').textContent = data.video_title || 'Video';
    await mountPlayer(data.video_id);
  }
  const messages = await db.from('messages').select('*').eq('room_id', ROOM_ID).order('created_at', { ascending: true }).limit(100);
  byId('cinemaChat').replaceChildren();
  (messages.data || []).forEach(addChatLine);

  const stateChannel = db.channel('azhar-room').on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'room_state', filter: `id=eq.${ROOM_STATE_ID}`,
  }, (payload) => {
    const next = payload.new;
    if (next.updated_by === userId()) return;
    if (next.video_id && next.video_id !== currentVideo) {
      currentVideo = next.video_id;
      pendingState = next;
      byId('videoTitle').textContent = next.video_title || 'Video';
      mountPlayer(next.video_id);
      return;
    }
    pendingState = next;
    applyState(next);
  }).subscribe();

  const chatChannel = db.channel('azhar-chat').on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${ROOM_ID}`,
  }, (payload) => addChatLine(payload.new)).subscribe();

  channels = [stateChannel, chatChannel];
  beat();
  timers.push(setInterval(beat, 15000));
  timers.push(setInterval(() => {
    if (!joined || !player || localUpdate) return;
    if (player.getPlayerState() === window.YT.PlayerState.PLAYING) {
      pushState({ is_playing: true, playback_time: player.getCurrentTime() });
    }
  }, 3000));
}

function closeRoom() {
  running = false;
  timers.forEach(clearInterval);
  timers = [];
  channels.forEach((channel) => db.removeChannel(channel));
  channels = [];
  if (player) {
    player.destroy();
    player = null;
  }
  joined = false;
}

byId('nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = byId('cinemaNickname').value.trim();
  if (!name) return;
  localStorage.setItem(NICKNAME_KEY, name);
  openRoom();
});

byId('videoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = extractVideoId(byId('videoUrl').value);
  if (!id) {
    showError('That is not a YouTube link.');
    return;
  }
  byId('videoUrl').value = '';
  let title = 'Video';
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
    if (response.ok) title = (await response.json()).title || title;
  } catch {
    title = 'Video';
  }
  chooseVideo(id, title);
});

byId('joinWatch').addEventListener('click', async () => {
  joined = true;
  byId('joinWatch').hidden = true;
  const { data } = await db.from('room_state').select('*').eq('id', ROOM_STATE_ID).single();
  const state = data || pendingState;
  if (!player || !state) return;
  if (Number(state.playback_time) > 0) player.seekTo(Number(state.playback_time), true);
  if (state.is_playing) player.playVideo();
});

byId('cinemaChatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = byId('cinemaChatInput');
  const text = input.value.trim();
  if (!text) return;
  const { error } = await db.from('messages').insert({
    room_id: ROOM_ID,
    user_id: userId(),
    nickname: nickname(),
    body: text,
  });
  if (error) showError('The message could not be sent.');
  else input.value = '';
});

window.AzharCinema = {
  open() {
    if (nickname()) openRoom();
    else {
      byId('nameForm').hidden = false;
      byId('cinemaRoom').hidden = true;
    }
  },
  close: closeRoom,
};
