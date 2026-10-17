const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fmtTime = (seconds, frames = false) => {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const centi = Math.floor((s % 1) * (frames ? 30 : 100));
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(centi).padStart(2,'0')}`;
};
const fmtShort = seconds => {
  const s = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
};
const bytesLabel = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024*1024)).toFixed(1)} MB`;
const extOf = name => (String(name).match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const TRACK_ORDER = { V1: 1, V2: 2, A1: 3, T1: 4 };
const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"></use></svg>`;

let assets = [];
let clips = [];
let selectedClipId = null;
let selectedAssetId = null;
let playhead = 0;
let isPlaying = false;
let rafId = 0;
let lastTick = 0;
let scale = 46;
let activeFilter = 'all';
let listView = false;
let pendingTrack = null;
let audioContext = null;
let masterGain = null;
let recordDestination = null;
let audioNodes = new Map();
let undoStack = [];
let redoStack = [];
let isExporting = false;
let exportRecorder = null;
let exportCancelled = false;
let dirty = false;
let projectSettings = { width: 1280, height: 720, aspect: '16:9', fps: 30 };
let isDraggingTimeline = false;
let liveDrag = null;
let pendingProjectData = null;
let localMediaEngineAvailable = false;
let localMediaEngineVersion = '';
let formatProfiles = []; // Runtime-detected browser and local FFmpeg output profiles.

const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const mediaInput = $('#mediaInput');
const projectInput = $('#projectInput');
const relinkInput = $('#relinkInput');
const timelineInner = $('#timelineInner');
const timelineScroller = $('#timelineScroller');
const inspectorContent = $('#inspectorContent');

function toast(message, type = 'success', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${type === 'error' ? '!' : type === 'info' ? 'i' : '✓'}</span><span>${esc(message)}</span>`;
  $('#toastStack').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(4px)'; setTimeout(() => el.remove(), 220); }, duration);
}
function setStatus(message) { $('#appStatus').textContent = message; }
function markDirty() { dirty = true; $('#saveStatus').textContent = 'Unsaved changes'; }
function setSaved() { dirty = false; $('#saveStatus').textContent = 'Saved locally'; setTimeout(() => { if (!dirty) $('#saveStatus').textContent = 'Project ready'; }, 2800); }
function assetById(id) { return assets.find(a => a.id === id); }
function clipById(id = selectedClipId) { return clips.find(c => c.id === id); }
function durationOf(clip) {
  if (!clip) return 0;
  if (clip.kind === 'text') return Math.max(.1, Number(clip.duration) || 3);
  return Math.max(.1, ((Number(clip.outPoint) || 0) - (Number(clip.inPoint) || 0)) / Math.max(.1, Number(clip.speed) || 1));
}
function clipEnd(clip) { return clip.start + durationOf(clip); }
function projectDuration() { return Math.max(0, ...clips.map(clipEnd)); }
function totalSourceSize() { return assets.reduce((sum, a) => sum + (a.size || 0), 0); }
function serializeClip(c) {
  const output = {};
  for (const key of ['id','assetId','kind','track','name','start','inPoint','outPoint','speed','volume','mute','opacity','brightness','contrast','saturation','rotation','fit','look','vignette','mirror','grain','duration','content','fontSize','fontFamily','color','textBackground','bold','italic','align','xPos','yPos','stroke','strokeWidth']) {
    if (c[key] !== undefined) output[key] = c[key];
  }
  return output;
}
function snapshotHistory() {
  return { clips: clips.map(serializeClip), projectSettings: {...projectSettings}, selectedClipId, playhead };
}
function recordHistory() {
  undoStack.push(snapshotHistory());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndoRedo();
}
function updateUndoRedo() { $('#undoBtn').disabled = !undoStack.length; $('#redoBtn').disabled = !redoStack.length; }
function disposeClipMedia(clip) {
  try { clip.mediaEl?.pause(); } catch {}
  const node = audioNodes.get(clip.id);
  if (node) { try { node.source.disconnect(); node.gain.disconnect(); } catch {} audioNodes.delete(clip.id); }
}
function createMediaElementForClip(clip) {
  const asset = assetById(clip.assetId);
  if (!asset || clip.kind === 'text') return;
  disposeClipMedia(clip);
  if (clip.kind === 'image') {
    const img = new Image(); img.decoding = 'async'; img.src = asset.url; clip.mediaEl = img;
  } else {
    const media = document.createElement(clip.kind === 'audio' ? 'audio' : 'video');
    media.preload = 'auto'; media.src = asset.url; media.playsInline = true; media.volume = 1; media.muted = false;
    media.addEventListener('error', () => { asset.playbackError = true; if (selectedAssetId === asset.id || selectedClipId === clip.id) renderInspector(); }, { once: true });
    clip.mediaEl = media;
  }
  if (audioContext && (clip.kind === 'audio' || clip.kind === 'video')) connectClipAudio(clip);
}
function restoreHistory(entry) {
  pausePlayback();
  clips.forEach(disposeClipMedia);
  clips = entry.clips.map(c => ({...c}));
  projectSettings = {...entry.projectSettings};
  selectedClipId = clips.some(c => c.id === entry.selectedClipId) ? entry.selectedClipId : null;
  playhead = entry.playhead || 0;
  clips.forEach(createMediaElementForClip);
  updateProjectCanvasSize(); renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotHistory()); const entry = undoStack.pop(); restoreHistory(entry); updateUndoRedo(); toast('Undo complete', 'info', 1600);
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotHistory()); const entry = redoStack.pop(); restoreHistory(entry); updateUndoRedo(); toast('Redo complete', 'info', 1600);
}
function getMime(file) {
  if (file.type) return file.type;
  const ext = extOf(file.name);
  const map = {
    mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',mkv:'video/x-matroska',avi:'video/x-msvideo',webm:'video/webm',ogv:'video/ogg',ogm:'video/ogg',mpg:'video/mpeg',mpeg:'video/mpeg',mpe:'video/mpeg',ts:'video/mp2t',mts:'video/mp2t',m2t:'video/mp2t',m2ts:'video/mp2t',flv:'video/x-flv',f4v:'video/x-f4v',wmv:'video/x-ms-wmv',asf:'video/x-ms-asf',mxf:'video/x-mxf',vob:'video/dvd',rm:'application/vnd.rn-realmedia',rmvb:'application/vnd.rn-realmedia-vbr',divx:'video/x-divx','3gp':'video/3gpp','3g2':'video/3gpp2',
    mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',aac:'audio/aac',m4a:'audio/mp4',m4b:'audio/mp4',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/opus',aiff:'audio/aiff',aif:'audio/aiff',aifc:'audio/aiff',wma:'audio/x-ms-wma',mka:'audio/x-matroska',ape:'audio/ape',alac:'audio/alac',ac3:'audio/ac3',eac3:'audio/eac3',amr:'audio/amr',dts:'audio/vnd.dts',caf:'audio/x-caf',au:'audio/basic',snd:'audio/basic',ra:'audio/vnd.rn-realaudio',wv:'audio/x-wavpack',tta:'audio/x-tta',mid:'audio/midi',midi:'audio/midi',spx:'audio/ogg',voc:'audio/x-voc',
    jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff',heic:'image/heic',heif:'image/heif',avif:'image/avif',jxl:'image/jxl',jp2:'image/jp2',j2k:'image/j2k',ppm:'image/x-portable-pixmap',pgm:'image/x-portable-graymap',pbm:'image/x-portable-bitmap',pnm:'image/x-portable-anymap',tga:'image/x-tga',exr:'image/x-exr',hdr:'image/vnd.radiance',psd:'image/vnd.adobe.photoshop',dng:'image/x-adobe-dng',cr2:'image/x-canon-cr2',nef:'image/x-nikon-nef',arw:'image/x-sony-arw',raf:'image/x-fuji-raf',orf:'image/x-olympus-orf',rw2:'image/x-panasonic-rw2',svg:'image/svg+xml'
  };
  return map[ext] || 'application/octet-stream';
}
function getKind(file) {
  const type = getMime(file), ext = extOf(file.name);
  if (type.startsWith('audio/') || ['mp3','wav','flac','aac','m4a','m4b','ogg','oga','opus','aiff','aif','aifc','wma','mka','ape','alac','ac3','eac3','amr','dts','caf','au','snd','ra','wv','tta','mid','midi','spx','voc'].includes(ext)) return 'audio';
  if (type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','tif','tiff','heic','heif','avif','jxl','jp2','j2k','ppm','pgm','pbm','pnm','tga','exr','hdr','psd','dng','cr2','nef','arw','raf','orf','rw2','svg'].includes(ext)) return 'image';
  return 'video';
}
function makeAsset(file, id = uid(), preset = {}) {
  const kind = preset.kind || getKind(file);
  const url = URL.createObjectURL(file);
  const asset = { id, name: file.name, type: getMime(file), kind, size: file.size || 0, duration: preset.duration || (kind === 'image' ? 5 : kind === 'audio' ? 180 : 10), url, file, lastModified: file.lastModified, playbackError: false, ...preset };
  asset.file = file; asset.url = url; asset.lastModified = file.lastModified;
  return asset;
}
function inspectAssetDuration(asset) {
  if (asset.kind === 'image') {
    if (!asset.type.includes('svg')) { const img = new Image(); img.onload = () => { asset.width = img.naturalWidth; asset.height = img.naturalHeight; renderLibrary(); }; img.src = asset.url; }
    return;
  }
  const probe = document.createElement(asset.kind === 'audio' ? 'audio' : 'video');
  probe.preload = 'metadata'; probe.muted = true; probe.src = asset.url;
  probe.onloadedmetadata = () => {
    const previousDuration = asset.duration;
    if (Number.isFinite(probe.duration) && probe.duration > 0) asset.duration = probe.duration;
    if (asset.duration !== previousDuration) clips.filter(c => c.assetId === asset.id && c.inPoint === 0 && Math.abs((c.outPoint || 0) - previousDuration) < .15).forEach(c => { c.outPoint = asset.duration; });
    asset.width = probe.videoWidth || 0; asset.height = probe.videoHeight || 0;
    asset.metadataError = false; renderLibrary();
    // Update any clip that was created before metadata was ready.
    renderTimeline(); renderPreview(); updateTimelineInfo();
  };
  probe.onerror = () => { asset.metadataError = true; renderLibrary(); };
}
async function importFiles(fileList, {track = null} = {}) {
  const files = [...fileList].filter(f => f && f.size >= 0);
  if (!files.length) return;
  let added = 0;
  for (const file of files) {
    if (assets.some(a => a.name === file.name && a.size === file.size && a.lastModified === file.lastModified)) continue;
    const asset = makeAsset(file); asset.lastModified = file.lastModified;
    assets.push(asset); inspectAssetDuration(asset); added++;
    if (track) addAssetToTimeline(asset, track, false);
  }
  renderLibrary(); updateTimelineInfo(); markDirty();
  if (added) toast(`${added} media file${added === 1 ? '' : 's'} imported`, 'success');
  if (track) { renderTimeline(); renderInspector(); renderPreview(); }
  setStatus(added ? `${added} media file${added===1?'':'s'} imported` : 'No new files added');
}
function assetIcon(asset) {
  if (asset.kind === 'audio') return icon('audio');
  if (asset.kind === 'image') return '<span style="font-size:22px">▧</span>';
  return icon('film');
}
function renderLibrary() {
  $('#assetCount').textContent = assets.length;
  $('#allCount').textContent = assets.length;
  $('#librarySize').textContent = `${(totalSourceSize() / (1024*1024)).toFixed(totalSourceSize() < 10*1024*1024 ? 1 : 0)} MB`;
  const query = $('#mediaSearch').value.trim().toLowerCase();
  const shown = assets.filter(a => (activeFilter === 'all' || a.kind === activeFilter) && a.name.toLowerCase().includes(query));
  const grid = $('#assetGrid'); grid.classList.toggle('list-view', listView);
  if (!shown.length) {
    grid.innerHTML = `<div class="empty-library"><span class="empty-glyph">${assets.length ? '⌕' : '＋'}</span><strong>${assets.length ? 'No matching media' : 'Your media goes here'}</strong><span>${assets.length ? 'Try a different search or filter.' : 'Import files to start editing.'}</span></div>`; return;
  }
  grid.innerHTML = shown.map(a => {
    const thumb = a.kind === 'image' && !a.type.includes('svg') ? `<img src="${a.url}" alt="">` : `<span class="asset-icon">${assetIcon(a)}</span>`;
    const warning = a.metadataError ? '<span class="asset-type-label" style="background:#64353b">CHECK FORMAT</span>' : `<span class="asset-type-label">${esc(extOf(a.name) || a.kind)}</span>`;
    return `<article class="asset-card ${selectedAssetId === a.id ? 'selected' : ''}" data-asset-id="${a.id}" tabindex="0" title="Double-click to add to timeline"><div class="asset-thumb">${thumb}${warning}<span class="asset-duration">${a.kind === 'image' ? 'STILL' : fmtShort(a.duration)}</span><button class="asset-add" data-add-asset="${a.id}" title="Add to timeline">${icon('plus')}</button></div><div class="asset-meta"><span class="asset-name">${esc(a.name)}</span><div class="asset-details"><span>${a.width && a.height ? `${a.width}×${a.height}` : a.kind.toUpperCase()}</span><span>${bytesLabel(a.size)}</span></div></div></article>`;
  }).join('');
}
function setPanel(panelId) {
  $$('.panel-view').forEach(p => p.classList.toggle('active', p.id === panelId));
  $$('.rail-tool[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === panelId));
  const labels = {mediaPanel:'Media Library',editPanel:'Edit Tools',effectsPanel:'Effects',audioPanel:'Audio Tools',textPanel:'Text & Titles'};
  $('#panelTitle').textContent = labels[panelId] || 'Media Library';
  $('#stageMode').textContent = labels[panelId] || 'Preview';
}
function addAssetToTimeline(asset, forcedTrack = null, history = true) {
  if (!asset) return;
  if (history) recordHistory();
  const track = forcedTrack || (asset.kind === 'audio' ? 'A1' : 'V1');
  const endOnTrack = Math.max(0, ...clips.filter(c => c.track === track).map(clipEnd));
  const start = Math.max(playhead, endOnTrack);
  const clip = {id:uid(), assetId:asset.id, name:asset.name, kind:asset.kind, track, start, inPoint:0, outPoint:Math.max(.1, asset.duration), speed:1, volume:100, mute:false, opacity:100, brightness:100, contrast:100, saturation:100, rotation:0, fit:'contain', look:'none', vignette:false, mirror:false, grain:false};
  clips.push(clip); createMediaElementForClip(clip); selectedClipId = clip.id; selectedAssetId = asset.id;
  renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty();
  setStatus(`Added ${asset.name} to ${track}`);
}
function addTextClip(style = 'title') {
  recordHistory();
  const title = style === 'caption' ? 'Add your caption here' : 'Your title here';
  const track = 'T1';
  const sameTrackEnd = Math.max(0, ...clips.filter(c => c.track === track).map(clipEnd));
  const start = clips.length ? playhead : 0;
  const clip = {id:uid(), assetId:null, name:style === 'caption' ? 'Caption' : 'Title', kind:'text', track, start:Math.max(0,start), duration:style === 'caption' ? 3 : 4, content:title, fontSize:style === 'caption' ? 40 : 62, fontFamily:'Space Grotesk', color:'#ffffff', textBackground:style === 'caption' ? '#00000099' : '#00000000', bold:true, italic:false, align:'center', xPos:50, yPos:style === 'caption' ? 84 : 50, stroke:false, strokeWidth:2, opacity:100, speed:1, volume:100, mute:false, brightness:100, contrast:100, saturation:100, rotation:0, fit:'contain', look:'none', vignette:false, mirror:false, grain:false};
  clips.push(clip); selectedClipId = clip.id; selectedAssetId = null; renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty(); setPanel('textPanel'); toast('Text layer added. Edit the content in Inspector.');
}
function splitSelectedClip() {
  const c = clipById();
  if (!c) { toast('Select a clip on the timeline first.', 'info'); return; }
  const end = clipEnd(c);
  if (playhead <= c.start + .05 || playhead >= end - .05) { toast('Move the playhead inside the selected clip to split it.', 'info'); return; }
  recordHistory();
  if (c.kind === 'text') {
    const second = {...serializeClip(c), id:uid(), start:playhead, duration:end-playhead};
    c.duration = playhead-c.start; clips.push(second);
  } else {
    const point = c.inPoint + (playhead - c.start) * c.speed;
    const second = {...serializeClip(c), id:uid(), start:playhead, inPoint:point};
    c.outPoint = point;
    clips.push(second); createMediaElementForClip(second);
  }
  selectedClipId = clips[clips.length-1].id; renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty(); toast('Clip split at playhead.');
}
function duplicateSelectedClip() {
  const c = clipById(); if (!c) { toast('Select a clip to duplicate.', 'info'); return; }
  recordHistory();
  const copy = {...serializeClip(c), id:uid(), start:clipEnd(c) + .05};
  clips.push(copy); createMediaElementForClip(copy); selectedClipId = copy.id; renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty(); toast('Clip duplicated.');
}
function deleteSelectedClip() {
  const c = clipById(); if (!c) { toast('Select a clip to delete.', 'info'); return; }
  recordHistory(); disposeClipMedia(c); clips = clips.filter(x => x.id !== c.id); selectedClipId = null; renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); markDirty(); toast('Clip removed from timeline.', 'info');
}
function selectClip(id) { selectedClipId = id; selectedAssetId = null; const c = clipById(id); if (c) { selectedAssetId = c.assetId || null; setStatus(`Selected ${c.name || 'text layer'}`); } renderTimeline(); renderInspector(); renderPreview(); }
function selectedClipMutate(prop, value, {history = false, redraw = true} = {}) {
  const c = clipById(); if (!c) return;
  if (history) recordHistory();
  if (['start','inPoint','outPoint','speed','volume','opacity','brightness','contrast','saturation','rotation','duration','fontSize','xPos','yPos','strokeWidth'].includes(prop)) value = Number(value);
  if (prop === 'mute' || prop === 'vignette' || prop === 'mirror' || prop === 'grain' || prop === 'bold' || prop === 'italic' || prop === 'stroke') value = Boolean(value);
  c[prop] = value;
  if (prop === 'inPoint') c.inPoint = Math.max(0, Math.min(c.inPoint, (assetById(c.assetId)?.duration || c.outPoint) - .1));
  if (prop === 'outPoint' && c.kind !== 'text') c.outPoint = Math.max(c.inPoint + .1, Math.min(c.outPoint, assetById(c.assetId)?.duration || c.outPoint));
  if (prop === 'speed') c.speed = Math.max(.25, Math.min(4, c.speed));
  if (prop === 'start') c.start = Math.max(0, c.start);
  if (prop === 'duration' && c.kind === 'text') c.duration = Math.max(.2, Math.min(120,c.duration));
  if (prop === 'volume') c.volume = Math.max(0,Math.min(200,c.volume));
  if (prop === 'opacity') c.opacity = Math.max(0,Math.min(100,c.opacity));
  if (['brightness','contrast','saturation'].includes(prop)) c[prop] = Math.max(0,Math.min(200,c[prop]));
  if (prop === 'rotation') c.rotation = ((c.rotation % 360) + 360) % 360;
  if (prop === 'xPos' || prop === 'yPos') c[prop] = Math.max(0,Math.min(100,c[prop]));
  if (prop === 'look') applyLook(c, value);
  const node = audioNodes.get(c.id); if (node) node.gain.gain.value = c.mute ? 0 : c.volume / 100;
  if (redraw) { renderPreview(); renderTimeline(); updateTimelineInfo(); markDirty(); }
}
function applyLook(c, look) {
  c.look = look;
  const values = {
    none: [100,100,100], cinema: [96,112,85], warm: [104,105,112], mono: [100,105,0], vivid: [102,112,145], fade: [108,85,78]
  }[look] || [100,100,100];
  c.brightness = values[0]; c.contrast = values[1]; c.saturation = values[2];
}
function timelineScale() { return scale; }
function renderTimeline() {
  const duration = Math.max(8, projectDuration() + 3);
  const px = timelineScale();
  const lanesWidth = Math.max(620, Math.ceil(duration * px));
  const fullWidth = 112 + lanesWidth;
  timelineInner.style.width = `${fullWidth}px`;
  timelineInner.style.setProperty('--px-second', `${px}px`);
  const ruler = $('#ruler'); ruler.style.width = `${lanesWidth}px`; ruler.style.minWidth = `${lanesWidth}px`;
  const step = px >= 50 ? 1 : px >= 30 ? 2 : 5;
  let marks = '';
  for (let sec = 0; sec <= duration; sec += step) marks += `<span class="ruler-mark" style="left:${sec*px}px">${sec}s</span><i class="ruler-tick" style="left:${sec*px}px"></i>`;
  ruler.querySelectorAll('.ruler-mark,.ruler-tick').forEach(e => e.remove()); ruler.insertAdjacentHTML('beforeend', marks);
  $$('.track-lane').forEach(lane => { lane.style.width = `${lanesWidth}px`; lane.style.minWidth = `${lanesWidth}px`; lane.innerHTML = ''; });
  for (const clip of clips) {
    const lane = $(`.track-lane[data-track="${clip.track}"]`); if (!lane) continue;
    const dur = durationOf(clip), left = clip.start * px, width = Math.max(13, dur * px);
    const el = document.createElement('div');
    el.className = `timeline-clip ${clip.kind === 'audio' ? 'audio-clip' : clip.kind === 'text' ? 'text-clip' : clip.kind === 'image' ? 'image-clip' : ''} ${selectedClipId === clip.id ? 'selected' : ''}`;
    el.dataset.clipId = clip.id; el.style.left = `${left}px`; el.style.width = `${width}px`; el.title = `${clip.name} · ${fmtShort(dur)}`;
    const label = clip.kind === 'text' ? 'T' : clip.kind === 'audio' ? '♫' : clip.kind === 'image' ? '▧' : '▶';
    el.innerHTML = `<span class="clip-handle left"></span><div class="clip-inner"><span class="clip-thumb">${label}</span><span class="clip-text"><span class="clip-name">${esc(clip.name || 'Untitled clip')}</span><span class="clip-duration">${fmtShort(dur)}</span></span></div><span class="clip-handle right"></span>`;
    lane.append(el);
  }
  const headX = playhead * px;
  $('#playheadLine').style.left = `${headX}px`;
  $('#playheadHandle').style.left = `${headX - 5}px`;
  $('#timelineClickShield').style.width = `${lanesWidth}px`;
  $('#timelineLength').textContent = fmtShort(projectDuration());
  updatePlayheadReadout();
}
function updateTimelineInfo() {
  $('#durationTime').textContent = fmtTime(projectDuration());
  $('#timelineLength').textContent = fmtShort(projectDuration());
  $('#timelineHint').textContent = clips.length ? `${clips.length} clip${clips.length===1?'':'s'} · select a clip to edit its properties` : 'Import media and add clips to your timeline';
  $('#previewEmpty').classList.toggle('hidden', clips.some(c => c.kind !== 'audio'));
  $('#exportSummaryName').textContent = $('#projectName').value || 'Untitled Project';
  $('#exportSummaryLength').textContent = fmtShort(projectDuration());
  $('#exportSummaryDuration').textContent = fmtShort(projectDuration());
  $('#exportSummaryClips').textContent = clips.length;
}
function updatePlayheadReadout() {
  $('#playheadTime').textContent = fmtTime(playhead);
  $('#playheadLine').style.left = `${playhead * scale}px`;
  $('#playheadHandle').style.left = `${playhead * scale - 5}px`;
}
function updateProjectCanvasSize() {
  const quality = $('#qualitySelect')?.value || 'half';
  const factor = quality === 'full' ? 1 : quality === 'quarter' ? .25 : .5;
  canvas.width = Math.max(1, Math.round(projectSettings.width * factor)); canvas.height = Math.max(1, Math.round(projectSettings.height * factor));
  $('#previewSizeTag').textContent = `${projectSettings.width} × ${projectSettings.height}`;
  const aspect = projectSettings.width / projectSettings.height;
  $('.preview-mat').style.aspectRatio = `${projectSettings.width}/${projectSettings.height}`;
  resizePreviewMat();
  renderPreview();
}

function resizePreviewMat() {
  const workspace = $('#previewWorkspace');
  const mat = $('.preview-mat');
  if (!workspace || !mat) return;
  const maxW = Math.max(160, workspace.clientWidth - 40);
  const maxH = Math.max(100, workspace.clientHeight - 30);
  const aspect = projectSettings.width / projectSettings.height;
  const width = Math.max(120, Math.min(maxW, maxH * aspect));
  mat.style.width = `${width}px`;
  mat.style.height = `${width / aspect}px`;
}

function fitRect(sourceW, sourceH, targetW, targetH, fit) {
  if (!sourceW || !sourceH) return {x:0,y:0,w:targetW,h:targetH};
  const factor = fit === 'cover' ? Math.max(targetW/sourceW, targetH/sourceH) : Math.min(targetW/sourceW, targetH/sourceH);
  const w = sourceW * factor, h = sourceH * factor;
  return {x:(targetW-w)/2,y:(targetH-h)/2,w,h};
}
function drawVideoClip(c, time) {
  const media = c.mediaEl, targetW = canvas.width, targetH = canvas.height;
  if (!media || (c.kind === 'video' && media.readyState < 2)) return;
  const sourceW = c.kind === 'image' ? media.naturalWidth : media.videoWidth;
  const sourceH = c.kind === 'image' ? media.naturalHeight : media.videoHeight;
  if (!sourceW || !sourceH) return;
  const rect = fitRect(sourceW, sourceH, targetW, targetH, c.fit || 'contain');
  ctx.save();
  ctx.globalAlpha = (c.opacity ?? 100) / 100;
  const lookMap = {none:'',cinema:'',warm:'sepia(.12)',mono:'grayscale(1)',vivid:'',fade:'sepia(.08)'};
  ctx.filter = `${lookMap[c.look] || ''} brightness(${c.brightness ?? 100}%) contrast(${c.contrast ?? 100}%) saturate(${c.saturation ?? 100}%)`.trim();
  ctx.translate(targetW/2,targetH/2); ctx.rotate((c.rotation || 0) * Math.PI / 180); if (c.mirror) ctx.scale(-1,1);
  const r2 = fitRect(sourceW, sourceH, targetW, targetH, c.fit || 'contain');
  try { ctx.drawImage(media, r2.x-targetW/2, r2.y-targetH/2, r2.w, r2.h); } catch {}
  ctx.restore(); ctx.filter = 'none';
  if (c.vignette) {
    const g = ctx.createRadialGradient(targetW/2,targetH/2,Math.min(targetW,targetH)*.22,targetW/2,targetH/2,Math.max(targetW,targetH)*.66);
    g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.62)'); ctx.fillStyle = g; ctx.fillRect(0,0,targetW,targetH);
  }
  if (c.grain) {
    ctx.save(); ctx.globalAlpha = .12; for(let i=0;i<130;i++){ctx.fillStyle = Math.random()>.5 ? '#fff' : '#000'; ctx.fillRect(Math.random()*targetW,Math.random()*targetH,1.4,1.4);} ctx.restore();
  }
}
function drawTextClip(c) {
  const w = canvas.width, h = canvas.height;
  const fontSize = Math.max(8, (Number(c.fontSize) || 48) * (h/720));
  const lines = String(c.content || '').split('\n');
  ctx.save(); ctx.globalAlpha = (c.opacity ?? 100) / 100;
  ctx.font = `${c.italic ? 'italic ' : ''}${c.bold ? '700 ' : '500 '}${fontSize}px ${JSON.stringify(c.fontFamily || 'Arial')}`;
  ctx.textAlign = c.align || 'center'; ctx.textBaseline = 'middle';
  const x = w*(Number(c.xPos ?? 50)/100), y = h*(Number(c.yPos ?? 50)/100);
  const lineHeight = fontSize*1.2;
  const maxW = w*.84;
  const wrapped = [];
  for (const line of lines) {
    const words = line.split(' '); let current = '';
    for (const word of words) { const test = current ? `${current} ${word}` : word; if (ctx.measureText(test).width > maxW && current) { wrapped.push(current); current = word; } else current = test; }
    wrapped.push(current);
  }
  const widths = wrapped.map(line => ctx.measureText(line).width), maxLineW = Math.max(0,...widths);
  if (c.textBackground && c.textBackground.toLowerCase() !== '#00000000' && c.textBackground !== 'transparent') {
    ctx.fillStyle = c.textBackground; const padX = fontSize*.25, padY=fontSize*.18; let bx = x-maxLineW/2-padX; if(ctx.textAlign==='left')bx=x-padX; if(ctx.textAlign==='right')bx=x-maxLineW-padX;
    ctx.beginPath(); ctx.roundRect(bx, y-(wrapped.length*lineHeight)/2-padY,maxLineW+padX*2,wrapped.length*lineHeight+padY*2,fontSize*.08); ctx.fill();
  }
  wrapped.forEach((line,i)=>{ const yy = y - ((wrapped.length-1)*lineHeight)/2 + i*lineHeight; if(c.stroke){ctx.lineWidth=Number(c.strokeWidth)||2;ctx.strokeStyle='rgba(0,0,0,.8)';ctx.strokeText(line,x,yy,maxW);} ctx.fillStyle=c.color||'#fff';ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=fontSize*.1;ctx.fillText(line,x,yy,maxW); });
  ctx.restore();
}
function syncClipPlayback(time, forceSeek = false) {
  for (const c of clips) {
    if (c.kind === 'image' || c.kind === 'text' || !c.mediaEl) continue;
    const el = c.mediaEl; const active = time >= c.start && time < clipEnd(c);
    const expected = Math.max(0, Math.min((assetById(c.assetId)?.duration || 1)-.02, c.inPoint + Math.max(0,time-c.start)*c.speed));
    el.playbackRate = c.speed || 1;
    const node = audioNodes.get(c.id); if (node) node.gain.gain.value = c.mute ? 0 : (c.volume ?? 100)/100;
    if (active && isPlaying) {
      if (forceSeek || Math.abs((el.currentTime||0)-expected) > .65) { try { el.currentTime = expected; } catch {} }
      if (el.paused) el.play().catch(()=>{});
    } else {
      if (!el.paused) el.pause();
      if (forceSeek || !isPlaying) { if (Math.abs((el.currentTime||0)-expected) > .08) { try { el.currentTime = expected; } catch {} } }
    }
  }
}
function renderPreview(time = playhead) {
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.save(); ctx.filter='none'; ctx.globalAlpha=1; ctx.fillStyle='#08090b'; ctx.fillRect(0,0,w,h); ctx.restore();
  const activeVisual = clips.filter(c => c.track !== 'A1' && time >= c.start && time < clipEnd(c)).sort((a,b)=>(TRACK_ORDER[a.track]||0)-(TRACK_ORDER[b.track]||0));
  for (const c of activeVisual) { if (c.kind === 'text') drawTextClip(c); else if (c.kind === 'video' || c.kind === 'image') drawVideoClip(c,time); }
  if (!activeVisual.length && clips.some(c => c.kind !== 'audio')) { ctx.save(); ctx.fillStyle='#22252b';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`${Math.max(14,w*.016)}px sans-serif`;ctx.fillText('No clip at this time',w/2,h/2);ctx.restore(); }
  $('#canvasBadge').textContent = isExporting ? 'RENDERING' : isPlaying ? 'PLAYING' : 'PREVIEW';
  if (isExporting) {
    const total = Math.max(.1,projectDuration()); const pct = Math.min(100,Math.round(playhead/total*100));
    $('#renderPercent').textContent = `${pct}%`; $('#renderProgressBar').style.width = `${pct}%`;
    $('#renderStatus').textContent = `Rendering at real-time speed · ${fmtTime(playhead)} of ${fmtTime(total)}`;
  }
}
function seekTo(value, {forceSeek=true}={}) {
  playhead = Math.max(0, Math.min(Number(value)||0, Math.max(projectDuration(),0)));
  syncClipPlayback(playhead, forceSeek); renderPreview(); updatePlayheadReadout();
}
function tick(now) {
  if (!isPlaying) return;
  if (!lastTick) lastTick = now;
  const delta = Math.min(.12, (now-lastTick)/1000); lastTick = now;
  playhead += delta;
  const end = projectDuration();
  if (end > 0 && playhead >= end) { playhead = end; pausePlayback(); if (isExporting && exportRecorder && exportRecorder.state !== 'inactive') { try { exportRecorder.stop(); } catch {} } }
  syncClipPlayback(playhead); renderPreview(); updatePlayheadReadout();
  rafId = requestAnimationFrame(tick);
}
async function ensureAudioGraph() {
  if (!audioContext) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioContext = new AC(); masterGain = audioContext.createGain(); masterGain.gain.value = Number($('#masterVolume').value)/100;
    recordDestination = audioContext.createMediaStreamDestination(); masterGain.connect(audioContext.destination); masterGain.connect(recordDestination);
    clips.forEach(connectClipAudio);
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}
function connectClipAudio(clip) {
  if (!audioContext || !clip.mediaEl || !['video','audio'].includes(clip.kind) || audioNodes.has(clip.id)) return;
  try {
    const source = audioContext.createMediaElementSource(clip.mediaEl); const gain = audioContext.createGain();
    gain.gain.value = clip.mute ? 0 : (clip.volume ?? 100)/100; source.connect(gain); gain.connect(masterGain); audioNodes.set(clip.id,{source,gain});
  } catch (error) { console.warn('Audio graph:', error); }
}
async function startPlayback() {
  if (isPlaying) return;
  if (!clips.length || projectDuration() <= 0) { toast('Add a clip to the timeline before playing.', 'info'); return; }
  try { await ensureAudioGraph(); } catch {}
  if (playhead >= projectDuration()) playhead = 0;
  isPlaying = true; lastTick = 0; $('#playBtn').innerHTML = icon('pause'); $('#playBtn').title = 'Pause (Space)';
  syncClipPlayback(playhead,true); rafId = requestAnimationFrame(tick);
}
function pausePlayback() {
  isPlaying = false; lastTick = 0; cancelAnimationFrame(rafId); $('#playBtn').innerHTML = icon('play'); $('#playBtn').title = 'Play (Space)';
  clips.forEach(c => { if (c.mediaEl && ['video','audio'].includes(c.kind)) { try { c.mediaEl.pause(); } catch {} } });
  syncClipPlayback(playhead,true); renderPreview();
}
function togglePlayback() { isPlaying ? pausePlayback() : startPlayback(); }
function renderInspector() {
  const c = clipById();
  if (!c) {
    if (selectedAssetId && assetById(selectedAssetId)) { renderAssetInspector(assetById(selectedAssetId)); return; }
    inspectorContent.innerHTML = `<div class="inspector-empty"><div class="inspector-empty-icon">${icon('sliders')}</div><strong>Nothing selected</strong><p>Select a clip on the timeline to fine-tune its settings.</p><div class="inspector-tip"><span>✦</span><p>Tip: double-click a media item to add it to your timeline.</p></div></div>`; return;
  }
  const asset = assetById(c.assetId);
  const fileIcon = c.kind === 'audio' ? icon('audio') : c.kind === 'text' ? icon('type') : c.kind === 'image' ? '▧' : icon('film');
  const sourceDuration = asset?.duration || 0;
  const generalTiming = c.kind === 'text' ? `<div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Start (sec)</label><input class="field-input" type="number" min="0" step="0.1" data-prop="start" value="${c.start.toFixed(2)}"></div><div class="inspector-field"><label class="field-label">Duration (sec)</label><input class="field-input" type="number" min="0.2" step="0.1" data-prop="duration" value="${durationOf(c).toFixed(2)}"></div></div>` : `<div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Start (sec)</label><input class="field-input" type="number" min="0" step="0.1" data-prop="start" value="${c.start.toFixed(2)}"></div><div class="inspector-field"><label class="field-label">Speed</label><select class="field-select" data-prop="speed">${[.25,.5,.75,1,1.25,1.5,2,3,4].map(v=>`<option value="${v}" ${Number(c.speed)===v?'selected':''}>${v}×</option>`).join('')}</select></div></div><div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Source In (sec)</label><input class="field-input" type="number" min="0" max="${sourceDuration}" step="0.1" data-prop="inPoint" value="${(c.inPoint||0).toFixed(2)}"></div><div class="inspector-field"><label class="field-label">Source Out (sec)</label><input class="field-input" type="number" min="${(c.inPoint||0)+.1}" max="${sourceDuration}" step="0.1" data-prop="outPoint" value="${(c.outPoint||sourceDuration).toFixed(2)}"></div></div><div class="range-labels"><span>Source: ${fmtShort(sourceDuration)}</span><span>Clip: ${fmtShort(durationOf(c))}</span></div>`;
  const imageVideoAdjust = c.kind !== 'audio' && c.kind !== 'text' ? `<div class="inspector-group"><div class="inspector-group-title">IMAGE & TRANSFORM <small>VIDEO</small></div><label class="field-label">Fit mode</label><div class="segmented"><button data-prop="fit" data-value="contain" class="${c.fit==='contain'?'active':''}">Fit</button><button data-prop="fit" data-value="cover" class="${c.fit==='cover'?'active':''}">Fill</button></div><div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Rotation</label><select data-prop="rotation" class="field-select">${[0,90,180,270].map(v=>`<option value="${v}" ${c.rotation===v?'selected':''}>${v}°</option>`).join('')}</select></div><div class="inspector-field"><label class="field-label">Opacity</label><input class="field-input" type="number" min="0" max="100" data-prop="opacity" value="${c.opacity??100}"></div></div><label class="field-label">Brightness <output>${c.brightness??100}%</output></label><div class="range-row"><input type="range" class="range-control" min="0" max="200" value="${c.brightness??100}" data-prop="brightness"><output>${c.brightness??100}%</output></div><label class="field-label">Contrast <output>${c.contrast??100}%</output></label><div class="range-row"><input type="range" class="range-control" min="0" max="200" value="${c.contrast??100}" data-prop="contrast"><output>${c.contrast??100}%</output></div><label class="field-label">Saturation <output>${c.saturation??100}%</output></label><div class="range-row"><input type="range" class="range-control" min="0" max="200" value="${c.saturation??100}" data-prop="saturation"><output>${c.saturation??100}%</output></div></div>` : '';
  const audioControls = c.kind === 'audio' || c.kind === 'video' ? `<div class="inspector-group"><div class="inspector-group-title">AUDIO <small>MIX</small></div><label class="field-label">Clip volume <output>${c.volume??100}%</output></label><div class="range-row"><input class="range-control" type="range" min="0" max="200" value="${c.volume??100}" data-prop="volume"><output>${c.volume??100}%</output></div><label class="inspector-check-row"><span>Mute this clip</span><input type="checkbox" data-prop="mute" ${c.mute?'checked':''}></label></div>` : '';
  const textControls = c.kind === 'text' ? `<div class="inspector-group"><div class="inspector-group-title">TEXT CONTENT <small>TITLE</small></div><label class="field-label">Text</label><textarea class="text-edit-area" rows="3" data-prop="content">${esc(c.content)}</textarea><div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Font size</label><input class="field-input" type="number" min="8" max="220" data-prop="fontSize" value="${c.fontSize||48}"></div><div class="inspector-field"><label class="field-label">Font family</label><select class="field-select" data-prop="fontFamily">${['Space Grotesk','Arial','Georgia','Impact','Trebuchet MS','Courier New'].map(f=>`<option ${c.fontFamily===f?'selected':''}>${f}</option>`).join('')}</select></div></div><div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Horizontal position</label><input class="field-input" type="number" min="0" max="100" data-prop="xPos" value="${c.xPos??50}"></div><div class="inspector-field"><label class="field-label">Vertical position</label><input class="field-input" type="number" min="0" max="100" data-prop="yPos" value="${c.yPos??50}"></div></div><div class="inspector-field-row"><div class="inspector-field"><label class="field-label">Alignment</label><select class="field-select" data-prop="align">${['left','center','right'].map(v=>`<option value="${v}" ${c.align===v?'selected':''}>${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></div><div class="inspector-field"><label class="field-label">Text color</label><input class="color-input" type="color" data-prop="color" value="${/^#[0-9a-f]{6}$/i.test(c.color||'')?c.color:'#ffffff'}"></div></div><label class="field-label">Background</label><select class="field-select" data-prop="textBackground"><option value="#00000000" ${!c.textBackground||c.textBackground==='#00000000'?'selected':''}>Transparent</option><option value="#00000099" ${c.textBackground==='#00000099'?'selected':''}>Black (semi-transparent)</option><option value="#ffffffcc" ${c.textBackground==='#ffffffcc'?'selected':''}>White (semi-transparent)</option><option value="#111827cc" ${c.textBackground==='#111827cc'?'selected':''}>Dark blue</option></select><div class="inspector-check-row"><span>Bold</span><input type="checkbox" data-prop="bold" ${c.bold?'checked':''}></div><div class="inspector-check-row"><span>Italic</span><input type="checkbox" data-prop="italic" ${c.italic?'checked':''}></div><div class="inspector-check-row"><span>Outline text</span><input type="checkbox" data-prop="stroke" ${c.stroke?'checked':''}></div><label class="field-label">Opacity <output>${c.opacity??100}%</output></label><div class="range-row"><input class="range-control" type="range" min="0" max="100" data-prop="opacity" value="${c.opacity??100}"><output>${c.opacity??100}%</output></div></div>` : '';
  const effectControls = c.kind !== 'audio' && c.kind !== 'text' ? `<div class="inspector-group"><div class="inspector-group-title">QUICK LOOKS <small>FILTER</small></div><select class="field-select" data-prop="look">${[['none','Original'],['cinema','Cinema'],['warm','Warm'],['mono','Mono'],['vivid','Vivid'],['fade','Fade']].map(([v,l])=>`<option value="${v}" ${c.look===v?'selected':''}>${l}</option>`).join('')}</select><label class="inspector-check-row"><span>Vignette</span><input type="checkbox" data-prop="vignette" ${c.vignette?'checked':''}></label><label class="inspector-check-row"><span>Mirror horizontally</span><input type="checkbox" data-prop="mirror" ${c.mirror?'checked':''}></label><label class="inspector-check-row"><span>Film grain</span><input type="checkbox" data-prop="grain" ${c.grain?'checked':''}></label></div>` : '';
  const codecAction = localMediaEngineAvailable ? `<button class="button button-quiet button-full" style="margin-top:10px" data-action="convert">Convert for browser…</button><p class="muted-note">Uses the local FFmpeg engine to create a browser-friendly copy.</p>` : `<button class="button button-quiet button-full" style="margin-top:10px" data-action="codec-info">Codec support info</button><p class="muted-note">This browser could not decode the file. Install FFmpeg and use the local server to enable conversion.</p>`;
  inspectorContent.innerHTML = `<div class="inspector-content-header"><div class="inspector-file-icon">${fileIcon}</div><div style="min-width:0;flex:1"><div class="inspector-file-name">${esc(c.name||'Untitled clip')}</div><div class="inspector-file-sub">${c.kind==='text'?'TEXT LAYER':`${esc(c.kind.toUpperCase())} · ${esc(c.track)} TRACK`}</div></div></div><div class="inspector-group"><div class="inspector-group-title">TIMING <small>CLIP</small></div>${generalTiming}</div>${textControls}${imageVideoAdjust}${effectControls}${audioControls}<div class="inspector-group"><div class="inspector-group-title">CLIP ACTIONS</div><div class="inspector-buttons"><button data-action="split">✂ Split</button><button data-action="duplicate">▣ Duplicate</button><button data-action="delete" class="inspector-danger">⌫ Delete</button></div>${asset?.playbackError ? codecAction : ''}</div>`;
}
function renderAssetInspector(asset) {
  const conversionDescription = asset.kind === 'audio' ? 'Create a browser-friendly AAC/M4A copy.' : asset.kind === 'image' ? 'Convert a compatible still image to PNG.' : 'Create a browser-friendly H.264/AAC MP4 copy.';
  const converter = localMediaEngineAvailable
    ? `<button class="button button-quiet button-full" style="margin-top:8px" data-action="convert">Convert for browser…</button><p class="muted-note">${esc(localMediaEngineVersion || 'Local FFmpeg')}: ${conversionDescription}</p>`
    : `<button class="button button-quiet button-full" style="margin-top:8px" data-action="codec-info">Codec support info</button><p class="muted-note">Import support depends on your browser's installed decoders. Start this project with its local server and install FFmpeg to enable broader conversion.</p>`;
  inspectorContent.innerHTML = `<div class="inspector-content-header"><div class="inspector-file-icon">${assetIcon(asset)}</div><div style="min-width:0;flex:1"><div class="inspector-file-name">${esc(asset.name)}</div><div class="inspector-file-sub">${asset.kind.toUpperCase()} · ${bytesLabel(asset.size)}</div></div></div><div class="inspector-group"><div class="inspector-group-title">MEDIA DETAILS</div><div class="summary-row"><span>Duration</span><b>${asset.kind==='image'?'Still image':fmtTime(asset.duration)}</b></div><div class="summary-row"><span>File size</span><b>${bytesLabel(asset.size)}</b></div><div class="summary-row"><span>Type</span><b>${esc(asset.type || extOf(asset.name))}</b></div><div class="summary-row"><span>Dimensions</span><b>${asset.width&&asset.height?`${asset.width} × ${asset.height}`:'Not available'}</b></div></div><div class="inspector-group"><button class="button button-primary button-full" data-action="add-asset">${icon('plus')} Add to timeline</button>${converter}</div>`;
}
function applyInspectorProp(target, {commit = false} = {}) {
  const prop = target.dataset.prop; if (!prop) return;
  let value = target.type === 'checkbox' ? target.checked : target.value;
  if (target.type === 'range') {
    const out = target.parentElement.querySelector('output') || target.closest('.inspector-group')?.querySelector(`label[data-for="${prop}"] output`);
    if (out) out.textContent = `${value}${['start','duration','fontSize','xPos','yPos','rotation','speed'].includes(prop)?'':'%'}`;
  }
  if (target.matches('select[data-prop]') && target.dataset.value !== undefined) value = target.dataset.value;
  selectedClipMutate(prop,value,{history:commit,redraw:true});
  if (commit) renderInspector();
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function projectData(includeMedia = false) {
  return {format:'motionlab-project',version:1,app:'kayralrics.com - video',author:'kayralrics.net',credit:'https://kayralrics.net/',savedAt:new Date().toISOString(),project:{name:$('#projectName').value||'Untitled Project',...projectSettings},assets:assets.map(a=>({id:a.id,name:a.name,type:a.type,kind:a.kind,duration:a.duration,size:a.size,width:a.width||0,height:a.height||0,...(includeMedia && a.file ? {dataUrl:null} : {})})),clips:clips.map(serializeClip),playhead};
}
function fileToDataURL(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error(`Could not read ${file.name}`));reader.readAsDataURL(file);}); }
async function saveProjectFile(includeMedia = false) {
  setStatus('Preparing project file…');
  try {
    const data = projectData(includeMedia);
    if (includeMedia) {
      const total = assets.reduce((sum,a)=>sum+(a.size||0),0);
      if (total > 750*1024*1024 && !confirm(`This project includes ${(total/1024/1024).toFixed(0)} MB of source media. Embedding it may exhaust browser memory. Continue?`)) { setStatus('Project export cancelled'); return; }
      for (let i=0;i<assets.length;i++) {
        const a=assets[i]; if (a.file) data.assets[i].dataUrl=await fileToDataURL(a.file);
      }
    }
    const blob = new Blob([JSON.stringify(data)],{type:'application/json'});
    const safeName = ($('#projectName').value||'kayralrics-video-project').replace(/[\\/:*?"<>|]+/g,'-').trim()||'kayralrics-video-project';
    downloadBlob(blob,`${safeName}.motionlab`); setSaved(); setStatus('Project file exported'); toast(`Project file saved${includeMedia?' with source media':''}.`);
  } catch (error) { console.error(error); toast(`Could not save project: ${error.message}`,'error',5500); setStatus('Project export failed'); }
}
function openProjectSaveModal() { $('#projectModal').classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }
async function applyProjectData(data, filesByName = null) {
  if (!data || data.format !== 'motionlab-project' || !Array.isArray(data.assets) || !Array.isArray(data.clips)) throw new Error('This is not a valid kayralrics.com - video project file.');
  pausePlayback();
  clips.forEach(disposeClipMedia); assets.forEach(a=>{if(a.url)URL.revokeObjectURL(a.url);});
  assets=[]; clips=[]; audioNodes.clear();
  const newAssets=[];
  for (const info of data.assets) {
    let file = null;
    if (info.dataUrl) {
      const response=await fetch(info.dataUrl); const blob=await response.blob(); file=new File([blob],info.name,{type:info.type||blob.type||'application/octet-stream'});
    } else if (filesByName) file = filesByName.get(info.name.toLowerCase()) || null;
    if (file) { const asset=makeAsset(file,info.id,{kind:info.kind,duration:info.duration,width:info.width,height:info.height,type:info.type}); newAssets.push(asset); inspectAssetDuration(asset); }
  }
  assets=newAssets;
  const availableIds=new Set(assets.map(a=>a.id));
  clips=(data.clips||[]).filter(c=>c.kind==='text'||availableIds.has(c.assetId)).map(c=>({...c}));
  clips.forEach(createMediaElementForClip);
  projectSettings={width:Number(data.project?.width)||1280,height:Number(data.project?.height)||720,aspect:data.project?.aspect||'16:9',fps:Number(data.project?.fps)||30};
  $('#aspectSelect').value=projectSettings.aspect;
  $('#projectName').value=data.project?.name||'Untitled Project';
  selectedClipId=null;selectedAssetId=null;playhead=Math.max(0,Number(data.playhead)||0);undoStack=[];redoStack=[];updateUndoRedo();
  updateProjectCanvasSize(); renderLibrary(); renderTimeline(); renderInspector(); renderPreview(); updateTimelineInfo(); setSaved(); setStatus('Project opened');
  if (data.assets.length > assets.length) toast(`${data.assets.length-assets.length} source file(s) were not linked. Some clips were omitted from the timeline.`, 'error',6000);
  else toast('Project opened successfully.');
}
async function handleProjectFile(file) {
  try {
    const data=JSON.parse(await file.text());
    if (data.format!=='motionlab-project') throw new Error('Unrecognized project file.');
    const embedded = data.assets.every(a=>a.dataUrl) || data.assets.length===0;
    if (embedded) { await applyProjectData(data); }
    else { pendingProjectData=data; $('#relinkInput').value=''; $('#relinkInput').click(); toast('Select the original media files referenced by this project.','info',5500); }
  } catch(error) { console.error(error); toast(`Could not open project: ${error.message}`,'error',6000); }
}
async function refreshExportFormats() {
  const select = $('#exportFormat');
  if (!select) return;
  const previous = select.value || 'auto';
  const support = detectRecordFormats();
  const hasRecorder = Boolean(window.MediaRecorder && canvas.captureStream && (support.mp4 || support.webm));
  let localProfiles = [];
  if (localMediaEngineAvailable) {
    try {
      const response = await fetch('/api/formats', {cache:'no-store'});
      if (response.ok) {
        const data = await response.json();
        if (data.available && Array.isArray(data.formats)) {
          localProfiles = data.formats.map(profile => ({...profile, engine:'ffmpeg'}));
        }
      }
    } catch (error) {
      console.warn('Could not load local FFmpeg profiles', error);
    }
  }
  const nativeProfiles = [];
  if (support.mp4) nativeProfiles.push({id:'mp4',label:'MP4 · Browser encoder',extension:'mp4',kind:'video',engine:'browser'});
  if (support.webm) nativeProfiles.push({id:'webm',label:'WebM · Browser encoder',extension:'webm',kind:'video',engine:'browser'});
  const profiles = localProfiles.length ? localProfiles : nativeProfiles;
  const autoProfile = {id:'auto',label:'Best available (recommended)',extension:'',kind:'auto',engine:'browser'};
  formatProfiles = [autoProfile, ...profiles];
  select.replaceChildren();
  const autoOption = document.createElement('option');
  autoOption.value = 'auto'; autoOption.textContent = 'Best available (recommended)';
  select.append(autoOption);
  if (localProfiles.length) {
    const groups = [
      {key:'video',label:'Video formats · Local FFmpeg'},
      {key:'animation',label:'Animated formats · Local FFmpeg'},
      {key:'audio',label:'Audio-only formats · Local FFmpeg'}
    ];
    for (const groupInfo of groups) {
      const groupProfiles = localProfiles.filter(profile => profile.kind === groupInfo.key);
      if (!groupProfiles.length) continue;
      const group = document.createElement('optgroup'); group.label = groupInfo.label;
      for (const profile of groupProfiles) {
        const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.label;
        option.dataset.engine = 'ffmpeg'; option.title = profile.description || profile.label;
        group.append(option);
      }
      select.append(group);
    }
  } else if (nativeProfiles.length) {
    const group = document.createElement('optgroup'); group.label = 'Browser-native formats';
    for (const profile of nativeProfiles) {
      const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.label;
      option.dataset.engine = 'browser'; group.append(option);
    }
    select.append(group);
  }
  const valid = [...select.options].some(option => option.value === previous && !option.disabled);
  select.value = valid ? previous : 'auto';

  const browserNames = [support.mp4 ? 'MP4' : '', support.webm ? 'WebM' : ''].filter(Boolean);
  const notes = [];
  notes.push(hasRecorder ? `Browser renderer: ${browserNames.join(' / ') || 'available'}` : 'Browser video recording is unavailable');
  if (localProfiles.length) {
    const videoCount = localProfiles.filter(profile => profile.kind === 'video').length;
    const animationCount = localProfiles.filter(profile => profile.kind === 'animation').length;
    const audioCount = localProfiles.filter(profile => profile.kind === 'audio').length;
    notes.push(`Local FFmpeg: ${localProfiles.length} available profiles (${videoCount} video, ${animationCount} animation, ${audioCount} audio)`);
  } else if (localMediaEngineAvailable) {
    notes.push('No matching FFmpeg output profiles found in this build');
  } else {
    notes.push('Install FFmpeg and launch with start.sh/start.bat for more formats');
  }
  $('#formatSupportNote').textContent = `${notes.join(' · ')}. Codec support depends on this device and its installed encoders.`;
}

async function openExportModal() {
  updateTimelineInfo(); renderPreview();
  const thumb=$('#exportThumb'); const tctx=thumb.getContext('2d'); thumb.width=canvas.width;thumb.height=canvas.height; tctx.drawImage(canvas,0,0,thumb.width,thumb.height);
  await refreshExportFormats();
  $('#exportModal').classList.remove('hidden');
}
function detectRecordFormats() {
  if (!window.MediaRecorder) return {mp4:false,webm:false};
  const supports = types => types.some(t=>{try{return MediaRecorder.isTypeSupported(t);}catch{return false;}});
  return {mp4:supports(['video/mp4;codecs="avc1.42E01E,mp4a.40.2"','video/mp4;codecs=avc1','video/mp4']),webm:supports(['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'])};
}
function pickRecordingType(choice) {
  const mp4=['video/mp4;codecs="avc1.42E01E,mp4a.40.2"','video/mp4;codecs=avc1','video/mp4'];
  const webm=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
  const supports = type => { try { return Boolean(window.MediaRecorder?.isTypeSupported(type)); } catch { return false; } };
  const preferred = choice==='mp4' ? mp4 : choice==='webm' ? webm : [];
  const direct = preferred.find(supports);
  if (direct) return direct;
  if (choice==='mp4' || choice==='webm') {
    if (!localMediaEngineAvailable) return '';
  }
  return [...mp4,...webm].find(supports) || '';
}
async function transcodeRenderedVideo(blob, targetFormat, projectName) {
  const intermediateExt = (blob.type || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm';
  const response = await fetch(`/api/export?format=${encodeURIComponent(targetFormat)}`, {
    method:'POST',
    headers:{'Content-Type':blob.type || 'application/octet-stream', 'X-File-Name':encodeURIComponent(`motionlab-render.${intermediateExt}`), 'X-Export-Name':encodeURIComponent(projectName)},
    body:blob
  });
  if (!response.ok) {
    let message = `Local FFmpeg export failed (${response.status}).`;
    try { const data = await response.json(); if (data.error) message = data.error; } catch {}
    throw new Error(message);
  }
  return await response.blob();
}
function outputSize() {
  const choice=$('#exportResolution').value;
  if (choice==='project') return {width:projectSettings.width,height:projectSettings.height};
  const longEdge=choice==='1280x720'?1280:choice==='1920x1080'?1920:3840; const aspect=projectSettings.width/projectSettings.height;
  if (aspect>=1) return {width:longEdge,height:Math.round(longEdge/aspect)};
  return {width:Math.round(longEdge*aspect),height:longEdge};
}
async function startVideoExport() {
  if (!clips.length || projectDuration()<=0) { toast('Add media to the timeline before exporting.','error'); return; }
  if (!window.MediaRecorder || !canvas.captureStream) { toast('This browser does not support canvas video export. Try a recent Chrome, Edge, Firefox, or Safari version.','error',6000); return; }
  const chosen=$('#exportFormat').value; const mimeType=pickRecordingType(chosen);
  if (!mimeType) { toast('The selected output format is not supported by this browser. Choose another format.','error',6000); return; }
  exportCancelled=false; isExporting=true; $('#renderProgress').classList.remove('hidden'); $('#renderTitle').textContent='Rendering timeline…'; $('#renderPercent').textContent='0%'; $('#renderProgressBar').style.width='0%'; $('#startExportBtn').disabled=true; $('#projectExportFromModal').disabled=true; $('#cancelExportBtn').disabled=false;
  pausePlayback();
  const originalSize={width:canvas.width,height:canvas.height};
  try {
    const size=outputSize();canvas.width=size.width;canvas.height=size.height;
    await ensureAudioGraph();
    playhead=0; syncClipPlayback(playhead,true); renderPreview(); updatePlayheadReadout();
    const fps=Number($('#exportFps').value)||30; const stream=canvas.captureStream(fps);
    if (recordDestination?.stream) recordDestination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
    const bitrate=$('#exportQuality').value==='standard'?5_000_000:$('#exportQuality').value==='max'?20_000_000:10_000_000;
    exportRecorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:bitrate,audioBitsPerSecond:192000});
    const chunks=[];
    exportRecorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data);};
    exportRecorder.onerror=event=>{console.error('MediaRecorder error',event.error);toast(`Export failed: ${event.error?.message||'encoder error'}`,'error',6500);};
    exportRecorder.onstop=async()=>{
      stream.getTracks().forEach(track=>track.stop());
      const recordedType=exportRecorder?.mimeType||mimeType;
      const blob=chunks.length?new Blob(chunks,{type:recordedType}):null;
      const wasCancelled=exportCancelled;
      pausePlayback();isExporting=false;exportRecorder=null;canvas.width=originalSize.width;canvas.height=originalSize.height;renderPreview();updatePlayheadReadout();
      const enableExportActions=()=>{$('#startExportBtn').disabled=false;$('#projectExportFromModal').disabled=false;$('#cancelExportBtn').disabled=false;};
      if (wasCancelled) { enableExportActions();$('#renderTitle').textContent='Export cancelled';$('#renderStatus').textContent='The partial file was discarded.';$('#renderPercent').textContent='—';$('#renderProgressBar').style.width='0%';setStatus('Export cancelled');return; }
      if (!blob?.size) { enableExportActions();$('#renderTitle').textContent='No video was produced';$('#renderStatus').textContent='The browser did not provide an encoded output. Try another format.';toast('The browser returned an empty export. Try another format.','error',6000);return; }
      const safeName=($('#projectName').value||'kayralrics-video').replace(/[\\/:*?"<>|]+/g,'-').trim()||'kayralrics-video';
      const actualExt=(blob.type||recordedType).toLowerCase().includes('mp4')?'mp4':'webm';
      const targetFormat=$('#exportFormat').value || 'auto';
      const profile=formatProfiles.find(item=>item.id===targetFormat);
      const targetNeedsFfmpeg=targetFormat!=='auto' && (profile?.engine==='ffmpeg' || (profile?.extension && profile.extension!==actualExt));
      let finalBlob=blob, finalExt=actualExt;
      if (targetNeedsFfmpeg) {
        if (!localMediaEngineAvailable || profile?.engine==='browser') { enableExportActions();$('#renderTitle').textContent='Output format unavailable';$('#renderStatus').textContent='This format needs the local FFmpeg engine.';toast('Launch with start.sh/start.bat and install FFmpeg to export this format.','error',6500);return; }
        $('#renderTitle').textContent=`Converting to ${profile?.label || targetFormat}…`;
        $('#renderStatus').textContent='Transcoding the rendered timeline with local FFmpeg. Keep this tab open.';
        $('#renderPercent').textContent='—';$('#renderProgressBar').style.width='100%';$('#cancelExportBtn').disabled=true;
        setStatus(`Converting rendered timeline to ${profile?.label || targetFormat}…`);
        try { finalBlob=await transcodeRenderedVideo(blob,targetFormat,safeName);finalExt=profile?.extension || targetFormat; }
        catch(error) { enableExportActions();$('#renderTitle').textContent='Export conversion failed';$('#renderStatus').textContent=error.message;setStatus('Export conversion failed');toast(`Export conversion failed: ${error.message}`,'error',8000);return; }
      } else if (targetFormat!=='auto' && profile?.extension) {
        finalExt=profile.extension;
      }
      enableExportActions();
      downloadBlob(finalBlob,`${safeName}.${finalExt}`);
      const outputLabel=profile?.kind==='audio'?'Audio':profile?.kind==='animation'?'Animation':'Video';
      $('#renderTitle').textContent=`${outputLabel} export complete`;$('#renderStatus').textContent=`Saved ${(finalBlob.size/(1024*1024)).toFixed(1)} MB as ${finalExt.toUpperCase()}.`;
      $('#renderPercent').textContent='100%';$('#renderProgressBar').style.width='100%';setStatus(`${outputLabel} export complete`);toast(`${outputLabel} exported as ${finalExt.toUpperCase()}.`);
    };
    exportRecorder.start(1000); await startPlayback(); setStatus(`Rendering timeline (${mimeType.includes('mp4')?'MP4':'WebM'} intermediate)…`);
    if (!isPlaying) { exportRecorder.stop(); }
  } catch(error) {
    console.error(error); isExporting=false; pausePlayback();canvas.width=originalSize.width;canvas.height=originalSize.height;renderPreview();
    $('#startExportBtn').disabled=false;$('#projectExportFromModal').disabled=false; toast(`Export failed: ${error.message}`,'error',6500);$('#renderTitle').textContent='Export failed';$('#renderStatus').textContent=error.message;
  }
}
function cancelVideoExport() {
  if (!exportRecorder || exportRecorder.state==='inactive') return;
  exportCancelled=true;$('#cancelExportBtn').disabled=true;$('#renderStatus').textContent='Stopping export…';
  try { exportRecorder.stop(); } catch {}
}

async function checkLocalMediaEngine() {
  try {
    const response = await fetch('/api/status', {cache:'no-store'});
    if (!response.ok) throw new Error('Local media API is not available.');
    const data = await response.json();
    localMediaEngineAvailable = Boolean(data.available);
    localMediaEngineVersion = data.version || (data.available ? 'Local FFmpeg' : '');
    if (selectedClipId || selectedAssetId) renderInspector();
    if (data.available) setStatus('Ready · Local FFmpeg conversion enabled');
  } catch {
    localMediaEngineAvailable = false;
    localMediaEngineVersion = '';
    // The editor can run as a directly opened HTML file in browser-only mode.
    // FFmpeg conversion and extended exports require the local Python server.
    if (window.location.protocol === 'file:') {
      setStatus('Browser-only mode · run start.sh for FFmpeg');
    } else if ($('#appStatus').textContent === 'Ready') {
      setStatus('Ready · browser-supported formats only');
    }
  }
  await refreshExportFormats();
}

async function convertAssetForBrowser(assetId) {
  const asset = assetById(assetId);
  if (!asset?.file) { toast('The original source file is not available for conversion.', 'error'); return; }
  if (!localMediaEngineAvailable) { toast('Local FFmpeg conversion is unavailable. Start this project with start.sh/start.bat and install FFmpeg.', 'info', 7000); return; }
  setStatus(`Converting ${asset.name} with local FFmpeg…`);
  toast('Converting a copy locally. Large files can take a while.', 'info', 5000);
  try {
    const conversionKind = asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video';
    const response = await fetch(`/api/convert?kind=${encodeURIComponent(conversionKind)}`, {
      method: 'POST',
      headers: {'Content-Type': asset.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(asset.name)},
      body: asset.file
    });
    if (!response.ok) {
      let message = `Conversion failed (${response.status}).`;
      try { const data = await response.json(); if (data.error) message = data.error; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const outputName = decodeURIComponent(response.headers.get('X-Converted-Name') || `${asset.name}.browser-ready.${asset.kind === 'audio' ? 'm4a' : asset.kind === 'image' ? 'png' : 'mp4'}`);
    const outputType = response.headers.get('X-Converted-Type') || blob.type || (asset.kind === 'audio' ? 'audio/mp4' : asset.kind === 'image' ? 'image/png' : 'video/mp4');
    const convertedFile = new File([blob], outputName, {type:outputType, lastModified:Date.now()});
    const converted = makeAsset(convertedFile, uid(), {kind:asset.kind === 'audio' ? 'audio' : 'video'});
    assets.push(converted);
    selectedAssetId = converted.id;
    selectedClipId = null;
    inspectAssetDuration(converted);
    renderLibrary(); renderInspector(); updateTimelineInfo(); markDirty();
    setStatus('Converted media added to library');
    toast('Converted copy added to the media library. Add it to the timeline to continue.');
  } catch (error) {
    console.error(error);
    setStatus('Local media conversion failed');
    toast(`Conversion failed: ${error.message || 'FFmpeg error'}`, 'error', 8000);
  }
}

function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModalForBackdrop(event) { if(event.target.classList.contains('modal-backdrop')) event.target.classList.add('hidden'); }
function handleTimelinePointerDown(event) {
  const clipEl=event.target.closest('.timeline-clip');
  if (clipEl) {
    const c=clipById(clipEl.dataset.clipId);if(!c)return;
    if(selectedClipId!==c.id)selectClip(c.id);
    liveDrag={id:c.id,startX:event.clientX,originalStart:c.start,moved:false};
    try{clipEl.setPointerCapture(event.pointerId);}catch{}
    event.preventDefault();return;
  }
  const lane=event.target.closest('.track-lane');
  if(lane){const rect=lane.getBoundingClientRect();seekTo((event.clientX-rect.left+lane.scrollLeft)/scale);return;}
}
function handleTimelinePointerMove(event) {
  if(!liveDrag)return;const c=clipById(liveDrag.id);if(!c)return;
  const delta=(event.clientX-liveDrag.startX)/scale;
  if(Math.abs(delta)>.025 && !liveDrag.moved) { recordHistory(); liveDrag.moved=true; }
  c.start=Math.max(0,liveDrag.originalStart+delta);
  if(liveDrag.moved){renderTimeline();renderPreview();updateTimelineInfo();updatePlayheadReadout();}
}
function handleTimelinePointerUp() {
  if(!liveDrag)return;
  if(liveDrag.moved){markDirty();setStatus('Clip moved');}
  liveDrag=null;
}
function setTrackPlus(track) {
  if (track === 'T1') { addTextClip('title'); return; }
  if (selectedAssetId && assetById(selectedAssetId)) { addAssetToTimeline(assetById(selectedAssetId),track); return; }
  pendingTrack=track; mediaInput.click();
}
function updateAspect(aspect) {
  const [w,h]=aspect.split(':').map(Number);let width=projectSettings.width,height=projectSettings.height;
  const ratio=w/h;if(width/height>ratio)width=Math.round(height*ratio);else height=Math.round(width/ratio);
  if(aspect==='16:9'){width=1280;height=720;} if(aspect==='9:16'){width=720;height=1280;} if(aspect==='1:1'){width=1080;height=1080;} if(aspect==='4:5'){width=864;height=1080;} if(aspect==='4:3'){width=1200;height=900;}
  recordHistory();projectSettings={...projectSettings,width,height,aspect};updateProjectCanvasSize();renderTimeline();renderPreview();markDirty();
}
function exportSnapshot() {
  const blobPromise=new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  blobPromise.then(blob=>{if(blob){downloadBlob(blob,`kayralrics-video-frame-${fmtShort(playhead).replace(':','-')}.png`);toast('Preview frame saved as PNG.');}});
}
function makeModalKeyboardSafe(event) {
  if(event.key==='Escape') { $$('.modal-backdrop:not(.hidden)').forEach(m=>m.classList.add('hidden')); }
}

// Main UI events
$('#importButton').addEventListener('click',()=>{pendingTrack=null;mediaInput.click();});
$('#emptyImportBtn').addEventListener('click',()=>mediaInput.click());
$('#addAudioQuick').addEventListener('click',()=>{activeFilter='audio';setPanel('mediaPanel');renderLibrary();pendingTrack='A1';mediaInput.click();});
mediaInput.addEventListener('change',async()=>{const files=[...mediaInput.files];const track=pendingTrack;pendingTrack=null;mediaInput.value='';await importFiles(files,{track});});
$('#assetGrid').addEventListener('click',event=>{
  const add=event.target.closest('[data-add-asset]');if(add){event.stopPropagation();const asset=assetById(add.dataset.addAsset);addAssetToTimeline(asset);return;}
  const card=event.target.closest('[data-asset-id]');if(!card)return;const asset=assetById(card.dataset.assetId);selectedAssetId=asset?.id||null;selectedClipId=null;renderLibrary();renderInspector();
});
$('#assetGrid').addEventListener('dblclick',event=>{const card=event.target.closest('[data-asset-id]');if(!card)return;addAssetToTimeline(assetById(card.dataset.assetId));});
$('#mediaSearch').addEventListener('input',renderLibrary);
$$('.filter-chip').forEach(btn=>btn.addEventListener('click',()=>{activeFilter=btn.dataset.filter;$$('.filter-chip').forEach(b=>b.classList.toggle('active',b===btn));renderLibrary();}));
$('#listViewBtn').addEventListener('click',()=>{listView=!listView;renderLibrary();});
$$('.rail-tool[data-panel]').forEach(btn=>btn.addEventListener('click',()=>setPanel(btn.dataset.panel)));
$('#projectName').addEventListener('input',()=>{markDirty();updateTimelineInfo();});
$('#saveProjectBtn').addEventListener('click',openProjectSaveModal);
$('#openProjectBtn').addEventListener('click',()=>projectInput.click());
$('#projectExportFromModal').addEventListener('click',()=>saveProjectFile($('#embedMediaCheck').checked));
$('#confirmSaveProjectBtn').addEventListener('click',async()=>{const include=$('#embedMediaStandalone').checked;closeModal('projectModal');await saveProjectFile(include);});
$('#openExportBtn').addEventListener('click',openExportModal);
$('#startExportBtn').addEventListener('click',startVideoExport);
$('#cancelExportBtn').addEventListener('click',cancelVideoExport);
$('#undoBtn').addEventListener('click',undo);$('#redoBtn').addEventListener('click',redo);
$('#splitBtn').addEventListener('click',splitSelectedClip);$('#splitQuick').addEventListener('click',splitSelectedClip);
$('#duplicateBtn').addEventListener('click',duplicateSelectedClip);$('#duplicateQuick').addEventListener('click',duplicateSelectedClip);
$('#deleteBtn').addEventListener('click',deleteSelectedClip);$('#deleteQuick').addEventListener('click',deleteSelectedClip);
$('#playBtn').addEventListener('click',togglePlayback);$('#toStartBtn').addEventListener('click',()=>{pausePlayback();seekTo(0);});$('#toEndBtn').addEventListener('click',()=>{pausePlayback();seekTo(projectDuration());});
$('#timelineZoom').addEventListener('input',()=>{scale=Number($('#timelineZoom').value);renderTimeline();});
$('#zoomInBtn').addEventListener('click',()=>{scale=Math.min(100,scale+8);$('#timelineZoom').value=scale;renderTimeline();});$('#zoomOutBtn').addEventListener('click',()=>{scale=Math.max(20,scale-8);$('#timelineZoom').value=scale;renderTimeline();});
$('#timelineInner').addEventListener('pointerdown',handleTimelinePointerDown);
document.addEventListener('pointermove',handleTimelinePointerMove);document.addEventListener('pointerup',handleTimelinePointerUp);
$('#timelineClickShield').addEventListener('click',event=>{const rect=$('#ruler').getBoundingClientRect();seekTo(Math.max(0,(event.clientX-rect.left+$('#ruler').scrollLeft)/scale));});
$$('.track-add').forEach(btn=>btn.addEventListener('click',()=>setTrackPlus(btn.dataset.track)));
$('#addTitleBtn').addEventListener('click',()=>addTextClip('title'));$('#addCaptionBtn').addEventListener('click',()=>addTextClip('caption'));
$$('.filter-preset').forEach(btn=>btn.addEventListener('click',()=>{const c=clipById();if(!c){toast('Select a video or image clip first.','info');return;}recordHistory();applyLook(c,btn.dataset.look);renderInspector();renderPreview();markDirty();$$('.filter-preset').forEach(b=>b.classList.toggle('active',b===btn));}));
$$('[data-effect]').forEach(btn=>btn.addEventListener('click',()=>{const c=clipById();if(!c||c.kind==='audio'||c.kind==='text'){toast('Select a video or image clip first.','info');return;}recordHistory();const prop=btn.dataset.effect==='mirror'?'mirror':btn.dataset.effect; c[prop]=!c[prop];btn.classList.toggle('enabled',c[prop]);renderInspector();renderPreview();markDirty();}));
function startInspectorHistory(event) {
  const target = event.target.closest('[data-prop]:not(button)');
  if (target && !target.dataset.historyRecorded) { recordHistory(); target.dataset.historyRecorded = '1'; }
}
inspectorContent.addEventListener('pointerdown',startInspectorHistory);
inspectorContent.addEventListener('focusin',startInspectorHistory);
inspectorContent.addEventListener('input',event=>{if(event.target.matches('[data-prop]')){applyInspectorProp(event.target,{commit:false}); if(event.target.type==='range'){const next=event.target.nextElementSibling;if(next&&next.tagName==='OUTPUT')next.textContent=`${event.target.value}%`;}}});
inspectorContent.addEventListener('change',event=>{if(event.target.matches('[data-prop]')){applyInspectorProp(event.target,{commit:false});renderInspector();}});
inspectorContent.addEventListener('click',event=>{
  const segment=event.target.closest('button[data-prop][data-value]'); if(segment){const prop=segment.dataset.prop,value=segment.dataset.value;recordHistory();selectedClipMutate(prop,value,{redraw:true});renderInspector();return;}
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action==='split')splitSelectedClip();if(action==='duplicate')duplicateSelectedClip();if(action==='delete')deleteSelectedClip();if(action==='convert'){const c=clipById();convertAssetForBrowser(c?.assetId||selectedAssetId);}if(action==='codec-info'){toast(`This build uses your browser's built-in media decoders. For uncommon codecs, install FFmpeg and restart the local server, or convert the file with a separate media tool.`, 'info', 7500);}if(action==='add-asset')addAssetToTimeline(assetById(selectedAssetId));
});
$('#masterVolume').addEventListener('input',()=>{const v=Number($('#masterVolume').value);$('#masterVolumeOut').textContent=`${v}%`;if(masterGain)masterGain.gain.value=v/100;});
$('#aspectSelect').addEventListener('change',()=>updateAspect($('#aspectSelect').value));
$('#qualitySelect').addEventListener('change',()=>{updateProjectCanvasSize();renderPreview();});
$('#fullscreenBtn').addEventListener('click',()=>{const target=$('.preview-mat');if(document.fullscreenElement)document.exitFullscreen?.();else target.requestFullscreen?.().catch(()=>{});});
$('#fitPreviewBtn').addEventListener('click',()=>{updateProjectCanvasSize();toast('Preview fitted to the workspace.','info',1600);});
$('#snapshotBtn').addEventListener('click',exportSnapshot);
$('#helpBtn').addEventListener('click',()=>openModal('helpModal'));
$$('[data-close-modal]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.dataset.closeModal)));
$$('.modal-backdrop').forEach(modal=>modal.addEventListener('click',closeModalForBackdrop));
projectInput.addEventListener('change',async()=>{const f=projectInput.files?.[0];projectInput.value='';if(f)await handleProjectFile(f);});
$('#privacyInfoBtn').addEventListener('click',()=>toast(localMediaEngineAvailable?'Ordinary editing stays in your browser. When you choose conversion, that file is sent to this configured editor server (localhost by default) for local FFmpeg processing.':'Your media stays in this browser tab for editing and is not uploaded by this static build. Web fonts may load from an external CDN.','info',7000));
relinkInput.addEventListener('change',async()=>{
  const files=[...(relinkInput.files||[])];relinkInput.value='';if(!pendingProjectData)return;
  if(!files.length){toast('Project relinking cancelled.','info');pendingProjectData=null;return;}
  const map=new Map(files.map(f=>[f.name.toLowerCase(),f]));const data=pendingProjectData;pendingProjectData=null;
  try{await applyProjectData(data,map);}catch(error){toast(`Could not relink project: ${error.message}`,'error',6000);}
});
// Open project is available from the project name context and Ctrl+O.
$('#projectName').addEventListener('contextmenu',event=>{event.preventDefault();projectInput.click();});

// Drop files onto the media library, or onto the timeline to import and add them.
const dropTargets=[$('#libraryPanel'),$('.editor-stage'),$('.import-dropzone')];
dropTargets.forEach(target=>{
  target.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files')){event.preventDefault();$('.import-dropzone').classList.add('dragging');}});
  target.addEventListener('dragleave',()=>$('.import-dropzone').classList.remove('dragging'));
  target.addEventListener('drop',async event=>{const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();$('.import-dropzone').classList.remove('dragging');const addToTimeline=target.classList.contains('editor-stage');await importFiles(files);if(addToTimeline){const imported=assets.filter(a=>files.some(f=>f.name===a.name&&f.size===a.size));imported.forEach(a=>addAssetToTimeline(a));}});
});

// Keyboard shortcuts are disabled while typing into editable controls.
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){makeModalKeyboardSafe(event);return;}
  const tag=event.target?.tagName?.toLowerCase();const typing=['input','textarea','select'].includes(tag)||event.target?.isContentEditable;
  const mod=event.ctrlKey||event.metaKey;
  if(mod&&event.key.toLowerCase()==='s'){event.preventDefault();openProjectSaveModal();return;}
  if(mod&&event.key.toLowerCase()==='o'){event.preventDefault();projectInput.click();return;}
  if(mod&&event.key.toLowerCase()==='z'){event.preventDefault();undo();return;}
  if(mod&&(event.key.toLowerCase()==='y'||(event.shiftKey&&event.key.toLowerCase()==='z'))){event.preventDefault();redo();return;}
  if(mod&&event.key.toLowerCase()==='d'){event.preventDefault();duplicateSelectedClip();return;}
  if(typing)return;
  if(event.code==='Space'){event.preventDefault();togglePlayback();}
  else if(event.key.toLowerCase()==='s'){splitSelectedClip();}
  else if(event.key==='Delete'||event.key==='Backspace'){deleteSelectedClip();}
  else if(event.key==='ArrowLeft'){event.preventDefault();seekTo(playhead-.1);}
  else if(event.key==='ArrowRight'){event.preventDefault();seekTo(playhead+.1);}
});
window.addEventListener('resize',resizePreviewMat);
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});

// Startup
function init() {
  scale=Number($('#timelineZoom').value);updateProjectCanvasSize();renderLibrary();renderTimeline();renderInspector();renderPreview();updateTimelineInfo();updateUndoRedo();checkLocalMediaEngine();
  const support=detectRecordFormats();
  if(!support.mp4&&!support.webm){setStatus('This browser may not support video export');}
}
init();
