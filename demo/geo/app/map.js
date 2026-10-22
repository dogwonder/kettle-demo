// Leaflet and every tile/preview are served by Geo's loopback server.
const $ = id => document.getElementById(id);
let map, shapes, tiles, pack = null, hits = [], query = null, failedTiles = false;
const mercator = 85.05112878;
const clamp = lat => Math.max(-mercator, Math.min(mercator, lat));

export function clearMap() {
  if (map) { map.remove(); map = null; }
  shapes = null; tiles = null; hits = []; query = null;
  $('map-section').hidden = true;
  $('show-map').textContent = 'Show results on map';
  $('show-map').setAttribute('aria-expanded', 'false');
}

export function setPack(value) {
  const changed = pack?.id !== value?.id;
  pack = value;
  $('map-pack-path').value = pack?.path || '';
  $('clear-map').hidden = !pack;
  $('map-pack-info').textContent = pack
    ? `${pack.name} · ${(pack.size_bytes / 1024 / 1024).toFixed(1)} MiB · ${pack.regions ? pack.regions.map(r => `${r.name}: zoom ${r.minzoom}–${r.maxzoom}`).join('; ') : `zoom ${pack.minzoom}–${pack.maxzoom} · bounds ${pack.bounds.join(', ')}`}. Opened read-only for this server session.`
    : 'No offline map pack selected. Photo positions can still be shown, without a street background.';
  if (map && changed) { background(); draw(); }
}

function layers() {
  return pack?.regions || (pack ? [pack] : []);
}

function detailAt(point, zoom = 20) {
  return layers().filter(r => zoom >= r.minzoom && point.lng >= r.bounds[0] && point.lng <= r.bounds[2]
    && point.lat >= r.bounds[1] && point.lat <= r.bounds[3]).at(-1);
}

function note() {
  const notices = [];
  if (!pack) notices.push('No offline map pack selected: showing positions without streets or place names.');
  else {
    const [west, south, east, north] = pack.bounds;
    if (map.getZoom() < pack.minzoom) notices.push(`Zoom in to level ${pack.minzoom} to see this pack’s background.`);
    const detail = detailAt(map.getCenter(), map.getZoom());
    if (pack.regions && detail) notices.push(`${detail.name}. ${detail.description}`);
    if (detail && map.getZoom() > detail.maxzoom) notices.push(`Background is enlarged from zoom ${detail.maxzoom}; no finer map detail is available here.`);
    const outside = hits.filter(h => h.longitude < west || h.longitude > east || h.latitude < south || h.latitude > north).length;
    if (outside) notices.push(`${outside} displayed ${outside === 1 ? 'photograph is' : 'photographs are'} outside this pack’s coverage.`);
    const view = map.getBounds();
    if (view.getWest() < west || view.getEast() > east || view.getSouth() < south || view.getNorth() > north)
      notices.push('Part of this view is outside the offline pack; background is available only within its coverage.');
    if (!pack.attribution) notices.push('This pack provides no attribution. Check its source licence before sharing any map.');
    if (failedTiles) notices.push('Some background tiles are missing or unreadable. Photo markers remain available; reselect the pack if it changed on disk.');
  }
  const polar = hits.filter(h => Math.abs(h.latitude) > mercator).length;
  if (polar) notices.push(`${polar} ${polar === 1 ? 'position is' : 'positions are'} beyond this map’s latitude range; use the results list for the recorded coordinates.`);
  if (query?.mode === 'radius' && Math.abs(Number(query.lat)) > mercator)
    notices.push('The search centre is beyond this map’s latitude range.');
  $('map-note').textContent = notices.join(' ') || 'Map background is read from your local pack. Recorded GPS has not been independently verified.';
}

function background() {
  if (tiles) { map.removeLayer(tiles); tiles = null; }
  failedTiles = false;
  map.setMinZoom(0); map.setMaxZoom(20);
  if (pack) {
    tiles = L.layerGroup();
    layers().forEach((region, index) => {
      const [w, s, e, n] = region.bounds;
      const layer = L.tileLayer(`/api/map-tile?pack=${encodeURIComponent(pack.id)}&z={z}&x={x}&y={y}`, {
        bounds: [[s, w], [n, e]], noWrap: true, zIndex: index + 1,
        minZoom: region.minzoom, maxZoom: 20, maxNativeZoom: region.maxzoom,
        attribution: index === 0 ? pack.attribution : undefined,
      });
      layer.on('tileerror', () => { failedTiles = true; note(); });
      tiles.addLayer(layer);
    });
    tiles.addTo(map);
  }
}

export function fitMap() {
  if (!map || !shapes) return;
  const bounds = shapes.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, {padding: [24, 24], maxZoom: pack ? (detailAt(bounds.getCenter())?.maxzoom ?? pack.maxzoom) : 16, animate: false});
  else if (pack) { const [w, s, e, n] = pack.bounds; map.fitBounds([[s, w], [n, e]], {animate: false}); }
  else map.setView([0, 0], 2, {animate: false});
  note();
}

function draw() {
  if (!map) return;
  if (shapes) map.removeLayer(shapes);
  shapes = L.featureGroup().addTo(map);
  // Merge exact duplicate positions so every co-located photo remains reachable.
  const points = new Map();
  for (const hit of hits) {
    if (Math.abs(hit.latitude) > mercator) continue;
    const key = `${hit.latitude},${hit.longitude}`;
    if (!points.has(key)) points.set(key, []);
    points.get(key).push(hit);
  }
  for (const group of points.values()) {
    const hit = group[0];
    const marker = L.marker([hit.latitude, hit.longitude], {icon: L.divIcon({className: 'photo-marker',
      html: '<span aria-hidden="true"></span>', iconSize: [18, 18], iconAnchor: [9, 9]}),
      title: group.length === 1 ? hit.path : `${group.length} photographs at this position`,
      alt: group.length === 1 ? hit.path : `${group.length} photographs`, keyboard: true, riseOnHover: true});
    marker.bindPopup(() => {
      const content = document.createElement('div'); content.className = 'map-preview';
      for (const found of group) {
        const label = document.createElement('p'); label.textContent = found.path; content.append(label);
        if (/\.(jpe?g|png|webp)$/i.test(found.path)) {
          const img = document.createElement('img'); img.alt = `Photograph: ${found.path}`; img.loading = 'lazy';
          img.src = `/api/photo?folder=${encodeURIComponent(found.folder)}&file=${encodeURIComponent(found.path)}`;
          img.addEventListener('error', () => { img.replaceWith(document.createTextNode('Preview unavailable; use the results list.')); });
          content.append(img);
        }
        const link = document.createElement('a'); link.href = `#${found.resultId}`; link.textContent = 'View photograph details';
        link.addEventListener('click', () => { map.closePopup(); $(found.resultId)?.focus(); });
        content.append(link);
      }
      return content;
    }, {maxWidth: 260, maxHeight: 320});
    marker.addTo(shapes);
  }
  if (query?.mode === 'radius' && Math.abs(Number(query.lat)) <= mercator) {
    L.circle([Number(query.lat), Number(query.lon)], {radius: Number(query.radius), color: '#263b56', weight: 2, fillOpacity: 0.06, interactive: false}).addTo(shapes);
    L.circleMarker([Number(query.lat), Number(query.lon)], {radius: 5, color: '#fff', fillColor: '#263b56', fillOpacity: 1, weight: 2, interactive: false}).addTo(shapes);
  } else if (query?.mode === 'bbox') {
    const [w, s, e, n] = query.bbox.split(',').map(Number);
    L.rectangle([[clamp(s), w], [clamp(n), e]], {color: '#263b56', weight: 2, fillOpacity: 0.03, interactive: false}).addTo(shapes);
  }
  $('map-caption').textContent = `Mapping ${hits.length} displayed ${hits.length === 1 ? 'photograph' : 'photographs'}. Orange markers open previews.${query?.mode === 'radius' ? ' The blue circle shows the completed search’s radius.' : ''} Changing the form does not change this map until you search again.`;
  fitMap();
}

export function setMapResults(value, completedQuery, folder) {
  hits = value.map((hit, index) => ({...hit, folder, resultId: `photo-${index}`}));
  query = {...completedQuery};
  if (map && !$('map-section').hidden) draw();
}

export function toggleMap() {
  const visible = $('map-section').hidden;
  $('map-section').hidden = !visible;
  $('show-map').textContent = visible ? 'Hide map' : 'Show results on map';
  $('show-map').setAttribute('aria-expanded', String(visible));
  if (!visible) return;
  if (!map) {
    map = L.map('map', {scrollWheelZoom: false, worldCopyJump: true, minZoom: 0, maxZoom: 20}).setView([0, 0], 2);
    map.attributionControl.setPrefix(false);
    map.on('moveend', note);
    background();
  }
  map.invalidateSize(); draw();
}
