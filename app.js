const jsmediatags = window.jsmediatags;

// ----- State -----
let library = [];
let queue = [];
let queueIndex = 0;

let activePlayerId = "playerA";
let isTransitioning = false;
let transitionTriggeredForCurrent = false;

let isShuffle = false;
let repeatMode = 0;

let smartPlayMode = true;
let gaplessMode = false;
let crossfadeMode = true;
let masterGain = null;

// BRO TIP: Restored your OG 3.8s fade for that smooth butter feel
const CROSSFADE_TIME = 3.8;
const DEFAULT_ART = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=1000&auto=format&fit=crop";
const playerGainMap = new Map(); // key: HTMLMediaElement -> GainNode


// favorites
const LS_FAV = "cloud_player_favs";
const favorites = new Set(JSON.parse(localStorage.getItem(LS_FAV) || "[]"));

// albums
let albumsMap = new Map();
let currentAlbumKey = null;

// ---------- CloudE Environment Sound™ ----------
const LS_ENV_ON = "cloude_env_on";
const LS_ENV_PRESET = "cloude_env_preset";
const LS_ENV_STRENGTH = "cloude_env_strength";
const LS_ENV_SEP = "cloude_env_separation";
const LS_ENV_BASS = "cloude_env_bass";
const LS_ENV_CLARITY = "cloude_env_clarity";

let envEnabled = localStorage.getItem(LS_ENV_ON) === "1";
let envPresetName = localStorage.getItem(LS_ENV_PRESET) || "studio";
let envStrength = Number(localStorage.getItem(LS_ENV_STRENGTH) || "65");
let envSeparation = localStorage.getItem(LS_ENV_SEP) !== "0";
let envBass = Number(localStorage.getItem(LS_ENV_BASS) || "3");
let envClarity = Number(localStorage.getItem(LS_ENV_CLARITY) || "2");
let reduceMotion = localStorage.getItem("cloude_reduce_motion") === "1";
let autoLyrics = localStorage.getItem("cloude_auto_lyrics") !== "0";



// ----- AudioContext -----
let audioCtx = null;
function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// BRO FIXED: This now ensures Source -> Gain is PERMANENT.
// We only disconnect the OUTPUT of this gain, never the input.
function getPlayerGain(p) {
  const ctx = ensureAudioContext();

  // Create Master if missing
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }

  let g = playerGainMap.get(p);
  if (!g) {
    // 1. Create Source (Singleton per element)
    if (!getPlayerGain._sources) getPlayerGain._sources = new WeakMap();
    let src = getPlayerGain._sources.get(p);
    if (!src) {
      src = ctx.createMediaElementSource(p);
      getPlayerGain._sources.set(p, src);
    }

    // 2. Create Gain (The Crossfader)
    g = ctx.createGain();
    g.gain.value = 1; // Default to full, we automate this later

    // 3. HARD WIRE: Source -> Gain
    // We never disconnect this link.
    src.disconnect();
    src.connect(g);

    playerGainMap.set(p, g);
  }
  return g;
}

// BRO ADDED: Smart Routing Function
// Decides if the Crossfader connects to Env or Master
function routePlayerOutput(p) {
  const g = getPlayerGain(p); // Get the crossfader gain
  const ctx = ensureAudioContext();

  // Reset connections
  try { g.disconnect(); } catch { }

  if (envEnabled) {
    // If Env is ON, plug Crossfader -> Env Input
    attachEnvToActivePlayer(p, g);
  } else {
    // If Env is OFF, plug Crossfader -> Master directly
    g.connect(masterGain);
  }
}


function createImpulseResponse(ctx, seconds = 0.22, decay = 2.2) {
  const rate = ctx.sampleRate;
  const length = rate * seconds;
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function presetParams(name) {
  const presets = {
    studio: { width: 0.35, cross: 0.06, reverb: 0.04, sep: 0.55, comp: 0.25 },
    cinema: { width: 0.65, cross: 0.08, reverb: 0.12, sep: 0.75, comp: 0.35 },
    concert: { width: 0.85, cross: 0.10, reverb: 0.20, sep: 0.65, comp: 0.28 },
    car: { width: 0.45, cross: 0.07, reverb: 0.06, sep: 0.70, comp: 0.45 },
    night: { width: 0.25, cross: 0.08, reverb: 0.03, sep: 0.50, comp: 0.60 },
  };
  return presets[name] || presets.studio;
}

function applyEnvSettings() {
  const n = attachEnvToActivePlayer._nodes;
  if (!n) return;

  const strength = envEnabled ? (envStrength / 100) : 0;
  const P = presetParams(envPresetName);

  n.diffGainL.gain.value = strength * P.width;
  n.diffGainR.gain.value = strength * P.width;

  const cf = strength * P.cross;
  n.LtoR.gain.value = cf;
  n.RtoL.gain.value = cf;

  n.reverbGain.gain.value = strength * P.reverb;

  const sepAmt = (envEnabled && envSeparation) ? (strength * P.sep) : 0;
  n.sideBoost.gain.value = 1 + sepAmt;
  n.midTrim.gain.value = 1 - (sepAmt * 0.25);

  n.bassShelf.gain.value = envEnabled ? envBass : 0;
  n.clarityPeak.gain.value = envEnabled ? envClarity : 0;

  const compAmt = strength * P.comp;
  n.compressor.threshold.value = -16 - compAmt * 10;
  n.compressor.ratio.value = 2.8 + compAmt * 2.5;
}

async function enableEnvIfNeeded() {
  const active = getActive();
  if (!active) return;

  // Just trigger a re-route
  routePlayerOutput(active);

  if (!envEnabled) return;
  const ctx = ensureAudioContext();
  if (ctx.state !== "running") await ctx.resume();
}

// BRO FIXED: Now accepts the Crossfade GainNode as input
// It no longer steals the raw source!
function attachEnvToActivePlayer(playerElement, inputGainNode) {
  const ctx = ensureAudioContext();

  // If we already built the graph, just ensure connection
  if (attachEnvToActivePlayer._nodes) {
    inputGainNode.connect(attachEnvToActivePlayer._inputNode);
    // Ensure the output of the graph goes to master
    attachEnvToActivePlayer._outputNode.disconnect();
    attachEnvToActivePlayer._outputNode.connect(masterGain);
    applyEnvSettings();
    return;
  }

  // --- Build Graph ONCE ---
  const input = ctx.createGain(); // The entry point for the Env
  attachEnvToActivePlayer._inputNode = input;

  const bassShelf = ctx.createBiquadFilter();
  bassShelf.type = "lowshelf";
  bassShelf.frequency.value = 120;
  bassShelf.gain.value = 0;

  const clarityPeak = ctx.createBiquadFilter();
  clarityPeak.type = "peaking";
  clarityPeak.frequency.value = 3400;
  clarityPeak.Q.value = 1.0;
  clarityPeak.gain.value = 0;

  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const invR = ctx.createGain(); invR.gain.value = -1;
  const invL = ctx.createGain(); invL.gain.value = -1;

  const lMinusR = ctx.createGain();
  const rMinusL = ctx.createGain();

  const diffGainL = ctx.createGain();
  const diffGainR = ctx.createGain();

  const split2 = ctx.createChannelSplitter(2);
  const merge2 = ctx.createChannelMerger(2);

  const LtoR = ctx.createGain();
  const RtoL = ctx.createGain();

  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulseResponse(ctx, 0.22, 2.2);

  const reverbGain = ctx.createGain(); reverbGain.gain.value = 0;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 22;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;

  const output = ctx.createGain();
  attachEnvToActivePlayer._outputNode = output;

  // wiring
  input.connect(bassShelf);
  bassShelf.connect(clarityPeak);
  clarityPeak.connect(splitter);

  splitter.connect(invR, 1);
  splitter.connect(lMinusR, 0);
  invR.connect(lMinusR);

  splitter.connect(invL, 0);
  splitter.connect(rMinusL, 1);
  invL.connect(rMinusL);

  splitter.connect(merger, 0, 0);
  splitter.connect(merger, 1, 1);

  lMinusR.connect(diffGainL);
  rMinusL.connect(diffGainR);
  diffGainL.connect(merger, 0, 0);
  diffGainR.connect(merger, 0, 1);

  merger.connect(split2);
  split2.connect(merge2, 0, 0);
  split2.connect(merge2, 1, 1);

  split2.connect(LtoR, 0);
  split2.connect(RtoL, 1);

  LtoR.connect(merge2, 0, 1);
  RtoL.connect(merge2, 0, 0);

  merge2.connect(convolver);
  convolver.connect(reverbGain);

  merge2.connect(compressor);
  reverbGain.connect(compressor);

  compressor.connect(output);

  // Route final output to master
  output.connect(masterGain);

  attachEnvToActivePlayer._nodes = {
    diffGainL, diffGainR, LtoR, RtoL,
    reverbGain, compressor,
    bassShelf, clarityPeak,
    sideBoost: { gain: { value: 1 } }, midTrim: { gain: { value: 1 } }
  };

  // Finally, connect our player's gain to this graph
  inputGainNode.connect(input);
  applyEnvSettings();
}

// ----- Helpers -----
const getActive = () => document.getElementById(activePlayerId);
const getInactive = () => document.getElementById(activePlayerId === "playerA" ? "playerB" : "playerA");

function openPanel(panel) {
  const lyricsPanel = document.getElementById("lyricsPanel");
  if (panel === lyricsPanel && panel.classList.contains("open")) {
    closePanel(panel);
    return;
  }
  closePanel(lyricsPanel);
  closePanel(menuPanel);
  closePanel(queuePanel);
  closePanel(fxPanel);
  panel.classList.add("open");
  if (panel === lyricsPanel) {
    document.querySelector(".app").classList.add("lyrics-open-mode");
  }
}

function closePanel(panel) {
  if (!panel) return;
  panel.classList.remove("open");
  if (panel.id === "lyricsPanel") {
    document.querySelector(".app").classList.remove("lyrics-open-mode");
  }
}

function openLibrary(tab = "songs") {
  nowPlaying.style.display = "none";
  albumView.classList.remove("open");
  libraryView.classList.add("open");
  miniPlayer.classList.add("show");
  setTabs(tab);
  renderLibrary();
}
function openNowPlaying() {
  libraryView.classList.remove("open");
  albumView.classList.remove("open");
  nowPlaying.style.display = "flex";
  miniPlayer.classList.remove("show");
}
function openAlbum(key) {
  currentAlbumKey = key;
  libraryView.classList.remove("open");
  albumView.classList.add("open");
  miniPlayer.classList.add("show");
  renderAlbumView();
}

function setTabs(tab) {
  if (tab === "albums") {
    tabSongs.classList.remove("active");
    tabAlbums.classList.add("active");
    songsList.style.display = "none";
    albumsGrid.style.display = "grid";
  } else {
    tabAlbums.classList.remove("active");
    tabSongs.classList.add("active");
    albumsGrid.style.display = "none";
    songsList.style.display = "flex";
  }
}

function formatTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" + sec : sec}`;
}
function escapeHtml(str = "") { return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[s])); }

function buildBadge(text, type = "") {
  const el = document.createElement("div");
  el.className = `badge ${type}`;
  el.textContent = text;
  return el;
}

function computeBadges(meta) {
  badgeRow.innerHTML = "";
  if (meta.lossless) badgeRow.appendChild(buildBadge(meta.hires ? "Hi-Res Lossless" : "Lossless", meta.hires ? "gold" : ""));
  else badgeRow.appendChild(buildBadge("AAC / MP3", "blue"));
  if (meta.explicit) badgeRow.appendChild(buildBadge("Explicit", "red"));
  badgeRow.appendChild(buildBadge(meta.album || "Unknown Album"));
  if (envEnabled) badgeRow.appendChild(buildBadge("CloudE Engine™", "gold"));
  if (meta.lyricsFetched) badgeRow.appendChild(buildBadge("Lyrics", "gold"));
}

function runCrossfadeVisual(meta) {
  if (reduceMotion) {
    trackTitle.textContent = meta.title || "Unknown Title";
    trackArtist.textContent = meta.artist || "Unknown Artist";
    return;
  }
  document.body.classList.add("crossfade-pulse");
  trackTitle.classList.add("text-fade");
  trackArtist.classList.add("text-fade");
  setTimeout(() => {
    trackTitle.textContent = meta.title || "Unknown Title";
    trackArtist.textContent = meta.artist || "Unknown Artist";
  }, 220);
  setTimeout(() => {
    trackTitle.classList.remove("text-fade");
    trackArtist.classList.remove("text-fade");
    document.body.classList.remove("crossfade-pulse");
  }, 520);
}

function swapBackground(url) {
  const activeBg = (bg1.style.opacity === "1") ? bg1 : bg2;
  const nextBg = (bg1.style.opacity === "1") ? bg2 : bg1;
  nextBg.style.backgroundImage = `url(${url})`;
  activeBg.style.opacity = "0";
  nextBg.style.opacity = "1";
}
function swapArtwork(url) {
  const activeArt = (art1.style.opacity === "1") ? art1 : art2;
  const nextArt = (art1.style.opacity === "1") ? art2 : art1;
  nextArt.style.backgroundImage = `url(${url})`;
  activeArt.style.opacity = "0";
  nextArt.style.opacity = "1";
}

function updateUI(meta, mode = "instant") {
  if (mode === "instant") {
    trackTitle.textContent = meta.title || "Unknown Title";
    trackArtist.textContent = meta.artist || "Unknown Artist";
  } else {
    runCrossfadeVisual(meta);
  }

  computeBadges(meta);
  favBtn.classList.toggle("active", favorites.has(meta.id));
  favBtn.style.opacity = favorites.has(meta.id) ? "1" : ".72";

  const cover = meta.cover || DEFAULT_ART;
  swapArtwork(cover);
  swapBackground(cover);

  miniArt.style.backgroundImage = `url(${cover})`;
  miniTitle.textContent = meta.title || "Unknown";
  miniArtist.textContent = meta.artist || "Unknown";
}

function setPlayState(playing) {
  if (playing) {
    playIcon.style.display = "none"; pauseIcon.style.display = "block";
    miniPlayIcon.style.display = "none"; miniPauseIcon.style.display = "block";
    nowPlaying.classList.remove("paused");
  } else {
    playIcon.style.display = "block"; pauseIcon.style.display = "none";
    miniPlayIcon.style.display = "block"; miniPauseIcon.style.display = "none";
    nowPlaying.classList.add("paused");
  }
}

function applyVolumeToAll(vol) {
  const a = document.getElementById("playerA");
  const b = document.getElementById("playerB");
  // Important: players stay at 1.0, masterGain controls output
  if (a) a.volume = 1;
  if (b) b.volume = 1;

  const ctx = ensureAudioContext();
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }
  // Smoothly ramp volume to avoid clicks
  const now = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setTargetAtTime(Number(vol), now, 0.1);
}

function coverFromPictureTag(pic) {
  try {
    if (!pic?.data?.length) return null;
    const bytes = new Uint8Array(pic.data);
    const blob = new Blob([bytes], { type: pic.format || "image/jpeg" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function trackIdFromFile(file) {
  const n = (file?.name || "").toLowerCase().trim();
  const s = file?.size || 0;
  const m = file?.lastModified || 0;
  return `trk_${btoa(unescape(encodeURIComponent(n))).slice(0, 24)}_${s}_${m}`;
}


function normalizeMeta(file, tags, cover) {
  const fallbackTitle = (file.name || "Unknown").replace(/\.[^/.]+$/, "");
  let title = (tags?.title || fallbackTitle).trim();
  let artist = (tags?.artist || "").trim();
  let album = (tags?.album || "").trim();
  if (!artist) artist = "Unknown Artist";
  if (!album) album = "Unknown Album";
  const low = `${title} ${artist}`.toLowerCase();
  const explicit = low.includes("explicit") || low.includes("[e]") || low.includes("(e)");
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const lossless = ["flac", "wav", "aiff", "alac"].includes(ext);
  const hires = lossless && (ext === "flac" || ext === "wav");
  return {
    id: trackIdFromFile(file),
    file, title, artist, album,
    cover: cover || DEFAULT_ART,
    duration: 0, explicit, lossless, hires,
    objectUrl: "", lyrics: "", lyricsFetched: false
  };
}


function rebuildAlbums() {
  albumsMap = new Map();
  library.forEach((t, idx) => {
    const albumKey = `${t.album}__${t.artist}`;
    if (!albumsMap.has(albumKey)) {
      albumsMap.set(albumKey, { key: albumKey, album: t.album || "Unknown Album", artist: t.artist || "Unknown Artist", cover: t.cover || DEFAULT_ART, tracks: [idx] });
    } else {
      albumsMap.get(albumKey).tracks.push(idx);
    }
  });
}

function renderLibrary() {
  const q = (libSearch.value || "").toLowerCase().trim();
  libCount.textContent = library.length;
  const songs = q ? library.filter(t => (`${t.title} ${t.artist} ${t.album}`).toLowerCase().includes(q)) : library;
  songsList.innerHTML = "";
  songs.forEach((t) => {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
    <div class="meta">
      <b>${escapeHtml(t.title)}</b>
      <small>${escapeHtml(t.artist)} • ${escapeHtml(t.album || "")}</small>
    </div>
    <div class="right"><div class="t">${t.duration ? formatTime(t.duration) : "--:--"}</div></div>`;
    item.onclick = () => startFromLibraryIndex(library.findIndex(x => x.id === t.id));
    songsList.appendChild(item);
  });
  rebuildAlbums();
  const albums = [...albumsMap.values()].filter(a => {
    if (!q) return true;
    return (`${a.album} ${a.artist}`).toLowerCase().includes(q);
  });
  albumsGrid.innerHTML = "";
  albums.forEach((a) => {
    const card = document.createElement("div");
    card.className = "album-card";
    card.innerHTML = `
    <div class="album-art" style="background-image:url('${a.cover || DEFAULT_ART}')"></div>
    <div class="album-info">
      <b>${escapeHtml(a.album)}</b>
      <small>${escapeHtml(a.artist)} • ${a.tracks.length} songs</small>
    </div>`;
    card.onclick = () => openAlbum(a.key);
    albumsGrid.appendChild(card);
  });
  renderQueue();
}

function renderAlbumView() {
  const album = albumsMap.get(currentAlbumKey);
  if (!album) return;
  albumTitle.textContent = album.album;
  albumSongs.innerHTML = "";
  album.tracks.forEach((idx) => {
    const t = library[idx];
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
    <div class="meta">
      <b>${escapeHtml(t.title)}</b>
      <small>${escapeHtml(t.artist)}</small>
    </div>
    <div class="right"><div class="t">${t.duration ? formatTime(t.duration) : "--:--"}</div></div>`;
    item.onclick = () => {
      queue = [...album.tracks];
      queueIndex = album.tracks.indexOf(idx);
      renderQueue();
      loadFromQueue(queueIndex, true);
    };
    albumSongs.appendChild(item);
  });
}

function renderQueue() {
  const q = (queueSearch.value || "").toLowerCase().trim();
  queueList.innerHTML = "";
  const list = queue.map((libIndex, idx) => ({ idx, track: library[libIndex] })).filter(x => x.track);
  const filtered = q ? list.filter(x => (`${x.track.title} ${x.track.artist}`).toLowerCase().includes(q)) : list;
  filtered.forEach(({ idx, track }) => {
    const item = document.createElement("div");
    item.className = "item";
    if (idx === queueIndex) item.style.outline = "1px solid rgba(255,255,255,.18)";
    item.innerHTML = `
    <div class="meta">
      <b>${escapeHtml(track.title)}</b>
      <small>${escapeHtml(track.artist)}</small>
    </div>
    <div class="right"><div class="t">${track.duration ? formatTime(track.duration) : "--:--"}</div></div>`;
    item.onclick = () => { queueIndex = idx; loadFromQueue(queueIndex, true); };
    queueList.appendChild(item);
  });
}

function getCurrentTrack() { return library[queue[queueIndex]]; }

function startFromLibraryIndex(libIndex) {
  if (!library[libIndex]) return;
  if (smartPlayMode) {
    queue = library.map((_, i) => i);
    queueIndex = libIndex;
  } else {
    queue = [libIndex];
    queueIndex = 0;
  }
  renderQueue();
  loadFromQueue(queueIndex, true);
}

// ---------- Lyrics ----------
const lyricsStatus = document.getElementById("lyricsStatus");
let lrcLines = [];
let activeLyricIndex = -1;

function parseLRC(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const lyricText = line.replace(/\[.*?\]/g, "").trim();
    for (const m of matches) {
      const mm = Number(m[1]);
      const ss = Number(m[2]);
      const t = (mm * 60) + ss;
      if (lyricText) out.push({ time: t, text: lyricText });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function renderLyrics(lines) {
  const wrap = document.getElementById("lyricsLines");
  if (!wrap) return;
  if (!lines || !lines.length) {
    wrap.innerHTML = `<div class="lyrics-empty">No lyrics loaded.</div>`;
    lrcLines = [];
    activeLyricIndex = -1;
    return;
  }
  wrap.innerHTML = "";
  lrcLines = lines;
  activeLyricIndex = -1;
  lines.forEach((L, idx) => {
    const div = document.createElement("div");
    div.className = "lyrics-line";
    div.textContent = L.text;
    div.onclick = () => {
      const p = getActive();
      if (p && isFinite(p.duration)) { p.currentTime = L.time; }
    };
    wrap.appendChild(div);
  });
}

function setActiveLyric(index) {
  const wrap = document.getElementById("lyricsLines");
  if (!wrap) return;
  const els = wrap.querySelectorAll(".lyrics-line");
  if (!els.length) return;
  els.forEach((el, i) => {
    el.classList.remove("active", "near");
    if (i === index) el.classList.add("active");
    else if (Math.abs(i - index) <= 1) el.classList.add("near");
  });
  const el = els[index];
  if (el) {
    const top = el.offsetTop - wrap.clientHeight / 2 + el.clientHeight / 2;
    wrap.scrollTo({ top, behavior: "smooth" });
  }
}

function updateLyricHighlight(currentTime) {
  if (!lrcLines.length) return;
  let idx = 0;
  for (let i = 0; i < lrcLines.length; i++) {
    if (currentTime >= lrcLines[i].time) idx = i;
    else break;
  }
  if (idx !== activeLyricIndex) {
    activeLyricIndex = idx;
    setActiveLyric(activeLyricIndex);
  }
}

function hasLRCTimestamps(text) {
  return /\[\d{1,2}:\d{2}(?:\.\d{1,2})?\]/.test(String(text || ""));
}

function showLyricsForTrack(track) {
  const lyricText = track?.lyrics || "";
  if (!lyricText.trim()) {
    renderLyrics([]);
    lyricsStatus.textContent = "No lyrics for this track";
    return;
  }
  if (hasLRCTimestamps(lyricText)) {
    renderLyrics(parseLRC(lyricText));
  } else {
    const simple = lyricText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    renderLyrics(simple.map((text, i) => ({ time: i * 9999, text })));
  }
  lyricsStatus.textContent = track.lyricsFetched ? "Fetched from LRCLIB ✅" : "Lyrics loaded ✅";
}

// ---------- LRCLIB Fetch ----------
const LS_LYRICS_CACHE = "cloud_player_lrclib_cache_v1";

function loadLyricsCache() {
  try { return JSON.parse(localStorage.getItem(LS_LYRICS_CACHE) || "{}"); }
  catch { return {}; }
}
function saveLyricsCache(cache) {
  localStorage.setItem(LS_LYRICS_CACHE, JSON.stringify(cache));
}

function cacheKeyForTrack(track) {
  const t = (track?.title || "").trim().toLowerCase();
  const a = (track?.artist || "").trim().toLowerCase();
  const al = (track?.album || "").trim().toLowerCase();
  return `${t}__${a}__${al}`;
}


function normalizeQuery(str) {
  return String(str || "").replace(/\(.*?\)|\[.*?\]/g, "").replace(/feat\.?|ft\.?/gi, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function pickBestLRCLibResult(results = [], title = "", artist = "") {
  const tt = String(title || "").toLowerCase().trim();
  const aa = String(artist || "").toLowerCase().trim();
  function seemsEnglish(text = "") {
    const s = String(text || "").replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim().slice(0, 800);
    if (!s) return false;
    let ascii = 0;
    for (const ch of s) if (ch.charCodeAt(0) < 128) ascii++;
    return (ascii / s.length) > 0.9;
  }
  const synced = results
    .filter(r => String(r?.syncedLyrics || "").trim().length > 0)
    .map(r => {
      const track = String(r.trackName || "").toLowerCase().trim();
      const art = String(r.artistName || "").toLowerCase().trim();
      const exactTitle = track === tt ? 1 : 0;
      const artistMatch = aa && art.includes(aa) ? 1 : 0;
      const en = seemsEnglish(r.syncedLyrics || "") ? 1 : 0;
      return { r, score: (exactTitle * 10) + (artistMatch * 6) + (en * 3) };
    })
    .sort((a, b) => b.score - a.score);
  if (synced.length) return synced[0].r;
  return results[0] || null;
}

async function fetchLyricsFromLRCLIB(track) {
  if (!track) return null;
  const title = normalizeQuery(track.title || "");
  const artist = normalizeQuery(track.artist || "");
  const album = normalizeQuery(track.album || "");
  if (!title) throw new Error("Missing title");
  const cache = loadLyricsCache();
  const key = cacheKeyForTrack(track);
  if (cache[key]) return cache[key];
  let url = "";
  if (artist && artist.toLowerCase() !== "unknown artist") {
    url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}&album_name=${encodeURIComponent(album)}`;
  } else {
    url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}`;
  }
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("LRCLIB request failed");
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error("No lyrics found");
  const best = pickBestLRCLibResult(data, title, artist);
  const lrc = String(best?.syncedLyrics || "").trim();
  if (!lrc) throw new Error("No synced LRC found");
  cache[key] = lrc;
  saveLyricsCache(cache);
  return lrc;
}

async function autoFetchLyricsForTrack(track) {
  if (!track) return;
  if (track._lyricsLoading) return;
  if (track.lyrics && String(track.lyrics).trim()) return;

  track._lyricsLoading = true;
  try {
    const text = await fetchLyricsFromLRCLIB(track);
    track.lyrics = text;
    track.lyricsFetched = true;

    // Only show if this is current track
    if (track.id === getCurrentTrack()?.id) {
      showLyricsForTrack(track);
      updateUI(track);
    }
  } catch (e) {
  } finally {
    track._lyricsLoading = false;
  }
}


async function fetchLyricsForCurrentTrack() {
  const track = getCurrentTrack();
  if (!track) { alert("No track playing"); return; }
  openPanel(lyricsPanel);
  lyricsStatus.textContent = "Fetching lyrics from LRCLIB…";
  document.getElementById("btnFetchLyrics").disabled = true;
  try {
    const text = await fetchLyricsFromLRCLIB(track);
    track.lyrics = text;
    track.lyricsFetched = true;
    showLyricsForTrack(track);
    updateUI(track);
  } catch (err) {
    lyricsStatus.textContent = "Not found ❌";
    alert("Lyrics not found on LRCLIB.");
  } finally {
    document.getElementById("btnFetchLyrics").disabled = false;
  }
}

function clearLyricsForCurrent() {
  const track = getCurrentTrack();
  if (!track) return;
  track.lyrics = "";
  track.lyricsFetched = false;
  const cache = loadLyricsCache();
  const key = cacheKeyForTrack(track);
  delete cache[key];
  saveLyricsCache(cache);
  showLyricsForTrack(track);
  updateUI(track);
}

// ----- Player engine -----
function setupPlayer(p) {
  p.onended = () => {
    if (repeatMode === 2) { p.currentTime = 0; p.play(); return; }
    if (!transitionTriggeredForCurrent) nextSong();
  };
  p.ontimeupdate = () => {
    if (p.id !== activePlayerId) return;
    updateProgress(p);
    updateLyricHighlight(p.currentTime);
    if (!p.paused && !isTransitioning && !transitionTriggeredForCurrent && queue.length > 1) {
      if (crossfadeMode && p.duration - p.currentTime <= CROSSFADE_TIME) nextSong();
      else if (!crossfadeMode && gaplessMode && p.duration - p.currentTime <= 0.25) nextSong();
    }
  };
}

setupPlayer(document.getElementById("playerA"));
setupPlayer(document.getElementById("playerB"));

async function loadFromQueue(qIndex, autoPlay = true) {
  if (isTransitioning) return;
  const libIndex = queue[qIndex];
  const track = library[libIndex];
  if (!track) return;

  isTransitioning = true;
  transitionTriggeredForCurrent = true;

  const currentP = getActive();
  const nextP = getInactive();

  nextP.src = track.objectUrl;
  nextP.load();

  // Route audio properly for the next player before we start
  routePlayerOutput(nextP);

  updateUI(track, crossfadeMode ? "crossfade" : "instant");
  showLyricsForTrack(track);
  if (autoLyrics) autoFetchLyricsForTrack(track);
  async function prefetchLyricsAroundCurrent() {
    try {
      // current + next 2
      const indices = [queueIndex, queueIndex + 1, queueIndex + 2]
        .map(i => (i % queue.length))
        .filter(i => queue[i] !== undefined);

      for (const qi of indices) {
        const t = library[queue[qi]];
        if (t) autoFetchLyricsForTrack(t);
      }

      // If current queue is a full album queue → prefetch remaining album
      const isAlbumQueue =
        currentAlbumKey &&
        albumsMap.has(currentAlbumKey) &&
        (() => {
          const album = albumsMap.get(currentAlbumKey);
          if (!album) return false;
          if (queue.length !== album.tracks.length) return false;
          return queue.every((x, i) => x === album.tracks[i]);
        })();

      if (isAlbumQueue) {
        const album = albumsMap.get(currentAlbumKey);
        if (album) {
          for (const libIndex of album.tracks) {
            const t = library[libIndex];
            if (t) autoFetchLyricsForTrack(t);
          }
        }
      }
    } catch (e) { }
  }

  if (autoLyrics) {
    autoFetchLyricsForTrack(track);
    prefetchLyricsAroundCurrent(); // ✅ ADD THIS
  }


  if (autoPlay) {
    nextP.volume = 1;

    // Start Silent for crossfade
    if (crossfadeMode) {
      try {
        const g = getPlayerGain(nextP);
        g.gain.cancelScheduledValues(0);
        g.gain.value = 0.0001;
      } catch { }
    }

    try {
      await enableEnvIfNeeded();
      await nextP.play();
      setPlayState(true);

      if (crossfadeMode && !currentP.paused && currentP.src) {
        // BRO TIP: We pass routePlayerOutput as the callback so when swap happens
        // we ensure the finished player is reset properly
        crossfade(currentP, nextP, () => swapPlayers(currentP, nextP));
      } else {
        currentP.pause(); currentP.currentTime = 0;
        swapPlayers(currentP, nextP);
      }
    } catch {
      setPlayState(false);
      isTransitioning = false;
      transitionTriggeredForCurrent = false;
    }
  } else {
    isTransitioning = false;
    transitionTriggeredForCurrent = false;
  }
}

function swapPlayers(oldP, newP) {
  activePlayerId = newP.id;
  isTransitioning = false;
  transitionTriggeredForCurrent = false;

  oldP.pause(); oldP.currentTime = 0; oldP.volume = 1;

  // Reset gains
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;

  try {
    const gOld = getPlayerGain(oldP);
    gOld.gain.cancelScheduledValues(now);
    gOld.gain.setValueAtTime(0.0001, now);
  } catch { }

  try {
    const gNew = getPlayerGain(newP);
    gNew.gain.cancelScheduledValues(now);
    gNew.gain.setValueAtTime(volSlider.valueAsNumber, now);
  } catch { }

  newP.volume = 1;
  routePlayerOutput(newP);
}

function crossfade(outP, inP, done) {
  const ctx = ensureAudioContext();
  ctx.resume?.().catch(() => { });

  const outG = getPlayerGain(outP);
  const inG = getPlayerGain(inP);

  const now = ctx.currentTime;
  const dur = CROSSFADE_TIME;
  const target = volSlider.valueAsNumber;

  // We use equal-power crossfade curve
  // This maintains constant energy during the transition
  const steps = 60; // Less steps reduces "zipper" noise potential
  const inCurve = new Float32Array(steps);
  const outCurve = new Float32Array(steps);

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // Standard Equal Power Sine Curve
    const angle = t * (Math.PI / 2);
    inCurve[i] = Math.sin(angle) * target;
    outCurve[i] = Math.cos(angle) * target;
  }

  // Safe automation
  outG.gain.cancelScheduledValues(now);
  inG.gain.cancelScheduledValues(now);

  // Set anchor points to prevent popping
  outG.gain.setValueAtTime(outG.gain.value, now);
  inG.gain.setValueAtTime(0.0001, now);

  outG.gain.setValueCurveAtTime(outCurve, now, dur);
  inG.gain.setValueCurveAtTime(inCurve, now, dur);

  setTimeout(done, dur * 1000 + 50);
}


function updateProgress(p) {
  if (!isFinite(p.duration)) return;
  const pct = (p.currentTime / p.duration) * 100;
  progressFill.style.width = pct + "%";
  miniProgressFill.style.width = pct + "%";
  currTime.textContent = formatTime(p.currentTime);
  remTime.textContent = "-" + formatTime(p.duration - p.currentTime);
}

let dragging = false;
function seekTo(clientX) {
  const p = getActive();
  if (!isFinite(p.duration)) return;
  const rect = progressBar.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const ratio = x / rect.width;
  p.currentTime = ratio * p.duration;
  updateProgress(p);
}
function previewAt(clientX) {
  const p = getActive();
  const rect = progressBar.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const ratio = rect.width ? x / rect.width : 0;
  const time = isFinite(p.duration) ? ratio * p.duration : 0;
  previewTime.textContent = formatTime(time);
  previewTime.style.left = x + "px";
}
progressBar.addEventListener("mousemove", e => previewAt(e.clientX));
progressBar.addEventListener("mousedown", e => { dragging = true; seekTo(e.clientX) });
document.addEventListener("mousemove", e => dragging && seekTo(e.clientX));
document.addEventListener("mouseup", () => dragging = false);

async function togglePlay() {
  const p = getActive();
  if (!p.src) return;
  if (p.paused) {
    await enableEnvIfNeeded();
    // Ensure gain is up
    const g = getPlayerGain(p);
    g.gain.cancelScheduledValues(0);
    g.gain.value = volSlider.valueAsNumber;

    p.play();
    setPlayState(true);
  } else {
    p.pause();
    setPlayState(false);
  }
}

function nextSong() {
  if (queue.length === 0) return;
  if (repeatMode === 0 && queueIndex === queue.length - 1) {
    const p = getActive(); p.pause(); setPlayState(false); return;
  }
  queueIndex = isShuffle ? Math.floor(Math.random() * queue.length) : (queueIndex + 1) % queue.length;
  renderQueue();
  loadFromQueue(queueIndex, true);
}
function prevSong() {
  if (queue.length === 0) return;
  queueIndex = Math.max(0, queueIndex - 1);
  renderQueue();
  loadFromQueue(queueIndex, true);
}
function toggleShuffle() {
  isShuffle = !isShuffle;
  shuffleBtn.classList.toggle("active", isShuffle);
  shuffleBtn.style.opacity = isShuffle ? "1" : ".72";
}
function toggleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  repeatBtn.classList.toggle("active", repeatMode !== 0);
  repeatBtn.style.opacity = repeatMode !== 0 ? "1" : ".72";
}
function toggleFavCurrent() {
  const t = getCurrentTrack(); if (!t) return;
  if (favorites.has(t.id)) favorites.delete(t.id);
  else favorites.add(t.id);
  localStorage.setItem(LS_FAV, JSON.stringify([...favorites]));
  updateUI(t);
}

miniPlayBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); };
miniNextBtn.onclick = (e) => { e.stopPropagation(); nextSong(); };
miniOpen.onclick = () => openNowPlaying();

volSlider.oninput = () => {
  applyVolumeToAll(volSlider.valueAsNumber);
};

shuffleBtn.onclick = toggleShuffle;
repeatBtn.onclick = toggleRepeat;
favBtn.onclick = toggleFavCurrent;
playBtn.onclick = togglePlay;
prevBtn.onclick = prevSong;
nextBtn.onclick = nextSong;

document.getElementById("btnLibrary").onclick = () => openLibrary();
document.getElementById("btnBack").onclick = () => openNowPlaying();
document.getElementById("btnAlbumBack").onclick = () => openLibrary("albums");
document.getElementById("btnPlayAlbum").onclick = () => {
  const album = albumsMap.get(currentAlbumKey);
  if (!album) return;
  queue = [...album.tracks]; queueIndex = 0;
  renderQueue();
  loadFromQueue(queueIndex, true);
};

// --- FIX: LYRICS SWAP LOGIC ---
document.getElementById("btnLyrics").onclick = async () => {
  const t = getCurrentTrack();
  if (t) await autoFetchLyricsForTrack(t);

  const stage = document.querySelector(".stage");
  const app = document.querySelector(".app");
  const lyricsPanel = document.getElementById("lyricsPanel");
  const btn = document.getElementById("btnLyrics");

  // MOBILE LOGIC: Swap Poster
  if (window.innerWidth <= 900) {
    const isLyricsActive = stage.classList.contains("lyrics-active");

    if (isLyricsActive) {
      // TURN OFF: Fade out lyrics, Fade in Art
      stage.classList.remove("lyrics-active");
      btn.classList.remove("active-btn");
      
      // Move panel back to body after transition (300ms)
      setTimeout(() => {
        if(!stage.classList.contains("lyrics-active")) {
           app.appendChild(lyricsPanel);
           lyricsPanel.classList.remove("open");
        }
      }, 300);

    } else {
      // TURN ON: Move Lyrics INTO stage
      stage.appendChild(lyricsPanel);
      
      // Force layout recalc
      void lyricsPanel.offsetWidth; 
      
      lyricsPanel.classList.add("open"); // Ensure it's visible block
      stage.classList.add("lyrics-active"); // Trigger CSS Fade/Scale
      btn.classList.add("active-btn");
    }
  } 
  // DESKTOP LOGIC: Standard Sidebar
  else {
    lyricsPanel.classList.add("lyrics-minimal");
    openPanel(lyricsPanel);
  }
};
document.getElementById("btnMenu").onclick = () => openPanel(menuPanel);
document.getElementById("btnQueue").onclick = () => openPanel(queuePanel);
btnFX.onclick = () => {
  openPanel(fxPanel);
  updateFxValuesUI();
};
document.getElementById("btnCloseLyrics").onclick = () => { lyricsPanel.classList.remove("lyrics-minimal"); closePanel(lyricsPanel); };
lyricsPanel.addEventListener("click", (e) => {
  if (window.innerWidth <= 900 && e.target === lyricsPanel) {
    lyricsPanel.classList.remove("lyrics-minimal");
    closePanel(lyricsPanel);
  }
});
document.getElementById("btnCloseMenu").onclick = () => closePanel(menuPanel);
document.getElementById("btnCloseQueue").onclick = () => closePanel(queuePanel);
document.getElementById("btnCloseFX").onclick = () => closePanel(fxPanel);
document.getElementById("lyricsPanel").onclick = (e) => {
  if (window.innerWidth <= 900 && e.target.classList.contains("panel-body")) {
    closePanel(document.getElementById("lyricsPanel"));
  }
};

document.getElementById("btnAddSongs").onclick = () => document.getElementById("fileInput").click();
document.getElementById("btnAddSongs2").onclick = () => document.getElementById("fileInput").click();

document.getElementById("btnFetchLyrics").onclick = fetchLyricsForCurrentTrack;
document.getElementById("btnClearLyrics").onclick = clearLyricsForCurrent;

tabSongs.onclick = () => { setTabs("songs"); renderLibrary() };
tabAlbums.onclick = () => { setTabs("albums"); renderLibrary() };
libSearch.oninput = renderLibrary;
queueSearch.oninput = renderQueue;

swSmart.onchange = () => smartPlayMode = swSmart.checked;
swGapless.onchange = () => {
  gaplessMode = swGapless.checked;
  if (gaplessMode) { crossfadeMode = false; swCrossfade.checked = false; }
};
swCrossfade.onchange = () => {
  crossfadeMode = swCrossfade.checked;
  if (crossfadeMode) { gaplessMode = false; swGapless.checked = false; }
};

swEnvOn.checked = envEnabled;
envPreset.value = envPresetName;
envStrength.value = String(envStrength);
swSeparation.checked = envSeparation;
envBass.value = String(envBass);
envClarity.value = String(envClarity);

document.getElementById("envPills")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".fx-pill");
  if (!btn) return;
  envPresetName = btn.dataset.env;
  localStorage.setItem(LS_ENV_PRESET, envPresetName);
  const envPresetEl = document.getElementById("envPreset");
  if (envPresetEl) envPresetEl.value = envPresetName;
  applyEnvSettings();
  updateFxValuesUI();
});

function presetLabel(name) {
  return ({ studio: "Studio", cinema: "Cinema", concert: "Concert", car: "Car", night: "Night" })[name] || "Studio";
}

function updateFxActiveLabel() {
  const el = document.getElementById("fxActiveLabel");
  if (!el) return;
  const envText = presetLabel(envPresetName);
  const status = envEnabled ? "✅" : "⏸️";
  el.textContent = `Active: ${envText} ${status}`;
  document.body.classList.toggle("env-enabled", envEnabled);
}

swEnvOn.onchange = async () => {
  envEnabled = swEnvOn.checked;
  localStorage.setItem(LS_ENV_ON, envEnabled ? "1" : "0");
  await enableEnvIfNeeded();
  applyEnvSettings();
  const t = getCurrentTrack();
  if (t) updateUI(t);

  // Re-route the current active player to correct path
  const p = getActive();
  if (p) routePlayerOutput(p);

  updateFxValuesUI();
};

envStrength.oninput = () => {
  envStrength = Number(document.getElementById("envStrength").value);
  localStorage.setItem(LS_ENV_STRENGTH, String(envStrength));
  applyEnvSettings();
};
swSeparation.onchange = () => {
  envSeparation = swSeparation.checked;
  localStorage.setItem(LS_ENV_SEP, envSeparation ? "1" : "0");
  applyEnvSettings();
};
envBass.oninput = () => {
  envBass = Number(document.getElementById("envBass").value);
  localStorage.setItem(LS_ENV_BASS, String(envBass));
  applyEnvSettings();
};
envClarity.oninput = () => {
  envClarity = Number(document.getElementById("envClarity").value);
  localStorage.setItem(LS_ENV_CLARITY, String(envClarity));
  applyEnvSettings();
};

function downloadCurrent() {
  const t = getCurrentTrack(); if (!t) return;
  const a = document.createElement("a");
  a.href = t.objectUrl;
  a.download = t.file.name;
  a.click();
}
async function shareCurrent() {
  const t = getCurrentTrack(); if (!t) return;
  const text = `${t.title} — ${t.artist} (${t.album})`;
  try { await navigator.clipboard.writeText(text); alert("Copied!"); }
  catch { prompt("Copy:", text); }
}
document.getElementById("btnDownload").onclick = downloadCurrent;
document.getElementById("btnShare").onclick = shareCurrent;

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    try {
      const ctx = ensureAudioContext();
      ctx.resume().catch(() => { });
    } catch { }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target?.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowRight") nextSong();
  if (e.code === "ArrowLeft") prevSong();
  if (e.key === "Escape") { closePanel(lyricsPanel); closePanel(menuPanel); closePanel(queuePanel); closePanel(fxPanel); }
  if (e.key === "L") { openPanel(lyricsPanel); }
});

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  for (const file of files) {
    const objectUrl = URL.createObjectURL(file);
    let tags = null; let cover = null;
    try {
      await new Promise((resolve) => {
        jsmediatags.read(file, {
          onSuccess: (tag) => { tags = tag.tags; resolve(); },
          onError: () => resolve()
        });
      });
      cover = coverFromPictureTag(tags?.picture);
    } catch { }
    const meta = normalizeMeta(file, tags, cover);
    meta.objectUrl = objectUrl;
    await new Promise((resolve) => {
      const temp = new Audio();
      temp.src = objectUrl;
      temp.addEventListener("loadedmetadata", () => { meta.duration = temp.duration || 0; resolve(); }, { once: true });
      temp.addEventListener("error", () => resolve(), { once: true });
    });
    library.push(meta);
  }
  libCount.textContent = library.length;
  renderLibrary();
  if (queue.length === 0 && library.length > 0) {
    queue = library.map((_, i) => i);
    queueIndex = 0;
    const first = library[0];
    bg1.style.backgroundImage = `url(${first.cover || DEFAULT_ART})`;
    bg2.style.backgroundImage = `url(${first.cover || DEFAULT_ART})`;
    art1.style.backgroundImage = `url(${first.cover || DEFAULT_ART})`;
    art2.style.backgroundImage = `url(${first.cover || DEFAULT_ART})`;
    updateUI(first);
    showLyricsForTrack(first);
    loadFromQueue(0, false);
  }
});

function setFxPillActive(value) {
  const pills = document.querySelectorAll("#envPills .fx-pill");
  pills.forEach(p => p.classList.toggle("active", p.dataset.env === value));
}

function updateFxValuesUI() {
  const strengthEl = document.getElementById("envStrengthValue");
  const bassEl = document.getElementById("envBassValue");
  const clarityEl = document.getElementById("envClarityValue");
  if (strengthEl) strengthEl.textContent = `${envStrength}%`;
  if (bassEl) bassEl.textContent = `${envBass >= 0 ? "+" : ""}${envBass} dB`;
  if (clarityEl) clarityEl.textContent = `${envClarity >= 0 ? "+" : ""}${envClarity} dB`;
  setFxPillActive(envPresetName);
  updateFxActiveLabel();
}

document.addEventListener("DOMContentLoaded", () => {
  const swReduceMotion = document.getElementById("swReduceMotion");
  const swAutoLyrics = document.getElementById("swAutoLyrics");
  if (swReduceMotion) {
    swReduceMotion.checked = reduceMotion;
    swReduceMotion.onchange = (e) => {
      reduceMotion = e.target.checked;
      localStorage.setItem("cloude_reduce_motion", reduceMotion ? "1" : "0");
      document.body.classList.toggle("reduce-motion", reduceMotion);
    };
  }
  if (swAutoLyrics) {
    swAutoLyrics.checked = autoLyrics;
    swAutoLyrics.onchange = (e) => {
      autoLyrics = e.target.checked;
      localStorage.setItem("cloude_auto_lyrics", autoLyrics ? "1" : "0");
    };
  }
  document.body.classList.toggle("reduce-motion", reduceMotion);
});

updateFxValuesUI();

const strength = document.getElementById("envStrength");
const bass = document.getElementById("envBass");
const clarity = document.getElementById("envClarity");
strength?.addEventListener("input", updateFxValuesUI);
bass?.addEventListener("input", updateFxValuesUI);
clarity?.addEventListener("input", updateFxValuesUI);

const envPresetEl = document.getElementById("envPreset");
envPresetEl.value = envPresetName;
envPresetEl.onchange = () => {
  envPresetName = envPresetEl.value;
  localStorage.setItem(LS_ENV_PRESET, envPresetName);
  applyEnvSettings();
  updateFxValuesUI();
};

// --- FIX: RE-BIND BUTTONS EXPLICITLY ---
const btnShuffle = document.getElementById("shuffleBtn");
const btnRepeat = document.getElementById("repeatBtn");

if(btnShuffle) btnShuffle.onclick = (e) => {
    e.stopPropagation(); 
    toggleShuffle(); 
    // Visual update immediately
    btnShuffle.classList.toggle("active", isShuffle);
    btnShuffle.style.opacity = isShuffle ? "1" : ".72";
};

if(btnRepeat) btnRepeat.onclick = (e) => {
    e.stopPropagation();
    toggleRepeat();
    // Visual update
    btnRepeat.classList.toggle("active", repeatMode !== 0);
    btnRepeat.style.opacity = repeatMode !== 0 ? "1" : ".72";
};

bg1.style.backgroundImage = `url(${DEFAULT_ART})`;
bg2.style.backgroundImage = `url(${DEFAULT_ART})`;
art1.style.backgroundImage = `url(${DEFAULT_ART})`;
art2.style.backgroundImage = `url(${DEFAULT_ART})`;
applyVolumeToAll(1);