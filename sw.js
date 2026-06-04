// AGRO BASE Field — Service Worker
// Cache de tiles de mapa + assets do app para uso offline

const CACHE_APP = 'agrobase-app-v1';
const CACHE_TILES = 'agrobase-tiles-v1';
const CACHE_TILES_MAX = 500; // máximo de tiles armazenados

// Assets do app para pré-cachear
const APP_ASSETS = [
  './',
  './index.html',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/fonts/tabler-icons.woff2',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&family=Barlow:wght@400;500;600&display=swap',
];

// Hosts de tiles que devem ser cacheados
const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
];

// ── INSTALL ─────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_APP)
      .then(cache => cache.addAll(APP_ASSETS).catch(err => {
        console.warn('[SW] Alguns assets não cacheados:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_APP && k !== CACHE_TILES)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Tiles de mapa — cache first, depois rede
  if (TILE_HOSTS.some(h => url.hostname.includes(h))) {
    e.respondWith(cacheTileFirst(e.request));
    return;
  }

  // Fontes e CDN — cache first
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('jsdelivr.net') ||
      url.hostname.includes('unpkg.com')) {
    e.respondWith(cacheFirst(e.request, CACHE_APP));
    return;
  }

  // Firebase — sempre rede (dados em tempo real)
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('firestore') ||
      url.hostname.includes('googleapis.com/firestore')) {
    return; // deixa passar sem interceptar
  }

  // App shell (index.html) — rede primeiro, fallback cache
  if (url.pathname === '/' || url.pathname.endsWith('index.html')) {
    e.respondWith(networkFirst(e.request));
    return;
  }
});

// ── ESTRATÉGIAS ───────────────────────────────────────

// Cache de tiles: retorna do cache imediatamente, atualiza em background
async function cacheTileFirst(request) {
  const cache = await caches.open(CACHE_TILES);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request.clone(), { mode: 'cors' });
    if (response.ok) {
      // Limita o tamanho do cache de tiles
      await limitarCacheTiles(cache);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline e sem cache — retorna tile transparente
    return new Response(
      tileFallback(),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

// Cache first: usa cache se disponível
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Network first: tenta rede, fallback cache
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_APP);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cache = await caches.open(CACHE_APP);
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

// Limita tiles em cache para não encher o armazenamento
async function limitarCacheTiles(cache) {
  const keys = await cache.keys();
  if (keys.length >= CACHE_TILES_MAX) {
    // Remove os 50 mais antigos
    const toDelete = keys.slice(0, 50);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

// Tile transparente 1x1px para uso offline
function tileFallback() {
  // PNG 1x1 transparente em base64
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── MENSAGENS DO APP ──────────────────────────────────
// Permite que o app envie comandos ao SW
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();

  // Pré-carrega tiles de uma área específica
  if (e.data?.tipo === 'PRECACHE_TILES' && e.data.bounds) {
    precacheTilesArea(e.data.bounds, e.data.zoom || [14, 17]);
  }
});

// Pré-cacheia tiles de uma bounding box em níveis de zoom especificados
async function precacheTilesArea(bounds, zoomRange) {
  const cache = await caches.open(CACHE_TILES);
  const [minLat, maxLat, minLng, maxLng] = bounds;
  const [minZ, maxZ] = zoomRange;
  let count = 0;

  for (let z = minZ; z <= maxZ; z++) {
    const [xMin, yMin] = latlngToTile(maxLat, minLng, z);
    const [xMax, yMax] = latlngToTile(minLat, maxLng, z);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        // Esri
        const esriUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
        // OSM
        const osmUrl = `https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`;

        try {
          if (!await cache.match(esriUrl)) {
            const r = await fetch(esriUrl, { mode: 'cors' });
            if (r.ok) { cache.put(esriUrl, r); count++; }
          }
        } catch {}

        try {
          if (!await cache.match(osmUrl)) {
            const r = await fetch(osmUrl, { mode: 'cors' });
            if (r.ok) { cache.put(osmUrl, r); count++; }
          }
        } catch {}

        // Notifica progresso a cada 10 tiles
        if (count % 10 === 0) {
          self.clients.matchAll().then(clients =>
            clients.forEach(c => c.postMessage({ tipo: 'PRECACHE_PROGRESS', count }))
          );
        }
      }
    }
  }

  self.clients.matchAll().then(clients =>
    clients.forEach(c => c.postMessage({ tipo: 'PRECACHE_DONE', count }))
  );
}

function latlngToTile(lat, lng, z) {
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, z));
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
  return [x, y];
}
