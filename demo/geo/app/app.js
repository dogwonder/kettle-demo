import { bindFilePicker } from './file-picker.js';
import { clearMap, setPack, setMapResults, toggleMap, fitMap } from './map.js';

const $ = id => document.getElementById(id);
// Inside the Kettle app this page can go back to the chooser, save through the app's own window,
// and say when an index is being made so that quitting asks first.
const invoke = window.__TAURI__?.core?.invoke;
const hosted = new URLSearchParams(location.search).get('kettle') === '1' && Boolean(invoke);
const files = count => `${count} ${count === 1 ? 'file' : 'files'}`;
let folder = null;
let busy = false;
let results = null;
let shownJob = null;
let locationAccuracy = null;
const controls = ['choose-folder', 'use-folder', 'index', 'reindex', 'search', 'download', 'folder', 'mode', 'lat', 'lon', 'radius', 'bbox', 'from', 'to', 'limit', 'locate', 'show-map', 'fit-map', 'choose-map', 'clear-map', 'use-map', 'map-pack-path'];

function working(on) {
  if (hosted && on !== busy) invoke('cup_state', { dirty: on, busy: on }).catch(() => {});
  busy = on;
  document.body.toggleAttribute('data-running', on);
  for (const id of controls) $(id).disabled = on;
  for (const button of document.querySelectorAll('.reveal')) button.disabled = on;
  if (on) $('picker').classList.remove('dragging');
  $('index-section').setAttribute('aria-busy', String(on));
  if (!on) modeChanged();
}

function problem(message) {
  $('problem').hidden = !message;
  $('problem-text').textContent = message;
  if (message) $('problem').focus();
}

async function request(route, body) {
  let response;
  try {
    response = await fetch(route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kttl-Geo': '1' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Geo’s local server is unavailable. Restart it, then choose your folder again.');
  }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Geo could not complete that request.');
  return value;
}

function clearResults() {
  clearMap();
  results = null;
  $('results').hidden = true;
  $('result-list').replaceChildren();
}

function showFolder(value) {
  if (!folder || folder.path !== value.path) clearResults();
  folder = value;
  $('folder').value = value.path;
  $('index-path').textContent = value.path;
  $('index-section').hidden = false;
  $('coverage').hidden = !value.indexed;
  $('search-section').hidden = !value.indexed;
  $('reindex').hidden = !value.indexed;
  $('index').textContent = value.indexed ? 'Update the index' : 'Make the index';
  $('index-facts').textContent = value.indexed ? 'Search the saved index, or update it after your files change.' : 'This folder has no Geo index yet. Make one to search its recorded GPS.';
  $('scan-note').textContent = value.indexed ? 'Search reads the last completed scan; choosing this folder does not rescan it.' : 'The index will be kept in .kttl/geo.sqlite inside this folder.';
  $('issues').hidden = true;
  if (!value.indexed) return;
  const state = value.status;
  for (const key of ['indexed', 'located', 'unlocated', 'failed']) $(`count-${key}`).textContent = String(state.coverage[key]);
  if (state.last_scan) {
    const scan = state.last_scan;
    const skipped = scan.skipped.unsupported + scan.skipped.symlinks + scan.skipped.non_regular;
    $('scan-note').textContent = `Last scan ${new Date(scan.completed_at).toLocaleString()}. ${skipped} entries skipped. Search uses this saved snapshot.`;
  }
  if (state.total_issues) {
    $('issues').hidden = false;
    $('issues-title').textContent = `${files(state.total_issues)} with failures or warnings`;
    $('issue-list').replaceChildren(...state.issues.map(issue => {
      const item = document.createElement('li');
      item.textContent = `${issue.path}: ${issue.scan_state} — ${issue.error_message || issue.warning_message}`;
      return item;
    }));
    $('issues-note').textContent = state.issues_truncated ? `Showing the first ${state.issues_limit}; every reason is retained in the index.` : 'Re-index all files to retry unchanged failures.';
  }
}

async function openFolder(route, body) {
  if (busy) return;
  working(true);
  problem('');
  $('status').textContent = route === '/api/choose' ? 'Choose a folder in the window that has opened…' : 'Reading the saved index…';
  try {
    const value = await request(route, body);
    if (!value.cancelled) showFolder(value);
    $('status').textContent = value.cancelled ? 'Folder choice cancelled.' : 'Folder ready. No files have been scanned.';
  } catch (error) {
    problem(error.message);
    $('status').textContent = '';
  } finally {
    working(false);
  }
}

function modeChanged() {
  const radius = $('mode').value === 'radius';
  const bbox = $('mode').value === 'bbox';
  $('radius-fields').hidden = !radius;
  $('bbox-fields').hidden = !bbox;
  for (const id of ['lat', 'lon', 'radius']) { $(id).required = radius; $(id).disabled = busy || !radius; }
  $('bbox').required = bbox;
  $('bbox').disabled = busy || !bbox;
  $('locate').disabled = busy || !radius;
}

function showAccuracy() {
  if (locationAccuracy === null) return;
  const radius = Number.parseFloat($('radius').value);
  const rounded = Math.ceil(locationAccuracy);
  $('location-status').textContent = `Current location filled. ${hosted ? 'macOS' : 'Browser'}-reported accuracy: about ${rounded} m.${Number.isFinite(radius) && radius < locationAccuracy ? ' That is wider than your chosen radius.' : ''} Check the centre and radius, then choose Find photographs.`;
}

async function locate() {
  if (busy || !folder || $('mode').value !== 'radius') return;
  problem('');
  if (!hosted && (!window.isSecureContext || !navigator.geolocation)) {
    problem('Location is unavailable in this browser. Use Geo’s localhost address or enter latitude and longitude yourself.');
    return;
  }
  working(true);
  locationAccuracy = null;
  $('location-status').textContent = hosted ? 'Requesting your location… Allow location access for Kettle if macOS asks.'
    : 'Requesting your location… Allow location access in your browser if asked.';
  let filled = false;
  try {
    // The app's window cannot ask for a location itself, so Kettle asks macOS for one reading.
    const {latitude, longitude, accuracy} = hosted ? await invoke('current_location')
      : (await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
        {enableHighAccuracy: false, timeout: 10000, maximumAge: 0}))).coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) || accuracy < 0 ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error(`${hosted ? 'macOS' : 'The browser'} returned an invalid location. Enter latitude and longitude yourself.`);
    }
    $('lat').value = String(latitude);
    $('lon').value = String(longitude);
    locationAccuracy = accuracy;
    showAccuracy();
    filled = true;
  } catch (error) {
    const message = ({1: 'Location permission was denied. Enter coordinates yourself, or allow location access in your browser and try again.',
      2: 'Your browser could not determine your location. Check your computer’s location settings or enter coordinates yourself.',
      3: 'The location request timed out. Try again or enter coordinates yourself.'})[error.code]
      // Kettle's own reasons arrive as plain text.
      || (typeof error === 'string' ? error : error.message) || 'Location is unavailable. Enter coordinates yourself.';
    $('location-status').textContent = message;
    problem(message);
  } finally {
    working(false);
    if (filled) $('lat').focus();
  }
}

function filters() {
  return Object.fromEntries(['mode', 'lat', 'lon', 'radius', 'bbox', 'from', 'to', 'limit'].map(id => [id, $(id).value]));
}

function describe(query) {
  let text = query.mode === 'radius' ? `Within ${query.radius} m of ${query.lat}, ${query.lon}` : query.mode === 'bbox' ? `Box ${query.bbox}` : 'All recorded GPS locations';
  if (query.from || query.to) text += `; recorded local dates ${query.from || 'any'} to ${query.to || 'any'}`;
  return text;
}

function showResults(value, query) {
  results = value;
  $('results').hidden = false;
  $('result-count').textContent = `Showing ${value.hits.length} of ${value.total_matches} matches${value.truncated ? ` (limited to ${value.limit})` : ''}. ${files(value.coverage.unlocated)} ${value.coverage.unlocated === 1 ? 'has' : 'have'} no GPS; ${value.coverage.failed} failed.`;
  $('result-query').textContent = describe(query);
  const items = value.hits.map((hit, index) => {
    const item = document.createElement('li'); item.className = 'photo'; item.id = `photo-${index}`; item.tabIndex = -1;
    const path = document.createElement('p'); path.className = 'photo-path'; path.textContent = hit.path;
    item.append(path);
    if (/\.(jpe?g|png|webp)$/i.test(hit.path)) {
      const image = document.createElement('img'); image.alt = `Photograph: ${hit.path}`; image.loading = 'lazy';
      image.src = `/api/photo?folder=${encodeURIComponent(folder.path)}&file=${encodeURIComponent(hit.path)}`;
      image.addEventListener('error', () => { image.remove(); const note = document.createElement('p'); note.className = 'small muted'; note.textContent = 'Preview unavailable. Open the file in your file browser.'; path.after(note); });
      item.append(image);
    } else {
      const note = document.createElement('p'); note.className = 'small muted'; note.textContent = 'Open this format in your file browser.'; item.append(note);
    }
    const coordinates = document.createElement('p'); coordinates.className = 'small';
    coordinates.textContent = `${hit.latitude.toFixed(6)}, ${hit.longitude.toFixed(6)} · ${hit.gps_source}`; item.append(coordinates);
    if (hit.distance_m !== null) { const distance = document.createElement('p'); distance.className = 'small'; distance.textContent = `${hit.distance_m.toFixed(1)} m from your point`; item.append(distance); }
    const date = document.createElement('p'); date.className = 'small muted'; date.textContent = hit.capture_time_raw ? `Recorded time: ${hit.capture_time_raw}${hit.capture_offset_raw ? ` (offset ${hit.capture_offset_raw})` : ''}` : 'No capture time recorded'; item.append(date);
    if (hit.warning_message) { const warning = document.createElement('p'); warning.className = 'small'; warning.textContent = hit.warning_message; item.append(warning); }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'govuk-button govuk-button--secondary reveal'; button.textContent = 'Show in file browser'; button.setAttribute('aria-label', `Show ${hit.path} in file browser`);
    button.addEventListener('click', async () => {
      if (busy) return;
      working(true); problem('');
      try { await request('/api/reveal', {folder: folder.path, file: hit.path}); $('status').textContent = `Shown in file browser: ${hit.path}`; }
      catch (error) { problem(error.message); }
      finally { working(false); modeChanged(); }
    }); item.append(button);
    return item;
  });
  $('result-list').replaceChildren(...items);
  setMapResults(value.hits, query, folder.path);
  $('results-title').focus();
}

async function pollIndex() {
  try {
    const state = await request('/api/state');
    setPack(state.map_pack);
    if (state.folder) showFolder(state.folder);
    const job = state.job;
    if (job?.state === 'running') {
      working(true);
      $('status').textContent = job.force ? 'Re-indexing every file’s recorded GPS… You can leave this page open.' : 'Reading new and changed files’ recorded GPS… You can leave this page open.';
      setTimeout(pollIndex, 500);
      return;
    }
    if (job && shownJob !== job) {
      shownJob = job;
      clearResults();
      if (job.state === 'failed') { $('status').textContent = folder?.indexed ? 'Indexing failed. The previous index was retained.' : 'Indexing failed. No completed index was created.'; problem(job.error); }
      else { const s = job.result.scan; $('status').textContent = `Index ready: ${files(s.extracted)} read, ${s.unchanged} unchanged, ${s.removed} removed. ${job.result.coverage.failed} failed.`; }
    }
    working(false); modeChanged();
  } catch (error) { working(false); modeChanged(); problem(error.message); }
}

async function index(force) {
  if (busy || !folder) return;
  working(true); problem(''); clearResults();
  $('status').textContent = force ? 'Starting a full re-index…' : 'Starting an incremental scan…';
  try { await request('/api/index', {folder: folder.path, force}); await pollIndex(); }
  catch (error) { working(false); modeChanged(); problem(error.message); $('status').textContent = ''; }
}

$('choose-folder').addEventListener('click', () => openFolder('/api/choose', {}));
async function openMapPack(route, body) {
  if (busy) return;
  working(true); problem('');
  $('status').textContent = route === '/api/choose-map' ? 'Choose an offline map pack in the window…' : 'Opening the local map pack…';
  try {
    const value = await request(route, body);
    if (!value.cancelled) setPack(value.map_pack);
    $('status').textContent = value.cancelled ? 'Map pack choice cancelled.' : value.map_pack ? 'Offline map pack ready. Nothing was downloaded or changed.' : 'Map pack removed from this session. The file stays on disk.';
  } catch (error) { problem(error.message); $('status').textContent = ''; }
  finally { working(false); }
}
$('show-map').addEventListener('click', () => { if (!busy) toggleMap(); });
$('fit-map').addEventListener('click', () => { if (!busy) fitMap(); });
$('choose-map').addEventListener('click', () => openMapPack('/api/choose-map', {}));
$('clear-map').addEventListener('click', () => openMapPack('/api/clear-map', {}));
$('map-pack-form').addEventListener('submit', event => { event.preventDefault(); openMapPack('/api/map-pack', {path: $('map-pack-path').value}); });
$('folder-form').addEventListener('submit', event => { event.preventDefault(); openFolder('/api/folder', {path: $('folder').value}); });
bindFilePicker({ input: document.createElement('input'), buttons: [], zone: $('picker'), busy: () => busy,
  accept: files => files.length === 1 ? openFolder('/api/drop', {name: files[0].name}) : problem('Drop one folder at a time.') });
$('mode').addEventListener('change', modeChanged);
$('locate').addEventListener('click', locate);
$('radius').addEventListener('input', showAccuracy);
for (const id of ['lat', 'lon']) $(id).addEventListener('input', () => { locationAccuracy = null; $('location-status').textContent = ''; });
$('index').addEventListener('click', () => index(false));
$('reindex').addEventListener('click', () => index(true));
$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !folder) return;
  const query = filters();
  working(true); problem(''); $('status').textContent = 'Searching recorded GPS…';
  try { const value = await request('/api/search', {folder: folder.path, filters: query}); showResults(value, query); $('status').textContent = value.total_matches ? 'Search complete.' : 'No recorded locations match these settings.'; }
  catch (error) { problem(error.message); $('status').textContent = ''; }
  finally { working(false); modeChanged(); }
});
$('download').addEventListener('click', async () => {
  if (!results || busy) return;
  const value = {type: 'FeatureCollection', total_matches: results.total_matches, limit: results.limit, truncated: results.truncated,
    features: results.hits.map(hit => ({type: 'Feature', geometry: {type: 'Point', coordinates: [hit.longitude, hit.latitude]},
      properties: Object.fromEntries(Object.entries(hit).filter(([key]) => !['latitude', 'longitude'].includes(key)))}))};
  const content = JSON.stringify(value, null, 2) + '\n';
  if (hosted) {
    // The app's window has no downloads folder of its own, so Kettle asks where to save.
    try {
      const saved = await invoke('save_text_result', { filename: 'geo-results.geojson', content });
      $('status').textContent = saved ? `GeoJSON saved with ${results.hits.length} displayed matches.` : 'Not saved. The results are still here.';
    } catch { problem('The GeoJSON could not be saved. Check the destination and try again.'); }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], {type: 'application/geo+json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'geo-results.geojson'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('status').textContent = `GeoJSON download prepared with ${results.hits.length} displayed matches.`;
});
if (hosted) {
  $('return-kettle').hidden = false;
  const back = () => invoke('show_chooser').catch(() => problem('Kettle could not open. Your folder and results are still here.'));
  $('return-kettle').addEventListener('click', back);
  // The logo is a link to this page. In the app that would reload it without Kettle, so it goes back to Kettle instead.
  document.querySelector('.wordmark')?.addEventListener('click', event => { event.preventDefault(); back(); });
  $('location-hint').textContent = 'Asks macOS for one location reading, with your permission. macOS may contact Apple’s location service to work it out. Geo uses it as the search centre and does not save it.';
  $('download').textContent = 'Save these results as GeoJSON';
}
modeChanged();
pollIndex();
