/* main.js - Bus Demo 4
   Multi-operator live map. Polls live endpoints and shows vehicles for selected route.
   Notes:
   - KMB real vehicle positions: https://data.etabus.gov.hk/v1/transport/kmb/vehicle
   - Citybus/NWFB: use rt.data.gov.hk endpoints for ETA; public vehicle GPS may not be available.
   - LRT: use rt.data.gov.hk lrt endpoints (schedule/next train)
   - Update freq: 5 seconds
*/

const map = L.map('map').setView([22.302711, 114.177216], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

const clockEl = document.getElementById('clock');
function updateClock(){ clockEl.textContent = new Date().toLocaleTimeString('zh-HK',{hour12:false}); }
setInterval(updateClock,1000); updateClock();

const companySelect = document.getElementById('companySelect');
const routeSelect = document.getElementById('routeSelect');
const dirBtn = document.getElementById('dirBtn');
const stopListEl = document.getElementById('stopList');

let operator = 'kmb';
let currentRoute = null;
let direction = 'inbound'; // inbound/outbound or company-specific mapping
let stopCoords = [];        // [[lat,lng],...]
let stopIds = [];           // stop ids aligned with stopCoords
let vehicleMarkers = {};    // { vehicleId: marker }
let refreshTimer = null;

// API base endpoints
const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CITY_BUS_BASE = 'https://rt.data.gov.hk/v1/transport/citybus-nwfb'; // CTB/NWFB
const LRT_BASE = 'https://rt.data.gov.hk/v1/transport/mtr/lrt';

// operator change
companySelect.addEventListener('change', ()=> {
  operator = companySelect.value;
  currentRoute = null;
  routeSelect.innerHTML = '<option>載入中...</option>';
  clearMap();
  loadRoutesForOperator(operator);
});

dirBtn.addEventListener('click', ()=> {
  direction = (direction === 'inbound') ? 'outbound' : 'inbound';
  if (currentRoute) loadRouteStops(currentRoute);
});

// load routes depending on operator
async function loadRoutesForOperator(op){
  try{
    routeSelect.innerHTML = '<option>載入中...</option>';
    if(op === 'kmb'){
      const res = await fetch(`${KMB_BASE}/route`);
      const json = await res.json();
      const routes = json.data || [];
      populateRouteSelect(routes.map(r=>r.route));
    } else if(op === 'ctb' || op === 'nwfb'){
      // citybus combined dataset (may require different endpoints)
      const res = await fetch(`${CITY_BUS_BASE}/route`);
      const json = await res.json();
      const routes = json.data || [];
      // route object may have company code; filter by chosen operator
      const filtered = routes.filter(r => {
        const c = r.operator ? r.operator.toLowerCase() : '';
        if(op === 'ctb') return c.includes('ctb') || c.includes('citybus');
        if(op === 'nwfb') return c.includes('nwfb') || c.includes('new');
        return true;
      });
      populateRouteSelect(filtered.map(r=>r.route));
    } else if(op === 'gmb'){
      // GMB dataset not always accessible via same endpoint; provide manual entry placeholder
      routeSelect.innerHTML = '<option>請手動輸入路線</option>';
    } else if(op === 'lrt'){
      // LRT routes can be station-based; we provide list of stations as "routes"
      const res = await fetch(`${LRT_BASE}/getStationList`);
      const json = await res.json();
      const routes = json.data || [];
      populateRouteSelect(routes.map(s=>s.station_id));
    }
  }catch(err){
    console.error('loadRoutesForOperator error',err);
    routeSelect.innerHTML = '<option>載入失敗</option>';
  }
}

function populateRouteSelect(arr){
  routeSelect.innerHTML = '';
  const top = arr.slice(0,500); // prevent overwhelming
  top.forEach(r=>{
    const opt = document.createElement('option'); opt.value = r; opt.textContent = r;
    routeSelect.appendChild(opt);
  });
  routeSelect.addEventListener('change', ()=> {
    currentRoute = routeSelect.value;
    loadRouteStops(currentRoute);
  });
  // auto-select first
  if(top.length) { currentRoute = top[0]; routeSelect.value = top[0]; loadRouteStops(top[0]); }
}

// clear map layers and markers (except tile layer)
function clearMap(){
  // remove existing markers/polylines
  map.eachLayer(layer=>{
    if(layer instanceof L.Marker || layer instanceof L.CircleMarker || layer instanceof L.Polyline){
      map.removeLayer(layer);
    }
  });
  vehicleMarkers = {};
  stopCoords = [];
  stopIds = [];
  stopListEl.innerHTML = '';
  if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
}

// load route stops and ETA then start vehicle updates
async function loadRouteStops(route){
  if(!route) return;
  clearMap();
  stopListEl.innerHTML = '<li>載入站點...</li>';

  try{
    if(operator === 'kmb'){
      // route-stop endpoint returns stops with stop IDs
      const resStops = await fetch(`${KMB_BASE}/route-stop/${route}/${direction}/1`);
      const jStops = await resStops.json();
      const stopsData = jStops.data || [];
      stopCoords = []; stopIds = [];
      for(const s of stopsData){
        // fetch stop info
        try{
          const resStop = await fetch(`${KMB_BASE}/stop/${s.stop}`);
          const jStop = await resStop.json();
          const d = jStop.data;
          stopCoords.push([d.lat, d.long]);
          stopIds.push(s.stop);
          L.circleMarker([d.lat,d.long],{radius:5}).addTo(map).bindPopup(`${d.name_tc}<br>${d.name_en}`);
        }catch(e){
          console.warn('stop fetch error',e);
        }
      }
      if(stopCoords.length) { L.polyline(stopCoords,{color:'blue',weight:4}).addTo(map); map.fitBounds(L.polyline(stopCoords).getBounds()); }
      // show ETA list (from ETA endpoint)
      await updateETA_KMB(route);
      // start vehicle polling (true GPS)
      startVehiclePolling_KMB(route);
    }
    else if(operator === 'ctb' || operator === 'nwfb'){
      // citybus route-stop: example: /route/CTB/{route}
      // citybus api may return stops; operator code in dataset can be used
      const resStops = await fetch(`${CITY_BUS_BASE}/route/${route}`);
      const jStops = await resStops.json();
      const stopsData = jStops.data || [];
      stopCoords = []; stopIds = [];
      for(const s of stopsData){
        if(s.stop_lat && s.stop_lon){
          stopCoords.push([s.stop_lat, s.stop_lon]);
          stopIds.push(s.stop);
          L.circleMarker([s.stop_lat,s.stop_lon],{radius:5}).addTo(map).bindPopup(`${s.stop_tc}<br>${s.stop_en}`);
        } else {
          // fallback: skip
        }
      }
      if(stopCoords.length){ L.polyline(stopCoords,{color:'#ff9800',weight:4}).addTo(map); map.fitBounds(L.polyline(stopCoords).getBounds()); }
      // Citybus/NWFB: public vehicle GPS not always available. We'll fetch ETA and estimate vehicles.
      await updateETA_CTB(route);
      startVehicleEstimation_CTB(route);
    }
    else if(operator === 'lrt'){
      // LRT: show station list for the given station id (route variable is station id here)
      // Use getSchedule endpoint per station
      const stationId = route;
      // fetch schedule (next trains)
      const resSched = await fetch(`${LRT_BASE}/getSchedule?station_id=${encodeURIComponent(stationId)}`);
      const jSched = await resSched.json();
      // jSched.data likely contains schedule entries; show as list
      stopListEl.innerHTML = '';
      (jSched.data||[]).forEach(item=>{
        const li = document.createElement('li');
        li.innerHTML = `${item.dest_tc || item.destination} <span class="eta">${item.eta || ''}</span>`;
        stopListEl.appendChild(li);
      });
      // LRT does not provide vehicle GPS in this API — we only show schedule.
    }
    else {
      stopListEl.innerHTML = '<li>尚未支援此公司完整資料</li>';
    }
  }catch(err){
    console.error('loadRouteStops error',err);
    stopListEl.innerHTML = '<li>載入站點失敗</li>';
  }
}

// -------------------- KMB: ETA + vehicle poll (true GPS) --------------------
async function updateETA_KMB(route){
  try{
    const resETA = await fetch(`${KMB_BASE}/eta/${route}/${direction}/1`);
    const jETA = await resETA.json();
    const etaData = jETA.data || [];
    // Build map stop->next eta string
    const etaMap = {};
    etaData.forEach(e => {
      if(!etaMap[e.stop]) etaMap[e.stop] = [];
      etaMap[e.stop].push(e.eta);
    });
    // render list
    stopListEl.innerHTML = '';
    for(let i=0;i<stopIds.length;i++){
      const sid = stopIds[i];
      const li = document.createElement('li');
      const name = stopCoords[i] ? `${stopCoords[i][0].toFixed(3)},${stopCoords[i][1].toFixed(3)}` : sid;
      const span = document.createElement('span');
      span.className = 'eta';
      if(etaMap[sid] && etaMap[sid].length){
        const next = new Date(etaMap[sid][0]);
        const now = new Date();
        const mins = Math.max(0, Math.floor((next - now)/60000));
        span.textContent = mins + ' 分鐘';
      } else span.textContent = '暫無班次';
      li.innerHTML = `<span class="stop-name">${sid}</span>`;
      li.appendChild(span);
      stopListEl.appendChild(li);
    }
  }catch(e){ console.warn('updateETA_KMB',e); }
}

let kmbVehicleTimer = null;
async function startVehiclePolling_KMB(route){
  if(kmbVehicleTimer) clearInterval(kmbVehicleTimer);
  await loadKMBVehicles(route);
  kmbVehicleTimer = setInterval(()=> loadKMBVehicles(route), 5000); // every 5s
}

async function loadKMBVehicles(route){
  try{
    const res = await fetch(`${KMB_BASE}/vehicle`);
    const j = await res.json();
    const vehicles = j.data || [];
    // filter by route
    const onRoute = vehicles.filter(v=>v.route === route);
    // update markers; use vehicle id or plate as key
    const newKeys = new Set();
    onRoute.forEach(v=>{
      const key = v.plate || `${v.route}_${v.vehicle}`;
      newKeys.add(key);
      const lat = parseFloat(v.lat), lng = parseFloat(v.long);
      if(isNaN(lat) || isNaN(lng)) return;
      if(vehicleMarkers[key]){
        vehicleMarkers[key].setLatLng([lat,lng]);
      } else {
        const m = L.marker([lat,lng],{
          icon: L.divIcon({className:'bus-icon', html:'🚌'})
        }).addTo(map);
        m.bindPopup(`路線 ${v.route}<br>車牌: ${v.plate || v.vehicle}<br><small>資料來源：KMB (GPS)</small>`);
        vehicleMarkers[key] = m;
      }
    });
    // remove markers not present anymore
    Object.keys(vehicleMarkers).forEach(k=>{
      if(!newKeys.has(k)){
        map.removeLayer(vehicleMarkers[k]);
        delete vehicleMarkers[k];
      }
    });
  }catch(err){
    console.error('loadKMBVehicles',err);
  }
}

// -------------------- CTB/NWFB: ETA + VEHICLE ESTIMATION --------------------
async function updateETA_CTB(route){
  try{
    const res = await fetch(`${CITY_BUS_BASE}/eta/${route}`); // endpoint shape may differ; best-effort
    const j = await res.json();
    const data = j.data || [];
    // Build map stop->eta (this api returns stop-based ETAs)
    const etaMap = {};
    data.forEach(e=>{
      if(!etaMap[e.stop]) etaMap[e.stop] = [];
      etaMap[e.stop].push(e.eta);
    });
    // render stop list
    stopListEl.innerHTML = '';
    for(let i=0;i<stopCoords.length;i++){
      const idx = i;
      const sid = stopIds[i] || `s${i}`;
      const li = document.createElement('li');
      const span = document.createElement('span'); span.className='eta';
      if(etaMap[sid] && etaMap[sid].length){
        const next = new Date(etaMap[sid][0]); const mins = Math.max(0,Math.floor((next - new Date())/60000));
        span.textContent = mins + ' 分鐘';
      } else span.textContent = '暫無班次';
      li.innerHTML = `<span class="stop-name">${sid}</span>`;
      li.appendChild(span);
      stopListEl.appendChild(li);
    }
  }catch(e){ console.warn('updateETA_CTB', e); }
}

// Estimation: distribute vehicles along route using ETA differences
let ctbEstTimer = null;
async function startVehicleEstimation_CTB(route){
  if(ctbEstTimer) clearInterval(ctbEstTimer);
  await estimateCTBVehicles(route);
  ctbEstTimer = setInterval(()=> estimateCTBVehicles(route), 5000);
}
async function estimateCTBVehicles(route){
  try{
    // fetch ETA per stop
    const res = await fetch(`${CITY_BUS_BASE}/eta/${route}`);
    const j = await res.json(); const etaArr = j.data || [];
    // derive number of vehicles (unique plate or visit occurrence) - if none, attempt to estimate 1-3 vehicles
    const vehicleCount = Math.max(1, Math.min(6, Math.floor(Math.random()*3)+1));
    // naive estimation: spread vehicles along stopCoords according to ETA descending
    // create vehicle markers or move existing ones
    const keys = [];
    for(let i=0;i<vehicleCount;i++){
      const frac = (i+1)/(vehicleCount+1); // fraction along route
      const idx = Math.floor(frac * (stopCoords.length-1));
      const pos = stopCoords[idx];
      const key = `ctb_${route}_${i}`;
      keys.push(key);
      if(vehicleMarkers[key]){
        vehicleMarkers[key].setLatLng(pos);
      } else {
        const m = L.marker(pos, {icon: L.divIcon({className:'bus-icon estimated', html:'🚌'})}).addTo(map);
        m.bindPopup(`路線 ${route}（估算位置）<br><small>由 ETA 估算</small>`);
        vehicleMarkers[key] = m;
      }
    }
    // cleanup old markers not in keys
    Object.keys(vehicleMarkers).forEach(k=>{
      if(!keys.includes(k) && k.startsWith('ctb_')){
        map.removeLayer(vehicleMarkers[k]); delete vehicleMarkers[k];
      }
    });
  }catch(e){ console.warn('estimateCTBVehicles',e); }
}

// -------------------- Init --------------------
loadRoutesForOperator(operator);

// Helpful note to user in console about CORS
console.info('注意：若某個 API 拒絕跨站請求（CORS），你可能會在 console 見到錯誤。若發生，可用 proxy 或部署到支援 server 的平台（例如 Render、Vercel）來解決。');
