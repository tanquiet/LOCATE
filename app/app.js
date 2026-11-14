/* Locate web app - plain JS, no build step.
   Talks to the broker with MQTT.js over WebSockets, draws the map with Leaflet
   and the comparison chart with Chart.js. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function ago(ts) {
    if (!ts) return 'Never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'Just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return new Date(ts).toLocaleString();
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const linkLabel = (l) => (l === 'gsm' ? 'Mobile network (2G)' : l === 'wifi' ? 'Wi-Fi' : l === 'phone' ? 'Phone tracker' : l === 'app' ? 'This app' : '-');

  // ------------------------------------------------------------------ state
  const DEFAULTS = {
    // Free HiveMQ public broker over secure WebSockets: works from http://localhost,
    // from phones on the LAN and from a hosted https:// site. For your own Mosquitto
    // use the laptop IP, port 9001 and the locate user instead.
    broker: 'wss://broker.hivemq.com',
    port: 8884,
    username: '',
    password: '',
    prefix: 'locate-k7q2m9',             // must match TOPIC_PREFIX in config.h
    vehicleId: 'car1',
    demo: false,
    theme: 'dark',
    keepAwake: false,
    notify: true          // pop-up alerts, once the browser has been allowed to show them
  };
  let settings = Object.assign({}, DEFAULTS, store.get('locate.settings', {}));
  // Opening the page as  http://.../?demo=1  switches Demo mode on (handy for a backup phone)
  const urlDemo = /[?&]demo=1\b/.test(location.search);
  if (urlDemo) settings.demo = true;

  // Everything below belongs to the signed-in PERSON and is stored under their
  // username, so two accounts used in one browser (two tabs, or one after the
  // other) never see or overwrite each other's alerts, vehicle or map.
  // It is loaded in loadUserData() when someone signs in.
  const freshState = () => ({ counts: { A: 0, B: 0 }, stolen: false, buzzer: false, veh: null, deviceTx: null });
  let alerts = [];
  let state = freshState();

  let veh = state.veh;            // {mode, lat, lon, speed, link, lastSeen, fix}
  let stamps = { A: [], B: [] };  // arrival times, for "per minute"
  let pendingMode = null;         // mode asked for from the app, not confirmed yet
  let trailPts = [];
  let alertFilter = 'all';
  let client = null;
  let connState = 'connecting';
  let activeTab = 'map';

  const ukey = (k) => k + '.' + session.user;          // per-person storage key
  const saveState = () => { state.veh = veh; if (session) store.set(ukey('locate.state'), state); };
  const saveAlerts = () => { if (session) store.set(ukey('locate.alerts'), alerts.slice(0, 200)); };
  // Connection settings are shared by everyone on this device; the vehicle on
  // screen and Demo mode are each person's own.
  function saveSettings() {
    store.set('locate.settings', settings);
    if (session) store.set(ukey('locate.prefs'), { vehicleId: settings.vehicleId, demo: !!settings.demo });
  }
  function loadUserData() {
    const prefs = store.get(ukey('locate.prefs'), null);
    settings.vehicleId = prefs && prefs.vehicleId ? prefs.vehicleId : 'car1';
    settings.demo = urlDemo || !!(prefs && prefs.demo);
    alerts = store.get(ukey('locate.alerts'), []);
    state = Object.assign(freshState(), store.get(ukey('locate.state'), {}));
    veh = state.veh;
    profile = Object.assign({ reg: '', desc: '', phone: '', email: '' }, store.get(ukey('locate.profile'), {}));
  }
  const topic = (leaf) => settings.prefix + '/' + settings.vehicleId + '/' + leaf;

  // ------------------------------------------------------------------ sound + vibration
  let audio = null;
  function unlockAudio() {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  function tone(freq, startIn, dur, vol) {
    if (!audio) return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime + startIn;
    o.start(t); o.stop(t + dur);
  }
  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }
  function remoteBeep() {
    if (audio && audio.state === 'suspended') audio.resume();
    if (audio) {
      tone(1500, 0, 0.15, 0.2); tone(1500, 0.22, 0.15, 0.2);
      toast('🔔 Beep from the phone');
    } else {
      toast('🔔 Beep from the phone - click this page once to allow sound');
    }
  }

  function alarmSound() {
    for (let i = 0; i < 3; i++) { tone(880, i * 0.4, 0.18, 0.15); tone(660, i * 0.4 + 0.2, 0.18, 0.15); }
  }

  // ------------------------------------------------------------------ connection
  function setConn(s, detail) {
    connState = s;
    const labels = {
      online: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      offline: 'Not connected',
      demo: 'Demo mode'
    };
    $('conn').dataset.state = s;
    $('connText').textContent = labels[s] + (detail ? ' - ' + detail : '');
    $('conn').title = detail || '';
  }

  function buildUrl(s) {
    let raw = String(s.broker || '').trim();
    if (!raw) return null;
    if (!/^wss?:\/\//i.test(raw)) raw = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + raw;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (!u.port && s.port) u.port = String(s.port);
    if (!u.pathname || u.pathname === '/') u.pathname = '/mqtt';
    return u.toString();
  }

  function friendlyError(err) {
    const m = String((err && err.message) || err || '');
    if (/not authori[sz]ed|bad user ?name|password/i.test(m)) return 'wrong username or password';
    if (/timeout/i.test(m)) return 'no answer from the server';
    return m ? m.slice(0, 60) : 'cannot reach the server';
  }

  function mqttOptions(s) {
    return {
      username: s.username || undefined,
      password: s.password || undefined,
      clientId: 'locate-app-' + Math.random().toString(16).slice(2, 10),
      keepalive: 30,
      connectTimeout: 8000,
      clean: true
    };
  }

  function disconnect() {
    sim.stop();
    if (client) {
      const old = client;
      client = null;
      try { old.end(true); } catch (e) { /* ignore */ }
    }
  }

  function connect() {
    disconnect();
    if (settings.demo) { setConn('demo'); sim.start(); return; }
    if (typeof mqtt === 'undefined') { setConn('offline', 'app files did not load, check internet'); return; }
    const url = buildUrl(settings);
    if (!url) { setConn('offline', 'check the address in Settings'); return; }

    setConn('connecting');
    const c = mqtt.connect(url, Object.assign(mqttOptions(settings), { reconnectPeriod: 2000 }));
    client = c;
    c.on('connect', () => {
      if (client !== c) return;
      setConn('online');
      // The vehicle on screen: everything. Every vehicle: its status and alerts
      // (so an alert on another vehicle still reaches you). Plus the vehicle list.
      const p = settings.prefix + '/';
      c.subscribe([topic('ping'), topic('beep'), topic('telemetry'), p + '+/status', p + '+/alert', p + 'registry/+']);
      flushRegistry();
    });
    c.on('reconnect', () => { if (client === c) setConn('reconnecting'); });
    c.on('close', () => { if (client === c && connState === 'online') setConn('reconnecting'); });
    c.on('error', (err) => { if (client === c) setConn('reconnecting', friendlyError(err)); });
    c.on('message', (t, payload, packet) => { if (client === c) route(t, payload.toString(), !!(packet && packet.retain)); });
  }

  // <prefix>/<vehicle id>/<leaf>   or   <prefix>/registry/<vehicle id>
  function route(t, text, retained) {
    const p = settings.prefix + '/';
    if (t.indexOf(p) !== 0) return;
    const rest = t.slice(p.length).split('/');
    if (rest.length !== 2) return;
    if (rest[0] === 'registry') { onRegistry(rest[1], text); return; }
    backgroundMessage(rest[0], rest[1], text, retained);
    if (rest[0] === settings.vehicleId) handleMessage(t, text, retained);
  }

  // Sends a command to the vehicle. Resolves once the server has it.
  function sendCommand(obj) {
    return new Promise((resolve, reject) => {
      if (settings.demo) { sim.onConfig(obj); resolve(); return; }
      if (isNode()) { reject(new Error('this tracker does not take commands from the app')); return; }
      if (!client || !client.connected) { reject(new Error('not connected')); return; }
      const timer = setTimeout(() => reject(new Error('no answer from the server')), 6000);
      client.publish(topic('config'), JSON.stringify(obj), { qos: 1 }, (err) => {
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      });
    });
  }

  function feedback(id, kind, text) {
    const el = $(id);
    el.dataset.kind = kind;
    el.textContent = (kind === 'ok' ? '✓ ' : kind === 'fail' ? '✕ ' : '') + text;
  }
  const deliveredText = () =>
    settings.demo ? 'Delivered (simulated vehicle).'
      : (veh && veh.mode === 'B')
        ? 'Delivered to the server. The vehicle is silent in Locate mode, so it picks this up at its next stop.'
        : 'Delivered.';

  // ------------------------------------------------------------------ incoming messages
  const recentFixes = [];   // last real GPS positions {lat, lon, ts}
  // Guard mode (phone tracker): 'off' | 'arming' | 'armed' | 'stolen'
  let guard = { state: 'off', anchor: null, dist: 0 };

  function handleMessage(t, text, retained) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const leaf = t.slice(t.lastIndexOf('/') + 1);
    const now = Date.now();
    const mode = m.mode === 'A' || m.mode === 'B' || m.mode === 'G' ? m.mode : null;
    const prevMode = veh && veh.mode;

    if (leaf === 'beep') { remoteBeep(); return; }   // "Beep laptop" button on the phone tracker

    // LOCATE node firmware (firmware/locate_node): its own message format
    if (leaf === 'telemetry' || (leaf === 'alert' && typeof m.alert === 'string')) { handleNode(leaf, m, now); return; }

    if (leaf === 'status') {
      if (!mode) return;
      if (retained && isNode()) return;   // an old stored note from the phone tracker must not relabel the node
      // An old stored "armed" note must not cancel a theft that is in progress
      if (retained && guard.state === 'stolen') return;
      veh = Object.assign({}, veh, { mode: mode });
      // Phone tracker Mode B (Locate) arms like this: "arming", then "armed" with the parked spot
      if (mode === 'G' || (mode === 'B' && (m.type === 'armed' || m.type === 'arming'))) {
        if (m.type === 'armed') {
          const la = num(m.lat), lo = num(m.lon);
          guard = { state: 'armed', anchor: la !== null && lo !== null ? [la, lo] : null, dist: 0 };
          stopAlarm();
          if (bannerAlert && bannerAlert.type === 'theft_move') $('alertBanner').hidden = true;
          trailPts = []; routeMetres = 0;
          if (trail) trail.setLatLngs([]);
          if (guard.anchor && veh.lat == null) { veh.lat = guard.anchor[0]; veh.lon = guard.anchor[1]; }
          veh.speed = 0; veh.moving = false;   // armed = parked
        } else if (guard.state === 'off') {
          guard.state = 'arming';
        }
      } else if (guard.state !== 'off') {
        guard = { state: 'off', anchor: null, dist: 0 };
        stopAlarm();
      }
      mapGuard();
      if (pendingMode === mode) {
        pendingMode = null;
        const done = 'The tracker is now in ' + (mode === 'A' ? 'Always-on' : mode === 'B' ? 'Locate' : 'the new') + ' mode.';
        ['modeFeedback', 'guardFeedback', 'armFeedback'].forEach((id) => feedback(id, 'ok', done));
      }
      if (num(m.tx_count) !== null) state.deviceTx = m.tx_count;
      // Retained copies arrive on every page load; only a live change is a transmission.
      if (prevMode && prevMode !== mode) flashDetector();
      saveState(); renderAll();
      return;
    }
    if (leaf !== 'ping' && leaf !== 'alert') return;

    const lat = num(m.lat), lon = num(m.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const isAlert = leaf === 'alert';
    // Alarm-style messages: Guard, and the phone tracker's Mode B (silent while parked,
    // alarm the moment it moves, then live tracking until it stops again)
    const isGuard = mode === 'G' || (mode === 'B' && (m.type === 'theft_move' || m.type === 'track' ||
      (m.type === 'theft_stop' && (guard.state === 'stolen' || guard.state === 'moving'))));
    const series = isAlert ? 'B' : 'A';

    veh = {
      mode: mode || series, lat: lat, lon: lon,
      speed: num(m.speed_kmh) || 0,
      link: m.link === 'gsm' || m.link === 'wifi' || m.link === 'phone' ? m.link : null,
      lastSeen: now, fix: m.gps_fix !== false,
      acc: num(m.acc_m),         // GPS accuracy in metres (phone tracker sends it)
      heading: num(m.heading),   // degrees, only while really moving
      moving: m.moving === true
    };
    if (pendingMode === veh.mode) pendingMode = null;
    if (num(m.tx_count) !== null) state.deviceTx = m.tx_count;
    if (veh.fix) {                                  // kept for the police report
      recentFixes.push({ lat: lat, lon: lon, ts: now });
      if (recentFixes.length > 40) recentFixes.shift();
    }

    // A-vs-B comparison: every transmission counts for the mode that sent it
    const cnt = mode === 'A' || (!mode && !isAlert) ? 'A' : 'B';
    state.counts[cnt]++;
    stamps[cnt].push(now);
    bump(cnt);
    flashDetector();

    const newAlert = (type, extra) => {
      const a = Object.assign({
        id: now + '-' + Math.random().toString(16).slice(2, 6),
        ts: now, type: type, lat: lat, lon: lon,
        speed: veh.speed, link: veh.link, fix: veh.fix, resolved: false,
        vid: settings.vehicleId, vname: activeVehicle().name
      }, extra);
      alerts.unshift(a);
      saveAlerts();
      return a;
    };

    if (isGuard && pendingMode && pendingMode !== mode) {
      // Just switched mode: a last alarm message still in flight must not restart the alarm
      mapUpdateVehicle();
    } else if (isGuard) {
      if (num(m.dist_m) !== null) guard.dist = m.dist_m;
      else if (guard.anchor) guard.dist = distM(guard.anchor, [lat, lon]);
      // Safe zone: it may move around near the owner; the THEFT ALERT starts only once it
      // is farther than zoneM from the owner's phone (or from where it was parked).
      if (guard.state !== 'stolen' && guard.state !== 'moving' && !(isAlert && m.type === 'theft_stop')) {
        guard.state = 'moving';
        trailPts = guard.anchor ? [guard.anchor] : [];
        routeMetres = 0;
        mapGuard();
        if (zoneCentre()) {
          toast('⚠ The tracker started moving. Theft alert if it goes more than ' + zoneM() + ' m away.');
          tone(1200, 0, 0.12, 0.12); tone(1200, 0.2, 0.12, 0.12);
          if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) { /* ignore */ } }
        }
      }
      mapUpdateVehicle();
      const d = zoneDist(lat, lon);
      if (guard.state === 'moving' && (d === null || (d > zoneM() && !(veh.acc > zoneM())))) {
        // Left the safe zone (or there is no zone to measure from): THEFT ALERT
        guard.state = 'stolen';
        const recent = alerts.find((a) => a.type === 'theft_move' && !a.resolved && now - a.ts < 30 * 60000);
        const a = recent || newAlert('theft_move', { zoneM: zoneM(), awayM: d === null ? null : Math.round(d) });
        mapGuard();
        raiseAlert(a);
        startAlarm();
      }
      if (isAlert && m.type === 'theft_stop') {
        if (guard.state === 'stolen') {
          const a = newAlert('theft_stop');
          addPin(a);
          toast('📍 It stopped here. Location saved in Alerts. Silent again until it moves.');
        } else {
          guard.state = 'armed';
          mapGuard();
          toast('✓ It stopped inside your zone. Armed and silent again.');
        }
      }
      bannerLive();
    } else {
      // Locate alert: it may carry the route the tracker recorded while it was silent
      const tr = isAlert ? parseTrail(m.trail) : null;
      const trM = tr ? lineMetres(tr.map((p) => [p[0], p[1]]).concat([[lat, lon]])) : 0;
      if (tr && trM >= 5) {
        // The live (solid) route ends where the tracker went silent; the recorded
        // route is drawn dashed from there to the stop. Live pings start a new route.
        mapUpdateVehicle(true);
        freezeTrail();
        routeMetres += trM;
        raiseAlert(newAlert('theft_stop', { trail: tr, trailM: Math.round(trM) }));
      } else {
        mapUpdateVehicle();
        if (isAlert) raiseAlert(newAlert('theft_stop'));
      }
    }
    saveState();
    renderAll();
  }

  // ------------------------------------------------------------------ silent route (breadcrumb trail)
  // While Locate is silent the tracker keeps recording GPS points (receiving GPS
  // transmits nothing). The whole route arrives inside the ONE stop alert as
  // "trail": [[lat, lon, seconds before the alert], ...], oldest first.
  const TRAIL_MAX = 120;
  function parseTrail(raw) {
    if (!Array.isArray(raw)) return null;
    const pts = [];
    raw.slice(0, TRAIL_MAX).forEach((p) => {
      if (!Array.isArray(p)) return;
      const la = num(p[0]), lo = num(p[1]);
      if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) return;
      pts.push([+la.toFixed(6), +lo.toFixed(6), Math.max(0, Math.round(num(p[2]) || 0))]);
    });
    return pts.length ? pts : null;
  }
  function lineMetres(line) {
    let d = 0;
    for (let i = 1; i < line.length; i++) d += distM(line[i - 1], line[i]);
    return d;
  }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  const fmtDur = (s) => (s >= 90 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s');
  // Recorded points plus the stop itself
  const trailLine = (a) => a.trail.map((p) => [p[0], p[1]]).concat([[a.lat, a.lon]]);
  const trailText = (a) => (a.type === 'blackout' ? 'route logged on the tracker during the blackout: ' : 'route recorded in silence: ') + fmtDist(a.trailM) + ', ' + a.trail.length + ' points over ' + fmtDur(a.trail[0][2]);

  let silentLine = null, silentStart = null, silentRun = 0;
  // Draws an alert's recorded route as a dashed line. animate = draw it point by
  // point, so the audience sees the route "arrive" with the alert.
  function showSilentRoute(a, animate, delay) {
    if (!map || !silentLine) return;
    const run = ++silentRun;
    if (silentStart) { map.removeLayer(silentStart); silentStart = null; }
    silentLine.setLatLngs([]);
    if (!a || !a.trail) return;
    const line = trailLine(a);
    silentStart = L.marker(line[0], {
      icon: L.divIcon({ className: '', html: '<div class="silent-marker">S</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: 'Went silent here', zIndexOffset: 90
    }).bindPopup('<strong>Went silent here</strong><br>' + clock(a.ts - a.trail[0][2] * 1000) +
      '<br>From this point nothing was transmitted. The dashed route was recorded on the tracker and delivered in one message when it stopped.').addTo(map);
    if (!animate) { silentLine.setLatLngs(line); return; }
    const stepMs = Math.max(25, Math.min(140, 2500 / line.length));
    let i = 0;
    const step = () => {
      if (run !== silentRun) return;
      silentLine.addLatLng(line[i++]);
      if (i < line.length) setTimeout(step, stepMs);
    };
    setTimeout(step, delay || 0);
  }

  // ------------------------------------------------------------------ vehicles
  // Every vehicle has its own random channel: <prefix>/v-<code>/...  The list of
  // vehicles is kept on the broker as retained messages on <prefix>/registry/<id>,
  // so it syncs between phones and the control room sees every vehicle.
  // (No server: anyone who knows the prefix can read that list. A launched
  // product keeps vehicles on a private server with per-owner access control.)
  const VTYPE = {
    car: { icon: '🚗', label: 'Car' }, motorbike: { icon: '🏍️', label: 'Motorbike' },
    scooter: { icon: '🛵', label: 'Scooter' }, bicycle: { icon: '🚲', label: 'Bicycle' },
    truck: { icon: '🚚', label: 'Truck / van' }, other: { icon: '📦', label: 'Other' }
  };
  const DEMO_VEH = { id: 'car1', code: 'CAR1', name: 'Demo car', type: 'car', reg: '', owner: '*', ownerName: 'Shared demo vehicle', demo: true };
  // Ready-made vehicles for the demo accounts, so a demo is click-through: sign in,
  // and on the tracker phone tap "Quick pair". (Same list in tracker.js.)
  const DEMO_FLEET = [
    DEMO_VEH,
    { id: 'v-family', code: 'FAMILY', name: 'Family Car', type: 'car', reg: 'KA 05 MN 4321', owner: 'customer', ownerName: 'Demo Customer' },
    { id: 'v-priya1', code: 'PRIYA1', name: 'Priya\'s Activa', type: 'scooter', reg: 'KA 01 HX 2231', owner: 'priya', ownerName: 'Priya Sharma' },
    { id: 'v-arjun1', code: 'ARJUN1', name: 'Arjun\'s Bullet', type: 'motorbike', reg: 'KA 03 JR 7788', owner: 'arjun', ownerName: 'Arjun Rao' },
    { id: 'v-arjun2', code: 'ARJUN2', name: 'Arjun\'s Swift', type: 'car', reg: 'KA 03 MC 1029', owner: 'arjun', ownerName: 'Arjun Rao' },
    { id: 'v-meera1', code: 'MEERA1', name: 'Meera\'s Cycle', type: 'bicycle', reg: '', owner: 'meera', ownerName: 'Meera Nair' }
  ].map((v, i) => Object.assign({ demo: true, created: i }, v));
  const isDemoVeh = (id) => DEMO_FLEET.some((v) => v.id === id);
  let registry = store.get('locate.registry', {});            // id -> {id, code, name, type, reg, owner, ownerName, created}
  let pendingReg = store.get('locate.pendingReg', {});        // id -> record to publish, or null = remove
  const vstat = {};                                           // id -> {mode, seen, alertTs, alertType}
  const saveRegistry = () => { store.set('locate.registry', registry); store.set('locate.pendingReg', pendingReg); };

  function allVehicles() {
    const all = Object.assign({}, registry);
    DEMO_FLEET.forEach((v) => { all[v.id] = v; });            // built in; the broker cannot change them
    return all;
  }
  function myVehicles() {
    const list = Object.values(allVehicles());
    const mine = !session || session.role === 'admin' ? list : list.filter((v) => v.owner === '*' || v.owner === session.user);
    // Own vehicles first (newest last), then the shared demo car
    return mine.sort((a, b) => (a.owner === '*') - (b.owner === '*') || (!!a.demo - !!b.demo) || (a.created || 0) - (b.created || 0));
  }
  function activeVehicle() {
    return allVehicles()[settings.vehicleId] || { id: settings.vehicleId, code: settings.vehicleId, name: settings.vehicleId, type: 'other', owner: '?' };
  }
  const vIcon = (v) => (VTYPE[v.type] || VTYPE.other).icon;
  const vCode = (v) => v.code || (v.id.indexOf('v-') === 0 ? v.id.slice(2).toUpperCase() : v.id.toUpperCase());

  function onRegistry(id, text) {
    if (!/^[a-z0-9-]{3,24}$/.test(id) || isDemoVeh(id)) return;
    let rec = null;
    if (text) { try { rec = JSON.parse(text); } catch (e) { return; } }
    if (rec && (typeof rec !== 'object' || rec.id !== id || typeof rec.name !== 'string')) return;
    if (pendingReg[id] !== undefined) return;                 // our own change is still on its way
    if (rec) registry[id] = {
      id: id, code: String(rec.code || '').slice(0, 12), name: rec.name.slice(0, 30), type: VTYPE[rec.type] ? rec.type : 'other',
      reg: String(rec.reg || '').slice(0, 15), owner: String(rec.owner || ''), ownerName: String(rec.ownerName || '').slice(0, 40),
      created: num(rec.created) || 0
    };
    else delete registry[id];
    saveRegistry();
    renderVehicles();
  }
  function publishRegistry(id, rec) {
    pendingReg[id] = rec;
    saveRegistry();
    flushRegistry();
  }
  function flushRegistry() {
    if (!client || !client.connected) return;
    Object.keys(pendingReg).forEach((id) => {
      const rec = pendingReg[id];
      client.publish(settings.prefix + '/registry/' + id, rec ? JSON.stringify(rec) : '', { qos: 1, retain: true }, (err) => {
        if (!err && pendingReg[id] === rec) { delete pendingReg[id]; saveRegistry(); }
      });
    });
  }

  function newCode() {
    const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const r = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(r);
    let c = '';
    for (let i = 0; i < 6; i++) c += ABC[r[i] % ABC.length];
    return allVehicles()['v-' + c.toLowerCase()] ? newCode() : c;
  }

  function addVehicle(name, type, reg) {
    const code = newCode();
    const v = {
      id: 'v-' + code.toLowerCase(), code: code, name: name.trim().slice(0, 30), type: VTYPE[type] ? type : 'other',
      reg: reg.trim().toUpperCase().slice(0, 15), owner: session.user, ownerName: session.name || session.user, created: Date.now()
    };
    registry[v.id] = v;
    publishRegistry(v.id, v);
    return v;
  }

  function removeVehicle(v) {
    if (v.demo) return;
    if (!confirm('Remove "' + v.name + '"? Its tracker will need to be paired again.')) return;
    delete registry[v.id];
    publishRegistry(v.id, null);
    if (settings.vehicleId === v.id) switchVehicle('car1');
    renderVehicles();
    toast('Removed ' + v.name);
  }

  // Clears what is drawn and remembered for the vehicle / person that was on
  // screen (used when switching vehicle and when someone signs in).
  function resetView() {
    stopAlarm();
    $('alertBanner').hidden = true;
    bannerAlert = null;
    pendingMode = null; trailPts = []; routeMetres = 0; recentFixes.length = 0;
    stamps = { A: [], B: [] };
    guard = { state: 'off', anchor: null, dist: 0 };
    node.live = false;
    if (trail) trail.setLatLngs([]);
    if (carMarker && map) { map.removeLayer(carMarker); carMarker = null; }
    showSilentRoute(null); clearFrozen();
    if (pinLayer) { pinLayer.clearLayers(); Object.keys(pins).forEach((k) => delete pins[k]); alerts.forEach(addPin); }
    mapGuard();
  }

  function switchVehicle(id) {
    if (id === settings.vehicleId) return;
    settings.vehicleId = id;
    saveSettings();
    veh = null;
    state.nodeArmed = false;
    resetView();
    saveState();
    fillSettingsForm();
    connect();
    renderAll();
  }

  // Makes sure the vehicle on screen is one this person may see
  // On sign-in a customer starts on their own vehicle rather than the shared demo car.
  function ensureVehicle(signingIn) {
    const mine = myVehicles();
    const own = mine.find((v) => session && v.owner === session.user);
    if (signingIn && session.role === 'customer' && own && settings.vehicleId === 'car1') { switchVehicle(own.id); return; }
    if (!mine.some((v) => v.id === settings.vehicleId)) switchVehicle(mine.length ? mine[0].id : 'car1');
  }

  // Status and alerts of every vehicle (also the ones not on screen)
  function backgroundMessage(vid, leaf, text, retained) {
    const v = allVehicles()[vid];
    if (!v || !myVehicles().some((x) => x.id === vid)) return;
    if (leaf !== 'status' && leaf !== 'alert') return;
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const st = vstat[vid] || (vstat[vid] = {});
    const ts = num(m.ts) && m.ts < Date.now() + 60000 ? m.ts : (retained ? null : Date.now());
    if (ts) st.seen = Math.max(st.seen || 0, ts);
    if (leaf === 'status' && (m.mode === 'A' || m.mode === 'B' || m.mode === 'G')) { st.mode = m.mode; st.type = m.type; }
    if (leaf === 'alert' && !retained) {
      st.alertTs = Date.now(); st.alertType = m.type || m.alert;
      if (vid !== settings.vehicleId) notifyOther(v, m);
    }
    renderVehicles();
  }

  // An alert from a vehicle that is not on screen
  function notifyOther(v, m) {
    const lat = num(m.lat), lon = num(m.lon);
    const type = m.alert === 'MAIN_POWER_CUT' ? 'tamper_power' : m.type === 'theft_move' ? 'theft_move' : 'theft_stop';
    if (m.type === 'track') return;
    const a = {
      id: Date.now() + '-' + Math.random().toString(16).slice(2, 6), ts: Date.now(), type: type,
      lat: lat, lon: lon, speed: num(m.speed_kmh) || 0, link: m.link || null, fix: m.gps_fix !== false,
      resolved: false, vid: v.id, vname: v.name
    };
    if (a.lat === null || a.lon === null) return;
    alerts.unshift(a);
    saveAlerts();
    toast('⚠ ' + v.name + ': ' + (TYPES[type] || TYPES.theft_stop).label + '. Open Alerts to see it.');
    tone(880, 0, 0.15, 0.15); tone(660, 0.2, 0.15, 0.15);
    if (navigator.vibrate) { try { navigator.vibrate([300, 150, 300]); } catch (e) { /* ignore */ } }
    popupAlert(a);
    renderAlerts();
  }

  function vehStatus(v) {
    const st = vstat[v.id] || {};
    const active = v.id === settings.vehicleId;
    const open = alerts.find((a) => a.vid === v.id && !a.resolved && isIncident(a));
    if (active && guard.state === 'stolen') return { cls: 'alert', text: '🚨 Theft alert - tracking live' };
    if (open) return { cls: 'alert', text: '⚠ ' + (TYPES[open.type] || TYPES.theft_stop).label + ' · ' + ago(open.ts) };
    const mode = active && veh ? veh.mode : st.mode;
    const seen = active && veh && veh.lastSeen ? veh.lastSeen : st.seen;
    if (!mode) return { cls: 'idle', text: 'Waiting for its tracker - pair one below' };
    const label = mode === 'A' ? '📡 Always-on' : mode === 'B' ? '🔒 Locate · armed' : mode === 'N' ? '📡 ESP32 tracker' : mode === 'G' ? '🔒 Guard' : mode;
    return { cls: mode === 'A' ? 'on' : 'ok', text: label + (seen ? ' · last report ' + ago(seen).toLowerCase() : '') };
  }

  function renderVehChip() {
    const v = activeVehicle();
    $('vehChipIcon').textContent = vIcon(v);
    $('vehChipName').textContent = v.name;
    const n = myVehicles().length;
    $('vehChipSub').textContent = (session && session.role === 'admin' && v.owner !== '*' ? v.ownerName + ' · ' : '') +
      (n > 1 ? 'Tap to switch (' + n + ' vehicles)' : 'Tap to add your own vehicle');
  }

  function renderVehicles() {
    if (!session) return;
    renderVehChip();
    const admin = session.role === 'admin';
    $('vehTitle').textContent = admin ? 'All vehicles' : 'My vehicles';
    $('vehIntro').textContent = admin
      ? 'Every vehicle from every owner. Tap one to watch it on the map.'
      : 'Each vehicle has its own tracker and its own private channel. Tap a vehicle to watch it.';
    const list = $('vehList');
    list.textContent = '';
    const mine = myVehicles();
    $('vehEmpty').hidden = mine.some((v) => v.owner !== '*');
    mine.forEach((v) => {
      const li = el('li', 'veh-item' + (v.id === settings.vehicleId ? ' active' : ''));
      const main = el('button', 'veh-main');
      main.type = 'button';
      main.appendChild(el('span', 'veh-icon', vIcon(v)));
      const body = el('div', 'veh-body');
      const title = el('div', 'veh-name', v.name);
      if (v.id === settings.vehicleId) title.appendChild(el('span', 'veh-tag', 'On screen'));
      body.appendChild(title);
      const meta = [(VTYPE[v.type] || VTYPE.other).label];
      if (v.reg) meta.push(v.reg);
      if (admin && v.owner !== '*') meta.push('Owner: ' + (v.ownerName || v.owner));
      if (v.owner === '*') meta.push('Shared demo');
      else if (v.demo) meta.push('Demo vehicle · quick pair: ' + v.code);
      body.appendChild(el('div', 'veh-meta', meta.join(' · ')));
      const st = vehStatus(v);
      body.appendChild(el('div', 'veh-status ' + st.cls, st.text));
      main.appendChild(body);
      main.setAttribute('aria-label', 'Watch ' + v.name + ' on the map');
      main.addEventListener('click', () => { switchVehicle(v.id); showTab('map'); });
      li.appendChild(main);
      const actions = el('div', 'veh-actions');
      const pair = el('button', 'btn', '🔗 Pair tracker');
      pair.type = 'button';
      pair.addEventListener('click', () => showPair(v));
      actions.appendChild(pair);
      if (!v.demo && (admin || v.owner === session.user)) {
        const rm = el('button', 'btn', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => removeVehicle(v));
        actions.appendChild(rm);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  // The QR library is only fetched when a pairing card is opened, so it never slows down the app's start
  let qrLoading = null;
  function loadQr() {
    if (typeof QRCode !== 'undefined') return Promise.resolve();
    if (!qrLoading) qrLoading = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      sc.onload = resolve;
      sc.onerror = () => { qrLoading = null; reject(new Error('QR library did not load')); };
      document.head.appendChild(sc);
    });
    return qrLoading;
  }

  let pairVeh = null;
  function showPair(v) {
    pairVeh = v;
    const code = vCode(v);
    const link = new URL('tracker.html?pair=' + encodeURIComponent(code), location.href).href;
    $('pairTitle').textContent = 'Pair a tracker to ' + v.name;
    $('pairCode').textContent = code;
    $('pairLink').textContent = link;
    $('pairLink').href = link;
    $('pairTopic').textContent = settings.prefix + '/' + v.id;
    $('pairFeedback').textContent = '';
    const box = $('pairQr');
    box.textContent = 'Loading QR code…';
    loadQr().then(() => {
      if (pairVeh !== v) return;
      box.textContent = '';
      try { new QRCode(box, { text: link, width: 168, height: 168, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); }
      catch (e) { box.textContent = 'QR code unavailable - use the code or link'; }
    }).catch(() => { if (pairVeh === v) box.textContent = 'QR code needs internet - use the code or link'; });
    $('pairShare').hidden = !navigator.share;
    $('pairCard').hidden = false;
    $('pairCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function initVehicles() {
    let vtype = 'car';
    document.querySelectorAll('[data-vtype]').forEach((b) => b.addEventListener('click', () => {
      vtype = b.dataset.vtype;
      document.querySelectorAll('[data-vtype]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    $('vehForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('vehName').value.trim();
      if (name.length < 2) { feedback('vehFeedback', 'fail', 'Give the vehicle a name, e.g. "My Activa".'); $('vehName').focus(); return; }
      if (myVehicles().filter((v) => v.owner === session.user).length >= 20) { feedback('vehFeedback', 'fail', 'You can add up to 20 vehicles.'); return; }
      const v = addVehicle(name, vtype, $('vehReg').value);
      $('vehName').value = ''; $('vehReg').value = '';
      feedback('vehFeedback', 'ok', v.name + ' added. Now pair a tracker to it.');
      switchVehicle(v.id);
      renderVehicles();
      showPair(v);
    });
    $('pairClose').addEventListener('click', () => { $('pairCard').hidden = true; pairVeh = null; });
    $('pairCopy').addEventListener('click', async () => {
      const link = $('pairLink').href;
      try { await navigator.clipboard.writeText(link); feedback('pairFeedback', 'ok', 'Link copied. Send it to the tracker phone.'); }
      catch (e) { feedback('pairFeedback', 'wait', 'Copy this link: ' + link); }
    });
    $('pairShare').addEventListener('click', () => {
      if (!navigator.share || !pairVeh) return;
      navigator.share({ title: 'Pair a Locate tracker', text: 'Open this on the phone that goes in ' + pairVeh.name + ' (code ' + vCode(pairVeh) + '):', url: $('pairLink').href }).catch(() => {});
    });
    $('vehChip').addEventListener('click', () => showTab('vehicles'));
  }

  // ------------------------------------------------------------------ LOCATE node (firmware/locate_node)
  // Messages:  <prefix>/<vehicle>/telemetry  {id,seq,t,state,lat,lon,spd,src,vib,pwr}  once a second while moving
  //            <prefix>/<vehicle>/alert      {id,alert:"MAIN_POWER_CUT",priority,t,lat,lon}
  // The node's radio is OFF while parked, so silence means parked - or a network
  // blackout (jammer): then it logs the route to flash and uploads it in a burst
  // when the link returns. Those late points, and late alerts, arrive on the
  // telemetry topic. The node takes no commands, so Arm / Disarm lives in this app.
  const NODE_SILENT_MS = 5000;     // no telemetry for this long = radio off
  const NODE_LATE_MS = 4000;       // older than this on arrival = it came from the flash log
  const NODE_BLACKOUT_MS = 8000;   // a late burst covering at least this much time = a blackout
  const node = { live: false, state: null, pwr: 'main', vib: 0, sim: null, off: null, lastT: 0, burst: [], burstTimer: null };
  const isNode = () => !!(veh && veh.mode === 'N');

  function makeAlert(type, lat, lon, ts, extra) {
    const a = Object.assign({
      id: Date.now() + '-' + Math.random().toString(16).slice(2, 6),
      ts: ts, type: type, lat: lat, lon: lon,
      speed: veh ? veh.speed : 0, link: 'wifi', fix: node.sim === false, resolved: false,
      vid: settings.vehicleId, vname: activeVehicle().name
    }, extra);
    alerts.unshift(a);
    saveAlerts();
    return a;
  }

  // The node stamps messages with its own clock (ms since boot). The smallest
  // "arrival time - stamp" seen is the clock offset; anything above it is how
  // long the message waited on the tracker before it could be sent.
  function nodeAge(t, now) {
    if (t === null) return 0;
    if (node.off === null || t < node.lastT - 1000) node.off = now - t;    // first message, or the node restarted
    else node.off = Math.min(node.off, now - t);
    node.lastT = t;
    return Math.max(0, now - t - node.off);
  }

  function nodeVeh(lat, lon, spd, seen, moving) {
    return {
      mode: 'N', lat: lat, lon: lon, speed: spd, link: 'wifi', lastSeen: seen,
      fix: node.sim === false, sim: node.sim !== false, acc: null, heading: null, moving: moving
    };
  }

  function handleNode(leaf, m, now) {
    const lat = num(m.lat), lon = num(m.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const age = nodeAge(num(m.t), now);
    const fromLog = leaf === 'telemetry';       // an alert on the telemetry topic was stored during a blackout
    if (typeof m.alert === 'string') { nodeAlert(m, lat, lon, fromLog ? now - age : now, fromLog); return; }

    node.pwr = m.pwr === 'lipo' ? 'lipo' : 'main';
    node.vib = num(m.vib) || 0;
    node.sim = m.src !== 'gps';
    node.state = typeof m.state === 'string' ? m.state : null;
    const spd = num(m.spd) || 0;

    if (m.state === 'STORE_FORWARD' || age > NODE_LATE_MS) {
      // A point from the flash log: collect the burst, decide what it was when it ends
      node.burst.push([lat, lon, now - age]);
      clearTimeout(node.burstTimer);
      node.burstTimer = setTimeout(nodeBurstDone, 1500);
      veh = nodeVeh(lat, lon, spd, now - age, false);
      return;
    }

    if (node.burst.length) nodeBurstDone();
    node.live = true;
    veh = nodeVeh(lat, lon, spd, now, true);
    if (veh.fix) {
      recentFixes.push({ lat: lat, lon: lon, ts: now });
      if (recentFixes.length > 40) recentFixes.shift();
    }
    flashDetector();
    if (state.nodeArmed && guard.state !== 'arming') {
      if (guard.state !== 'stolen') {
        // Armed and it is reporting movement: that is the alarm
        guard.state = 'stolen';
        const a = makeAlert('theft_move', lat, lon, now);
        trailPts = guard.anchor ? [guard.anchor] : [];
        routeMetres = 0;
        mapGuard();
        mapUpdateVehicle();
        raiseAlert(a);
        startAlarm();
      } else {
        mapUpdateVehicle();
      }
      guard.dist = guard.anchor ? distM(guard.anchor, [lat, lon]) : 0;
      bannerLive();
    } else {
      mapUpdateVehicle();
    }
    saveState();
    renderAll();
  }

  // The burst of late points has ended (a live point arrived, or 1.5 s of quiet)
  function nodeBurstDone() {
    clearTimeout(node.burstTimer);
    node.burstTimer = null;
    const b = node.burst;
    node.burst = [];
    if (!b.length) return;
    const line = b.map((p) => [p[0], p[1]]);
    const span = b[b.length - 1][2] - b[0][2];
    if (b.length < 3 || span < NODE_BLACKOUT_MS) {
      // Only a slow start (Wi-Fi was still connecting): ordinary route points
      line.forEach((p) => {
        const prev = trailPts[trailPts.length - 1];
        if (prev) routeMetres += distM(prev, p);
        trailPts.push(p);
      });
      if (trail) trail.setLatLngs(trailPts);
      mapUpdateVehicle(true);
      saveState(); renderAll();
      return;
    }
    const now = Date.now(), metresLogged = lineMetres(line), end = b[b.length - 1];
    freezeTrail();                         // the live route stops where the blackout began
    routeMetres += metresLogged;
    const stepN = Math.max(1, Math.ceil((b.length - 1) / TRAIL_MAX));
    const tr = b.slice(0, -1).filter((p, i) => i % stepN === 0).map((p) => [p[0], p[1], Math.round((now - p[2]) / 1000)]);
    mapUpdateVehicle(true);
    flashDetector();
    const a = makeAlert('blackout', end[0], end[1], now, { trail: tr, trailM: Math.round(metresLogged), points: b.length });
    if (guard.state === 'stolen') {
      // Already tracking a theft: keep that banner, just draw the recovered route
      addPin(a);
      showSilentRoute(a, true);
      toast('📵 Blackout over: ' + b.length + ' logged points recovered');
    } else {
      raiseAlert(a);
    }
    saveState(); renderAll();
  }

  function nodeAlert(m, lat, lon, ts, fromLog) {
    if (m.alert !== 'MAIN_POWER_CUT') return;
    node.pwr = 'lipo';
    if (!isNode() || veh.lat == null) veh = nodeVeh(lat, lon, 0, ts, false);
    flashDetector();
    const a = makeAlert('tamper_power', lat, lon, ts, { late: fromLog });
    mapUpdateVehicle(true);
    if (guard.state === 'stolen') { addPin(a); toast('⚡ Tamper: the tracker\'s main power was cut'); }
    else raiseAlert(a);
    saveState(); renderAll();
  }

  // Once a second: telemetry stopping means the node switched its radio off
  function nodeTick() {
    if (!isNode() || !node.live || connState !== 'online') return;
    if (Date.now() - veh.lastSeen < NODE_SILENT_MS) return;
    node.live = false;
    veh.speed = 0; veh.moving = false;
    if (state.nodeArmed && guard.state === 'arming') {
      // It was armed while moving and has now parked: armed from here
      guard = { state: 'armed', anchor: [veh.lat, veh.lon], dist: 0 };
      mapGuard();
      feedback('guardFeedback', 'ok', 'Parked. It is armed now.');
      toast('🔒 Parked: armed. The alarm sounds the moment it moves.');
    } else if (guard.state === 'stolen') {
      addPin(makeAlert('theft_stop', veh.lat, veh.lon, veh.lastSeen));
      toast('📍 It went silent here. Location saved in Alerts.');
      bannerLive();
    }
    saveState(); renderAll();
  }

  // Keeps the live route drawn so far as a finished line and starts a new one
  let frozen = null;
  function freezeTrail() {
    if (frozen && trailPts.length > 1) {
      L.polyline(trailPts.slice(), { color: guard.state === 'stolen' ? '#ff1f3d' : (cssVar('--series-b') || '#00E5FF'), weight: 4, opacity: 0.85 }).addTo(frozen);
    }
    trailPts = [];
    if (trail) trail.setLatLngs([]);
  }
  function clearFrozen() { if (frozen) frozen.clearLayers(); }

  // ------------------------------------------------------------------ map
  let map = null, carMarker = null, trail = null, pinLayer = null, accCircle = null;
  let follow = true, followCtl = null, routeMetres = 0;
  const pins = {};

  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((b[0] - a[0]) * r / 2) ** 2 +
      Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // "Follow" button on the map: keeps the moving vehicle in view.
  // Dragging the map turns it off so you can look around; tap to turn it back on.
  function setFollow(on) {
    follow = on;
    if (followCtl) {
      followCtl.textContent = on ? '◉ Following' : '○ Follow';
      followCtl.setAttribute('aria-pressed', String(on));
    }
    if (on && map && veh && veh.lat != null) map.panTo([veh.lat, veh.lon]);
  }
  function addFollowControl() {
    const Ctl = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const b = L.DomUtil.create('button', 'map-follow');
        b.type = 'button';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => setFollow(!follow));
        followCtl = b;
        return b;
      }
    });
    map.addControl(new Ctl());
    map.on('dragstart', () => setFollow(false));
    setFollow(true);
  }

  function initMap() {
    if (typeof L === 'undefined') {
      $('mapEmpty').querySelector('strong').textContent = 'Map could not load';
      $('mapEmpty').querySelector('span').textContent = 'The map needs an internet connection. Alerts and counters still work.';
      return;
    }
    const start = veh ? [veh.lat, veh.lon] : [12.9716, 77.5946];
    map = L.map('map', { zoomControl: true }).setView(start, 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    trail = L.polyline([], { color: cssVar('--series-b') || '#00E5FF', weight: 4, opacity: 0.85 }).addTo(map);
    frozen = L.layerGroup().addTo(map);
    silentLine = L.polyline([], { color: '#FFB020', weight: 4, opacity: 0.95, dashArray: '2 9', lineCap: 'round' }).addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    accCircle = L.circle(start, { radius: 1, color: cssVar('--series-b') || '#00E5FF', weight: 1, opacity: 0.6, fillOpacity: 0.12, interactive: false });
    addFollowControl();
    alerts.forEach(addPin);
    if (veh) mapUpdateVehicle(true);
    const lastRoute = alerts.find((a) => a.trail && !a.resolved);
    if (lastRoute) showSilentRoute(lastRoute, false);
  }

  function mapUpdateVehicle(noTrail) {
    if (!map || !veh || veh.lat == null) return;
    const p = [veh.lat, veh.lon];
    if (!carMarker) {
      carMarker = L.marker(p, {
        icon: L.divIcon({ className: '', html: '<div class="car-marker"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 500, title: 'Vehicle'
      }).addTo(map);
      map.setView(p, 18);
    } else {
      glideMarker(p);
      if (follow) map.panTo(p, { animate: true, duration: 0.8 });
    }
    // Direction arrow (only when the tracker reports a heading) and stolen colouring
    const el = carMarker.getElement() && carMarker.getElement().querySelector('.car-marker');
    if (el) {
      if (veh.heading !== null && veh.heading !== undefined) { el.dataset.hdg = '1'; el.style.setProperty('--hdg', veh.heading + 'deg'); }
      else delete el.dataset.hdg;
      el.classList.toggle('stolen', guard.state === 'stolen');
    }
    // Accuracy circle: the true position is somewhere inside it
    if (veh.acc && veh.acc > 0) {
      accCircle.setLatLng(p).setRadius(veh.acc);
      if (!map.hasLayer(accCircle)) accCircle.addTo(map);
    } else if (map.hasLayer(accCircle)) {
      map.removeLayer(accCircle);
    }
    // Route: only real GPS fixes. A jump of more than 1 km between two reports
    // (e.g. the test location before the first fix) starts a new route instead
    // of drawing a line across the city and adding kilometres.
    if (!noTrail && (veh.fix || veh.sim)) {   // veh.sim: the node's simulated indoor route
      const last = trailPts[trailPts.length - 1];
      if (last && distM(last, p) > 1000) {
        trailPts = [];
        routeMetres = 0;
      }
      const prev = trailPts[trailPts.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) {   // skip repeats while standing still
        if (prev) routeMetres += distM(prev, p);
        trailPts.push(p);
        if (trailPts.length > 2000) trailPts.shift();
      }
      trail.setLatLngs(trailPts);
    }
  }

  // The dot glides to each new position instead of jumping
  let glideId = 0;
  function glideMarker(p) {
    const from = carMarker.getLatLng();
    const d = distM([from.lat, from.lng], p);
    const id = ++glideId;
    if (d < 0.3 || d > 300 || document.hidden) { carMarker.setLatLng(p); return; }
    const start = performance.now();
    (function step(now) {
      if (id !== glideId) return;
      const k = Math.min(1, (now - start) / 900);
      carMarker.setLatLng([from.lat + (p[0] - from.lat) * k, from.lng + (p[1] - from.lng) * k]);
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }

  // Guard extras on the map: a "parked here" marker and a red route while stolen
  let parkedMarker = null;
  function mapGuard() {
    if (!map) return;
    if (guard.anchor && guard.state !== 'off') {
      if (!parkedMarker) {
        parkedMarker = L.marker(guard.anchor, {
          icon: L.divIcon({ className: '', html: '<div class="parked-marker">P</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
          title: 'Parked here when Guard was armed', zIndexOffset: 100
        }).bindPopup('<strong>Parked here</strong><br>Guard was armed at this spot').addTo(map);
      } else {
        parkedMarker.setLatLng(guard.anchor);
      }
    } else if (parkedMarker) {
      map.removeLayer(parkedMarker);
      parkedMarker = null;
    }
    if (trail) trail.setStyle({ color: guard.state === 'stolen' ? '#ff1f3d' : (cssVar('--series-b') || '#00E5FF'), weight: guard.state === 'stolen' ? 5 : 4 });
    renderZone();
  }

  // ------------------------------------------------------------------ safe zone around the owner
  // Mode B: the owner's phone (this app) shares its own GPS. The tracker may move
  // around inside the zone; the THEFT ALERT starts once it is farther than
  // zoneM() from the owner. Without the owner's location the zone is centred on
  // the spot where the tracker was parked.
  let me = null, meWatch = null, meMarker = null, zoneCircle = null;
  const ZONES = [20, 50, 100];
  const zoneM = () => (ZONES.indexOf(state.zoneM) >= 0 ? state.zoneM : 50);
  const meFresh = () => !!(me && Date.now() - me.ts < 120000);
  function zoneCentre() {
    if (meFresh()) return [me.lat, me.lon];
    return guard.anchor || null;
  }
  function zoneDist(lat, lon) {
    const c = zoneCentre();
    return c ? distM(c, [lat, lon]) : null;
  }
  function startMyLocation() {
    if (meWatch !== null || !('geolocation' in navigator) || !window.isSecureContext) { renderZoneInfo(); return; }
    meWatch = navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      if (me && c.accuracy > 100) return;
      me = { lat: c.latitude, lon: c.longitude, acc: Math.round(c.accuracy || 0), ts: Date.now() };
      renderZone();
    }, (err) => {
      me = null;
      meError = err.code === 1 ? 'blocked' : 'no fix';
      renderZone();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  let meError = null;
  function stopMyLocation() {
    if (meWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(meWatch);
    meWatch = null;
  }
  function renderZone() {
    const on = !!(veh && veh.mode === 'B' && guard.state !== 'off');
    if (map) {
      if (meFresh()) {
        if (!meMarker) {
          meMarker = L.marker([me.lat, me.lon], {
            icon: L.divIcon({ className: '', html: '<div class="me-marker">You</div>', iconSize: [40, 22], iconAnchor: [20, 11] }),
            title: 'You (this phone)', zIndexOffset: 400
          }).addTo(map);
        } else meMarker.setLatLng([me.lat, me.lon]);
      } else if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
      const c = zoneCentre();
      if (on && c) {
        const col = guard.state === 'stolen' ? '#ff1f3d' : '#3dffa2';
        if (!zoneCircle) {
          zoneCircle = L.circle(c, { radius: zoneM(), color: col, weight: 2, dashArray: '6 6', fillOpacity: 0.06, interactive: false }).addTo(map);
        } else {
          zoneCircle.setLatLng(c).setRadius(zoneM()).setStyle({ color: col });
        }
      } else if (zoneCircle) { map.removeLayer(zoneCircle); zoneCircle = null; }
    }
    renderZoneInfo();
  }
  function renderZoneInfo() {
    const row = $('zoneRow');
    if (!row) return;
    row.hidden = !(veh && veh.mode === 'B') || isNode();
    document.querySelectorAll('[data-zone]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.zone === zoneM())));
    const d = veh && veh.lat != null ? zoneDist(veh.lat, veh.lon) : null;
    $('zoneInfo').textContent =
      (meFresh() ? '📍 Zone centred on you (±' + me.acc + ' m).'
        : meError === 'blocked' ? '📍 Your location is blocked, so the zone is centred on the parked spot.'
        : window.isSecureContext ? '📍 Finding your location… until then the zone is centred on the parked spot.'
        : '📍 Your location needs an https:// link; the zone is centred on the parked spot.') +
      (d !== null && guard.state !== 'off' ? ' Tracker is ' + Math.round(d) + ' m away.' : '');
  }

  function addPin(a) {
    if (!map || a.lat == null) return;
    if (a.vid && a.vid !== settings.vehicleId) return;      // pins of the vehicle on screen only
    const icon = L.divIcon({
      className: '',
      html: '<div class="alert-pin' + (a.resolved ? ' resolved' : '') + '"><span>!</span></div>',
      iconSize: [30, 30], iconAnchor: [15, 30]
    });
    if (pins[a.id]) pinLayer.removeLayer(pins[a.id]);
    const what = a.type === 'theft_move' ? 'Alarm: it started moving here' : 'Vehicle stopped';
    pins[a.id] = L.marker([a.lat, a.lon], { icon: icon, title: what + ' ' + clock(a.ts) })
      .bindPopup('<strong>' + what + '</strong><br>' + new Date(a.ts).toLocaleString() +
        (a.resolved ? '<br>Resolved' : ''))
      .addTo(pinLayer);
  }

  function showOnMap(a) {
    if (a.vid && a.vid !== settings.vehicleId && allVehicles()[a.vid]) switchVehicle(a.vid);
    showTab('map');
    if (!map || a.lat == null) return;
    if (a.trail) {
      setFollow(false);
      map.invalidateSize();
      map.flyToBounds(L.latLngBounds(trailLine(a)), { padding: [50, 50], maxZoom: 18, duration: 1 });
      showSilentRoute(a, true, 1150);
      return;
    }
    map.flyTo([a.lat, a.lon], 17, { duration: 1 });
    if (pins[a.id]) pins[a.id].openPopup();
  }

  // ------------------------------------------------------------------ alerts
  let bannerAlert = null;
  const ALERT_TITLE = {
    theft_stop: 'THEFT ALERT - vehicle stopped',
    theft_move: 'THEFT ALERT - it has left your safe zone!',
    tamper_power: 'TAMPER - the tracker\'s main power was cut',
    blackout: 'JAMMER BLACKOUT - route recovered from the tracker'
  };
  // Alert types that are incidents (counted as open, can be reported to the police)
  const isIncident = (a) => a.type === 'theft_stop' || a.type === 'theft_move' || a.type === 'tamper_power' || a.type === 'blackout';
  function raiseAlert(a) {
    bannerAlert = a;
    $('bannerTitle').textContent = ALERT_TITLE[a.type] || ALERT_TITLE.theft_stop;
    $('bannerDetail').textContent = clock(a.ts) + ' · ' + a.lat.toFixed(5) + ', ' + a.lon.toFixed(5) +
      (a.fix ? '' : ' (approximate)') + (a.trail ? ' · ' + trailText(a) : '');
    $('alertBanner').hidden = false;
    $('alertBanner').dataset.type = a.type;
    addPin(a);
    if (map && a.trail) {
      // Show the whole recorded route and draw it in as the alert lands
      setFollow(false);
      map.flyToBounds(L.latLngBounds(trailLine(a)), { padding: [50, 50], maxZoom: 18, duration: 1 });
      showSilentRoute(a, true, 1150);
    } else if (map && a.type === 'theft_move' && zoneCentre()) {
      // Show both: the owner / zone and where the tracker is now
      setFollow(false);
      map.flyToBounds(L.latLngBounds([zoneCentre(), [a.lat, a.lon]]), { padding: [60, 60], maxZoom: 19, duration: 1 });
    } else if (map) {
      map.flyTo([a.lat, a.lon], a.type === 'theft_move' ? 19 : 17, { duration: 1 });   // closest zoom: a few steps are visible
      if (a.type === 'theft_move') follow = true, setFollow(true);
    }
    if (navigator.vibrate) { try { navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) { /* ignore */ } }
    alarmSound();
    if (!audio) toast('🔇 Click anywhere on this page to hear the alarm');
    popupAlert(a);
    flashTitle();
  }

  // Guard alarm: keeps sounding until someone silences it or resolves the alert
  let alarmTimer = null;
  function startAlarm() {
    $('bannerMute').hidden = false;
    if (alarmTimer) return;
    alarmTimer = setInterval(() => {
      alarmSound();
      if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400]); } catch (e) { /* ignore */ } }
    }, 1400);
  }
  function stopAlarm() {
    clearInterval(alarmTimer);
    alarmTimer = null;
    $('bannerMute').hidden = true;
  }
  // Live line under the banner while it is being tracked
  function bannerLive() {
    if (guard.state !== 'stolen' || !veh) return;
    const d = zoneDist(veh.lat, veh.lon);
    $('bannerDetail').textContent =
      (veh.moving ? 'Moving now' : 'Stopped') + ' · ' +
      (d !== null ? Math.round(d) + ' m from ' + (meFresh() ? 'you' : 'where it was parked') + ' (zone ' + zoneM() + ' m)'
        : Math.round(guard.dist) + ' m from where it was parked') + ' · ' +
      Math.round(veh.speed) + ' km/h · updated ' + clock(veh.lastSeen);
  }

  // ------------------------------------------------------------------ pop-up (system) notifications
  const canNotify = () => 'Notification' in window && window.isSecureContext;
  const notifyOn = () => canNotify() && settings.notify && Notification.permission === 'granted';

  function popupAlert(a) {
    if (!notifyOn()) return;
    const title = (a.type === 'theft_move' ? '🚨 ' : '⚠ ') + (ALERT_TITLE[a.type] || ALERT_TITLE.theft_stop);
    const opts = {
      body: 'Location ' + a.lat.toFixed(5) + ', ' + a.lon.toFixed(5) + ' at ' + clock(a.ts) + '. Click to see it on the map.',
      icon: 'icon-192.png', badge: 'icon-192.png',
      tag: 'locate-' + a.id, requireInteraction: true, renotify: true
    };
    try {
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); showOnMap(a); n.close(); };
    } catch (e) {
      // Some browsers (mostly Android) only allow pop-ups through the service worker
      if (navigator.serviceWorker) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => {});
    }
  }

  // Blinking tab title while the window is in the background
  let titleTimer = null;
  function flashTitle() {
    if (!document.hidden || titleTimer) return;
    const base = document.title;
    let on = false;
    titleTimer = setInterval(() => { on = !on; document.title = on ? '⚠ THEFT ALERT' : base; }, 800);
    const stop = () => {
      if (document.hidden) return;
      clearInterval(titleTimer); titleTimer = null; document.title = base;
      document.removeEventListener('visibilitychange', stop);
    };
    document.addEventListener('visibilitychange', stop);
  }

  function renderNotify() {
    const sw = $('notifySwitch'), text = $('notifyText');
    const perm = canNotify() ? Notification.permission : 'unsupported';
    sw.setAttribute('aria-checked', String(notifyOn()));
    $('notifyLabel').textContent = notifyOn() ? 'On' : 'Off';
    sw.disabled = perm === 'unsupported';
    $('notifyBtn').hidden = !(canNotify() && settings.notify && perm === 'default');
    text.textContent =
      perm === 'unsupported' ? 'This browser cannot show pop-ups here (needs http://localhost or an https:// link).'
        : perm === 'denied' ? 'Pop-ups are blocked for this site. Click the icon left of the address bar → Notifications → Allow, then reload.'
          : 'Show a pop-up on this computer when a theft alert arrives, even if this window is hidden.';
  }

  async function enableNotify() {
    if (!canNotify()) return;
    settings.notify = true;
    saveSettings();
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { /* ignore */ } }
    renderNotify();
    if (perm === 'granted') {
      feedback('notifyFeedback', 'ok', 'Pop-up alerts are on. A test pop-up was sent.');
      try { new Notification('Locate pop-up alerts are on', { body: 'Theft alerts will appear like this.', icon: 'icon-192.png', tag: 'locate-test' }); } catch (e) { /* ignore */ }
    } else {
      feedback('notifyFeedback', 'fail', 'The browser did not allow pop-ups. Click the icon left of the address bar → Notifications → Allow.');
    }
  }

  function initNotify() {
    $('notifyBtn').addEventListener('click', enableNotify);
    $('notifySwitch').addEventListener('click', () => {
      if (notifyOn()) {
        settings.notify = false;
        saveSettings();
        feedback('notifyFeedback', 'ok', 'Pop-up alerts are off. The banner and sound still work.');
        renderNotify();
      } else {
        enableNotify();
      }
    });
    renderNotify();
  }

  const TYPES = {
    theft_stop: { icon: '⚠', label: 'Vehicle stopped - possible theft' },
    theft_move: { icon: '🚨', label: 'Stolen - the vehicle was moved' },
    stolen_report: { icon: '⚑', label: 'You reported the vehicle stolen' },
    tamper_power: { icon: '⚡', label: 'Tamper - main power cut, running on backup battery' },
    blackout: { icon: '📵', label: 'Network blackout (possible jammer) - route recovered' }
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderAlerts() {
    const list = $('alertList');
    list.textContent = '';
    const shown = alerts.filter(alertVisible).filter((a) =>
      alertFilter === 'all' ? true
        : alertFilter === 'open' ? !a.resolved
          : alertFilter === 'resolved' ? a.resolved
            : a.type === alertFilter);

    shown.forEach((a) => {
      const def = TYPES[a.type] || TYPES.theft_stop;
      const li = el('li', 'alert-item' + (a.resolved ? ' resolved' : ''));
      li.dataset.type = a.type;

      const main = el('button', 'alert-main');
      main.type = 'button';
      main.appendChild(el('span', 'alert-icon', def.icon));
      const body = el('div');
      const title = el('div', 'alert-title', def.label);
      title.appendChild(el('span', 'alert-tag', a.resolved ? '✓ Resolved' : '● Open'));
      if (a.reported) title.appendChild(el('span', 'alert-tag police', '🚓 Reported to police ' + clock(a.reported)));
      body.appendChild(title);
      let meta = (a.vname ? a.vname + ' · ' : '') + new Date(a.ts).toLocaleString();
      if (a.lat != null) meta += ' · ' + a.lat.toFixed(5) + ', ' + a.lon.toFixed(5);
      if (isIncident(a)) meta += ' · sent over ' + linkLabel(a.link) + (a.fix === false ? ' · approximate location (no GPS fix)' : '') +
        (a.late ? ' · delivered late from the tracker\'s log' : '');
      body.appendChild(el('div', 'alert-meta', meta));
      if (a.trail) body.appendChild(el('div', 'alert-meta alert-route', '┈ ' + trailText(a) + ', delivered in this one message'));
      main.appendChild(body);
      if (a.lat != null) {
        main.setAttribute('aria-label', def.label + ', ' + clock(a.ts) + '. Show on map');
        main.addEventListener('click', () => showOnMap(a));
      } else {
        main.disabled = true;
      }
      li.appendChild(main);

      const actions = el('div', 'alert-actions');
      if (a.lat != null) {
        const g = el('a', 'btn', 'Open in Google Maps');
        g.href = 'https://www.google.com/maps?q=' + a.lat + ',' + a.lon;
        g.target = '_blank'; g.rel = 'noopener';
        actions.appendChild(g);
        if (isIncident(a)) {
          const p = el('button', 'btn', a.reported ? '🚓 View police report' : '🚓 Report to police');
          p.type = 'button';
          p.addEventListener('click', () => openPolice(a));
          actions.appendChild(p);
        }
      }
      if (!a.resolved) {
        const r = el('button', 'btn', 'Mark resolved');
        r.type = 'button';
        r.addEventListener('click', () => {
          a.resolved = true;
          saveAlerts(); addPin(a);
          if (bannerAlert && bannerAlert.id === a.id) $('alertBanner').hidden = true;
          if (a.type === 'theft_move') {
            // Recovered: stop the alarm and tell the tracker to arm Guard again where it is now
            stopAlarm();
            // "it stopped here" alerts from the same theft are settled too
            alerts.forEach((x) => {
              if (x.type === 'theft_stop' && !x.resolved && x.ts >= a.ts) { x.resolved = true; addPin(x); }
            });
            saveAlerts();
            if (guard.state === 'stolen' && isNode()) {
              // The node takes no commands: arm again here, at its current position
              guard = { state: 'armed', anchor: [veh.lat, veh.lon], dist: 0 };
              mapGuard();
              toast('✓ Alarm cleared. Armed again where it is now.');
            } else if (guard.state === 'stolen') {
              guard = { state: 'arming', anchor: null, dist: 0 };
              mapGuard();
              sendCommand({ rearm: true }).then(() => toast('✓ Alarm cleared. Guard is arming again.'))
                .catch(() => toast('Alarm cleared here, but the tracker could not be reached to re-arm.'));
            }
          }
          renderAll();
        });
        actions.appendChild(r);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });

    const empty = $('alertsEmpty');
    empty.hidden = shown.length > 0;
    if (!shown.length) {
      const none = alerts.length === 0;
      empty.querySelector('strong').textContent = none ? 'No alerts yet' : 'Nothing matches this filter';
      empty.querySelector('span').textContent = none
        ? 'When the vehicle is taken and then stops, Locate sends one alert with its location. It will show up here.'
        : 'Choose "All" to see every alert.';
    }
    const open = alerts.filter((a) => alertVisible(a) && !a.resolved && isIncident(a)).length;
    $('alertCount').hidden = open === 0;
    $('alertCount').textContent = open;
  }

  // ------------------------------------------------------------------ status card
  function renderStatus() {
    const openAlert = alerts.find((a) => !a.resolved && (a.type === 'theft_stop' || a.type === 'tamper_power' || a.type === 'blackout'));
    let s = 'safe', icon = '✓', label = 'Safe', sub = 'No open alerts';
    const zd = veh && veh.lat != null ? zoneDist(veh.lat, veh.lon) : null;
    if (guard.state === 'stolen') {
      s = 'alert'; icon = '🚨'; label = 'THEFT ALERT';
      sub = (veh && veh.moving ? 'Moving now' : 'Stopped') + ' · ' +
        (zd !== null ? Math.round(zd) + ' m from ' + (meFresh() ? 'you' : 'the parked spot') : Math.round(guard.dist) + ' m from where it was parked');
    } else if (guard.state === 'moving') {
      s = 'theft'; icon = '⚠'; label = 'Moving - inside your zone';
      sub = (zd !== null ? Math.round(zd) + ' m from ' + (meFresh() ? 'you' : 'the parked spot') + '. ' : '') +
        'Theft alert at ' + zoneM() + ' m.';
    } else if (openAlert) {
      s = 'alert'; icon = '!'; label = 'Alert';
      sub = (openAlert.type === 'tamper_power' ? 'Main power cut at ' : openAlert.type === 'blackout' ? 'Blackout, route recovered at ' : 'Vehicle stopped at ') + clock(openAlert.ts);
    } else if (state.stolen) {
      s = 'theft'; icon = '⚑'; label = 'Theft mode';
      sub = 'Reported stolen. Waiting for the vehicle to stop.';
    } else if (isNode()) {
      if (node.live) {
        icon = '📡'; label = 'Moving';
        sub = 'Live tracking, one report a second' + (state.nodeArmed ? ' · arms when it parks' : '');
      } else if (state.nodeArmed) {
        icon = '🔒'; label = 'Armed';
        sub = 'Radio off while parked. The alarm sounds here the moment it moves.';
      } else {
        label = 'Radio off';
        sub = 'Parked, or logging its route through a blackout';
      }
      sub += (node.pwr === 'lipo' ? ' · on backup battery' : '') + (node.live && node.sim ? ' · simulated position (no GPS fix)' : '');
    } else if (veh && veh.mode === 'B' && guard.state === 'arming') {
      icon = '…'; label = 'Arming';
      sub = 'Locate arms in a few seconds. Leave the tracker still.';
    } else if (veh && veh.mode === 'B') {
      icon = '🔒'; label = 'Armed · silent';
      sub = 'Nothing is transmitted while parked. Your phone is alerted the moment it moves.';
    } else if (veh && veh.mode === 'A') {
      icon = '📡'; label = 'Always-on';
      sub = 'Transmitting every 1.5 s, moving or not';
    } else if (guard.state === 'armed') {
      icon = '🔒'; label = 'Guard armed';
      sub = 'The alarm sounds here the moment it moves';
    } else if (guard.state === 'arming') {
      icon = '…'; label = 'Guard arming';
      sub = 'Waiting for the tracker to be held still';
    }
    renderArm();
    $('statusState').dataset.state = s;
    $('statusIcon').textContent = icon;
    $('statusLabel').textContent = label;
    $('statusSub').textContent = sub;

    $('factSeen').textContent = veh && veh.lastSeen ? ago(veh.lastSeen) : 'Never';
    $('factSpeed').textContent = veh && veh.lastSeen ? Math.round(veh.speed) + ' km/h' : '-';
    $('factLink').textContent = veh ? linkLabel(veh.link) : '-';
    $('factAcc').textContent = veh && veh.acc ? '±' + Math.round(veh.acc) + ' m' : (veh && veh.sim ? 'Simulated (no GPS fix)' : veh && veh.fix === false ? 'No GPS fix' : '-');
    $('factRoute').textContent = routeMetres >= 1000 ? (routeMetres / 1000).toFixed(2) + ' km' : Math.round(routeMetres) + ' m';
    $('factMode').textContent = !veh || !veh.mode ? 'Unknown' : veh.mode === 'A' ? 'Always-on tracker' : veh.mode === 'G' ? 'Guard'
      : veh.mode === 'N' ? (node.live ? 'Pursuit (live)' : 'Radio off') : 'Locate';
    renderZone();
    $('mapEmpty').hidden = !!map && !!(veh && veh.lastSeen);   // stays visible if the map failed to load
    $('recenterBtn').disabled = !(veh && veh.lat != null);
  }

  // ------------------------------------------------------------------ compare screen
  let chart = null, lampTimer = null, detTimer = null;

  function flashDetector() {
    const lamp = $('detLamp');
    lamp.classList.add('on');
    $('detText').textContent = 'BEEP - transmission detected';
    clearTimeout(lampTimer);
    clearTimeout(detTimer);
    lampTimer = setTimeout(() => lamp.classList.remove('on'), 350);
    detTimer = setTimeout(renderDetectorIdle, 1200);
    if (activeTab === 'compare') tone(1900, 0, 0.07, 0.05);
  }
  function renderDetectorIdle() {
    if ($('detLamp').classList.contains('on')) return;
    $('detText').textContent = 'Quiet - nothing to detect';
    $('detSub').textContent = isNode()
      ? 'This tracker keeps its radio off while parked and transmits only while it moves.'
      : veh && veh.mode === 'B'
      ? 'Mode B transmits nothing while parked. It only speaks up when the vehicle is moved.'
      : 'The lamp flashes every time the tracker transmits.';
  }

  function bump(series) {
    const card = $(series === 'A' ? 'countA' : 'countB').parentElement;
    card.classList.add('bump');
    setTimeout(() => card.classList.remove('bump'), 200);
  }

  function perMinute() {
    const cut = Date.now() - 60000;
    stamps.A = stamps.A.filter((t) => t >= cut);
    stamps.B = stamps.B.filter((t) => t >= cut);
    return [stamps.A.length, stamps.B.length];
  }

  function chartColors() {
    return {
      a: cssVar('--series-a'), b: cssVar('--series-b'),
      text: cssVar('--text'), muted: cssVar('--muted'), grid: cssVar('--border'), surface: cssVar('--surface')
    };
  }

  function initChart() {
    if (typeof Chart === 'undefined') { $('tpmChart').parentElement.hidden = true; return; }
    const c = chartColors();
    chart = new Chart($('tpmChart'), {
      type: 'bar',
      data: {
        labels: ['Always-on tracker', 'Locate'],
        datasets: [{
          label: 'Transmissions in the last minute',
          data: [0, 0],
          backgroundColor: [c.a, c.b],
          borderRadius: { topLeft: 4, topRight: 4 },
          maxBarThickness: 72
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ctx.parsed.y + ' transmissions in the last minute' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.text, font: { size: 14, weight: '600' } }, border: { color: c.grid } },
          y: { beginAtZero: true, suggestedMax: 10, ticks: { precision: 0, color: c.muted }, grid: { color: c.grid }, border: { display: false } }
        }
      }
    });
  }

  function restyleChart() {
    if (!chart) return;
    const c = chartColors();
    chart.data.datasets[0].backgroundColor = [c.a, c.b];
    chart.options.scales.x.ticks.color = c.text;
    chart.options.scales.x.border.color = c.grid;
    chart.options.scales.y.ticks.color = c.muted;
    chart.options.scales.y.grid.color = c.grid;
    chart.update('none');
    if (trail) trail.setStyle({ color: c.b });
  }

  function renderCompare() {
    $('countA').textContent = state.counts.A;
    $('countB').textContent = state.counts.B;

    const mode = veh && veh.mode;
    const badge = $('modeBadge');
    const stolenNow = guard.state === 'stolen';
    badge.dataset.mode = stolenNow ? 'S' : (mode || 'unknown');
    $('modeBadgeIcon').textContent = stolenNow ? '🚨' : mode === 'A' ? '📡' : mode === 'B' ? '🛡' : mode === 'G' ? '🔒' : '…';
    $('modeBadgeText').textContent = stolenNow ? 'THEFT ALERT: LIVE TRACKING'
      : mode === 'B' && guard.state === 'moving' ? 'MODE B · MOVING INSIDE ZONE'
      : mode === 'A' ? 'MODE A · ALWAYS-ON: DETECTABLE' : mode === 'B' ? (guard.state === 'arming' ? 'MODE B · ARMING…' : 'MODE B · ARMED: SILENT')
        : mode === 'G' ? (guard.state === 'armed' ? 'GUARD: ARMED' : 'GUARD: ARMING…') : 'Waiting for the vehicle';
    if (mode === 'N' && !stolenNow) {
      // LOCATE node: radio on only while it moves
      badge.dataset.mode = node.live ? 'A' : 'B';
      $('modeBadgeIcon').textContent = node.live ? '📡' : '🛡';
      $('modeBadgeText').textContent = node.live ? 'PURSUIT: LIVE TRACKING' : 'RADIO OFF: PARKED';
    }

    $('modeBtnA').setAttribute('aria-pressed', String(mode === 'A'));
    $('modeBtnB').setAttribute('aria-pressed', String(mode === 'B'));

    const pm = perMinute();
    $('tpmText').textContent = 'Always-on tracker: ' + pm[0] + ' · Locate: ' + pm[1];
    if (chart) {
      chart.data.datasets[0].data = pm;
      chart.update();
    }
    $('deviceTx').textContent = state.deviceTx != null
      ? 'The tracker itself reports ' + state.deviceTx + ' transmissions since it was switched on.' : '';
    const routed = alerts.find((a) => a.trail);
    $('trailInfo').hidden = !routed;
    if (routed) {
      $('trailInfoText').textContent = 'The last Locate alert was 1 transmission and carried the whole ' + trailText(routed) +
        '. An always-on tracker would have sent about ' + Math.max(1, Math.round(routed.trail[0][2] / 1.5)) + ' pings for the same trip.';
    }
    renderDetectorIdle();
  }

  // ------------------------------------------------------------------ arm / disarm
  // Arm    = Guard: alarm here the moment the tracker moves, then live tracking.
  // Disarm = Locate: silent while moving, one alert after it stops.
  const isArmed = () => (isNode() ? !!state.nodeArmed : pendingMode ? pendingMode === 'G' : !!(veh && veh.mode === 'G'));

  function setArmed(on) {
    const say = (kind, text) => { feedback('guardFeedback', kind, text); feedback('armFeedback', kind, text); };
    if (isNode()) {
      // The node takes no commands: armed / disarmed is remembered here in the app
      state.nodeArmed = on;
      if (on && node.live) {
        // Moving right now: it arms by itself as soon as it parks (radio goes quiet)
        guard = { state: 'arming', anchor: null, dist: 0 };
        say('ok', 'Arming. It is moving now, so it arms as soon as it parks (about 8 seconds of stillness).');
      } else if (on) {
        guard = { state: 'armed', anchor: [veh.lat, veh.lon], dist: 0 };
        say('ok', 'Armed. The alarm sounds here the moment the tracker reports movement.');
      } else {
        stopAlarm();
        $('alertBanner').hidden = true;
        alerts.forEach((a) => { if ((a.type === 'theft_move' || a.type === 'theft_stop') && !a.resolved) { a.resolved = true; addPin(a); } });
        saveAlerts();
        guard = { state: 'off', anchor: null, dist: 0 };
        say('ok', 'Disarmed. Trips are tracked live, without an alarm.');
      }
      mapGuard();
      saveState();
      renderAll();
      return;
    }
    if (on && settings.demo) { say('fail', 'Arming needs the phone tracker. Turn Demo mode off in Settings.'); return; }
    say('wait', on ? 'Arming…' : 'Disarming…');
    sendCommand({ mode: on ? 'G' : 'B' }).then(() => {
      pendingMode = on ? 'G' : 'B';
      if (!on) {
        // Disarming also ends any alarm in progress
        stopAlarm();
        $('alertBanner').hidden = true;
        alerts.forEach((a) => { if (a.type === 'theft_move' && !a.resolved) { a.resolved = true; addPin(a); } });
        saveAlerts();
        guard = { state: 'off', anchor: null, dist: 0 };
        mapGuard();
        say('ok', 'Disarmed. Now in Locate mode: silent while moving, one alert after it stops.');
      } else {
        say('ok', 'Sent. Hold the tracker still for 3 seconds and it arms.');
      }
      renderAll();
    }).catch((err) => say('fail', 'Not sent: ' + friendlyError(err) + '.'));
  }

  // Phone tracker: the status card and Controls switch between Always-on and Locate.
  // (Arm / Disarm is only used with the ESP32 node.)
  const label = (id, strong, span) => { const e = $(id); e.querySelector('strong').textContent = strong; e.querySelector('span').textContent = span; };
  function renderArm() {
    $('mapModeSwitch').hidden = isNode();
    $('guardBtn').hidden = !isNode();
    if (!isNode()) {
      const m = pendingMode || (veh && veh.mode);
      $('mapModeA').setAttribute('aria-pressed', String(m === 'A'));
      $('mapModeB').setAttribute('aria-pressed', String(m === 'B'));
      $('mapModeSwitch').dataset.pending = String(!!pendingMode);
      $('guardBtn').parentElement.dataset.armed = String(m === 'B' && guard.state !== 'stolen');
      $('guardHint').textContent = guard.state === 'stolen' ? 'It left your safe zone. It is followed live. Tap A, or Mark resolved in Alerts, to stop the alarm.'
        : guard.state === 'moving' ? 'It is moving but still inside your zone. The theft alert starts when it goes past ' + zoneM() + ' m.'
        : pendingMode ? 'Switching… the tracker confirms in a moment.'
        : m === 'B' ? 'Mode B: nothing is sent while parked. The moment it moves, this phone gets an alarm.'
        : m === 'A' ? 'Mode A: it transmits all the time, like a normal tracker.'
        : 'Waiting for the tracker. Open the tracker page on the other phone.';
      label('armBtn', 'A · Always-on', 'Transmits every 1.5 s');
      label('disarmBtn', 'B · Locate (armed)', 'Silent, alerts you the moment it moves');
      $('armState').textContent = 'Mode A transmits all the time, like a normal tracker, so a thief\'s detector finds it. Mode B transmits nothing while parked and alerts your phone the moment the vehicle starts moving.';
      $('armBtn').setAttribute('aria-pressed', String(m === 'A'));
      $('disarmBtn').setAttribute('aria-pressed', String(m === 'B'));
      return;
    }
    label('armBtn', '🔒 Arm', 'Alarm the moment it moves');
    label('disarmBtn', '🔓 Disarm', 'Track trips without an alarm');
    $('armState').textContent = 'Armed: the alarm sounds here the moment the tracker reports movement, then it is followed live.';
    const armed = isArmed();
    const stolenNow = guard.state === 'stolen';
    const b = $('guardBtn');
    b.textContent = armed ? '🔓 Disarm (back to Locate)' : '🔒 Arm';
    b.classList.toggle('btn-primary', !armed);
    b.parentElement.dataset.armed = String(armed);
    $('guardHint').textContent = stolenNow ? 'STOLEN - it is being followed live. Disarm ends the alarm.'
      : armed ? (guard.state === 'armed' ? 'ARMED - the alarm sounds here the moment it moves.' : isNode() ? 'Arming - it arms as soon as it parks.' : 'Arming - hold the tracker still for 3 seconds.')
        : (isNode() ? 'Disarmed.' : 'Disarmed (Locate mode).') + ' Arm: the alarm sounds here the moment it moves.';
    if (isNode()) b.textContent = armed ? '🔓 Disarm' : '🔒 Arm';
    $('armBtn').setAttribute('aria-pressed', String(armed));
    $('disarmBtn').setAttribute('aria-pressed', String(!armed && !!(veh && veh.mode === 'B')));
  }

  function requestMode(m) {
    const say = (kind, text) => ['modeFeedback', 'guardFeedback', 'armFeedback'].forEach((id) => feedback(id, kind, text));
    if (veh && veh.mode === m && !pendingMode) {
      say('ok', 'The tracker is already in this mode.');
      return;
    }
    say('wait', 'Sending…');
    sendCommand({ mode: m }).then(() => {
      pendingMode = m;
      if (m === 'A' && guard.state === 'stolen') {
        // Switching to A ends the alarm
        stopAlarm();
        $('alertBanner').hidden = true;
        alerts.forEach((a) => { if (a.type === 'theft_move' && !a.resolved) { a.resolved = true; addPin(a); } });
        saveAlerts();
        guard = { state: 'off', anchor: null, dist: 0 };
        mapGuard();
      }
      say('ok', (veh && veh.mode === 'B' && veh.link !== 'phone' && !settings.demo)
        ? 'Sent. The vehicle is silent in Locate mode, so it will switch at its next stop.'
        : 'Sent. Waiting for the tracker to confirm.');
      renderArm();
    }).catch((err) => say('fail', 'Not sent: ' + friendlyError(err) + '.'));
  }

  // ------------------------------------------------------------------ controls
  function renderControls() {
    $('buzzerSwitch').setAttribute('aria-checked', String(!!state.buzzer));
    $('buzzerLabel').textContent = state.buzzer ? 'On' : 'Off';
    $('stolenBtn').hidden = state.stolen;
    $('stolenClear').hidden = !state.stolen;
    $('stolenInfo').textContent = state.stolen
      ? 'This vehicle is reported stolen. Its location will arrive the next time it stops.'
      : 'Switches the tracker to Locate and makes it send its location the next time the vehicle stops, even if the owner\'s phone is nearby.';
    $('demoSwitch').setAttribute('aria-checked', String(!!settings.demo));
    $('demoLabel').textContent = settings.demo ? 'On' : 'Off';
  }

  function initControls() {
    $('buzzerSwitch').addEventListener('click', () => {
      const want = !state.buzzer;
      feedback('buzzerFeedback', 'wait', 'Sending…');
      sendCommand({ buzzer: want }).then(() => {
        state.buzzer = want; saveState(); renderControls();
        feedback('buzzerFeedback', 'ok', 'Buzzer ' + (want ? 'on' : 'off') + '. ' + deliveredText());
      }).catch((err) => feedback('buzzerFeedback', 'fail', 'Failed: ' + friendlyError(err) + '. Nothing was changed.'));
    });

    $('stolenBtn').addEventListener('click', () => { $('stolenConfirm').hidden = false; $('stolenYes').focus(); });
    $('stolenNo').addEventListener('click', () => { $('stolenConfirm').hidden = true; $('stolenBtn').focus(); });
    $('stolenYes').addEventListener('click', () => {
      $('stolenConfirm').hidden = true;
      feedback('stolenFeedback', 'wait', 'Sending…');
      sendCommand({ mode: 'B', stolen: true }).then(() => {
        state.stolen = true;
        alerts.unshift({
          id: Date.now() + '-r', ts: Date.now(), type: 'stolen_report',
          lat: veh ? veh.lat : null, lon: veh ? veh.lon : null, link: 'app', resolved: false,
          vid: settings.vehicleId, vname: activeVehicle().name
        });
        saveAlerts(); saveState(); renderAll();
        feedback('stolenFeedback', 'ok', 'Reported stolen. ' + deliveredText());
      }).catch((err) => feedback('stolenFeedback', 'fail', 'Failed: ' + friendlyError(err) + '. The report was not sent.'));
    });
    $('stolenClear').addEventListener('click', () => {
      feedback('stolenFeedback', 'wait', 'Sending…');
      sendCommand({ stolen: false }).then(() => {
        state.stolen = false;
        alerts.forEach((a) => { if (a.type === 'stolen_report') a.resolved = true; });
        saveAlerts(); saveState(); renderAll();
        feedback('stolenFeedback', 'ok', 'Report cancelled. ' + deliveredText());
      }).catch((err) => feedback('stolenFeedback', 'fail', 'Failed: ' + friendlyError(err) + '.'));
    });
  }

  // ------------------------------------------------------------------ settings
  function fillSettingsForm() {
    $('setBroker').value = settings.broker;
    $('setPort').value = settings.port;
    $('setUser').value = settings.username;
    $('setPass').value = settings.password;
    $('setPrefix').value = settings.prefix;
    $('setVehicle').value = settings.vehicleId;
  }
  function readSettingsForm() {
    return {
      broker: $('setBroker').value.trim(),
      port: parseInt($('setPort').value, 10) || 9001,
      username: $('setUser').value.trim(),
      password: $('setPass').value,
      prefix: $('setPrefix').value.trim().replace(/^\/+|\/+$/g, '') || 'tracker',
      vehicleId: $('setVehicle').value.trim() || 'car1'
    };
  }

  function testConnection() {
    const s = readSettingsForm();
    const url = buildUrl(s);
    if (typeof mqtt === 'undefined') { feedback('settingsFeedback', 'fail', 'The app files did not load. Check the internet connection and reload.'); return; }
    if (!url) { feedback('settingsFeedback', 'fail', 'That address does not look right.'); return; }
    feedback('settingsFeedback', 'wait', 'Testing ' + url + ' …');
    const t = mqtt.connect(url, Object.assign(mqttOptions(s), { reconnectPeriod: 0 }));
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { t.end(true); } catch (e) { /* ignore */ }
      feedback('settingsFeedback', ok ? 'ok' : 'fail', msg);
    };
    const timer = setTimeout(() => finish(false, 'No answer from ' + url + '. Check the address, the port and that the broker is running.'), 9000);
    t.on('connect', () => finish(true, 'Connection works. Press "Save and connect" to use it.'));
    t.on('error', (err) => finish(false, 'Could not connect: ' + friendlyError(err) + '.'));
    t.on('close', () => setTimeout(() => finish(false, 'Could not connect to ' + url + '. Check the address and port.'), 300));
  }

  function initSettings() {
    fillSettingsForm();
    $('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const changedVehicle = $('setVehicle').value.trim() !== settings.vehicleId || $('setPrefix').value.trim() !== settings.prefix;
      Object.assign(settings, readSettingsForm());
      saveSettings();
      if (changedVehicle) { veh = null; trailPts = []; routeMetres = 0; if (trail) trail.setLatLngs([]); saveState(); }
      fillSettingsForm();
      feedback('settingsFeedback', 'ok', settings.demo ? 'Saved. Turn Demo mode off to use this connection.' : 'Saved. Connecting…');
      connect();
      renderAll();
    });
    $('testBtn').addEventListener('click', testConnection);

    $('demoSwitch').addEventListener('click', () => {
      settings.demo = !settings.demo;
      saveSettings();
      veh = null; trailPts = []; routeMetres = 0; pendingMode = null;
      if (trail) trail.setLatLngs([]);
      if (carMarker && map) { map.removeLayer(carMarker); carMarker = null; }
      showSilentRoute(null); clearFrozen();
      saveState();
      connect();
      renderAll();
    });

    $('clearBtn').addEventListener('click', () => { $('clearConfirm').hidden = false; $('clearYes').focus(); });
    $('clearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; });
    $('clearYes').addEventListener('click', () => {
      alerts = [];
      saveAlerts();
      if (pinLayer) pinLayer.clearLayers();
      Object.keys(pins).forEach((k) => delete pins[k]);
      showSilentRoute(null); clearFrozen();
      $('alertBanner').hidden = true;
      $('clearConfirm').hidden = true;
      renderAll();
    });

    // Fresh start before a demo: wipes what the last run left on this screen.
    // Connection settings, accounts and vehicle details are kept; the tracker is not touched.
    $('demoResetBtn').addEventListener('click', () => { $('demoResetConfirm').hidden = false; $('demoResetYes').focus(); });
    $('demoResetNo').addEventListener('click', () => { $('demoResetConfirm').hidden = true; });
    $('demoResetYes').addEventListener('click', () => {
      alerts = [];
      saveAlerts();
      if (pinLayer) pinLayer.clearLayers();
      Object.keys(pins).forEach((k) => delete pins[k]);
      showSilentRoute(null); clearFrozen();
      state.counts = { A: 0, B: 0 };
      state.stolen = false;
      state.buzzer = false;
      stamps = { A: [], B: [] };
      trailPts = []; routeMetres = 0; recentFixes.length = 0;
      if (trail) trail.setLatLngs([]);
      stopAlarm();
      bannerAlert = null;
      $('alertBanner').hidden = true;
      if (guard.state === 'stolen') guard.state = isNode() ? 'armed' : 'arming';   // the tracker re-reports its real state
      mapGuard();
      saveState();
      $('demoResetConfirm').hidden = true;
      feedback('demoResetFeedback', 'ok', 'Ready. Alerts, counters and the route are cleared.');
      renderAll();
    });
  }

  // ------------------------------------------------------------------ demo mode (no hardware)
  const ROUTE = [
    [12.9716, 77.5946], [12.9741, 77.5992], [12.9763, 77.6034], [12.9737, 77.6088],
    [12.9692, 77.6074], [12.9668, 77.6011], [12.9683, 77.5957]
  ];
  function metres(a, b) {
    const dy = (b[0] - a[0]) * 111320;
    const dx = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }
  const sim = {
    timer: null, mode: 'A', seg: 0, frac: 0, speed: 0, phase: 'drive',
    phaseAt: 0, last: 0, lastPing: 0, alertAt: 0, alerted: true, tx: 0, t0: 0,
    bState: 'armed', stopSent: true,   // Mode B: armed (silent) / stolen (moving, tracked live)

    start() {
      this.stop();
      const now = Date.now();
      Object.assign(this, { bState: 'armed', stopSent: true, mode: 'A', seg: 0, frac: 0, phase: 'drive', phaseAt: now, last: now, lastPing: 0, alerted: true, tx: 0, t0: now });
      this.emitStatus();
      this.timer = setInterval(() => this.tick(), 250);
    },
    stop() { clearInterval(this.timer); this.timer = null; },

    pos() {
      const a = ROUTE[this.seg], b = ROUTE[(this.seg + 1) % ROUTE.length];
      return [a[0] + (b[0] - a[0]) * this.frac, a[1] + (b[1] - a[1]) * this.frac];
    },
    base(type) {
      const p = this.pos();
      this.tx++;
      return {
        id: settings.vehicleId, mode: this.mode, type: type,
        lat: +p[0].toFixed(6), lon: +p[1].toFixed(6),
        speed_kmh: +this.speed.toFixed(1), tx_count: this.tx,
        uptime_s: Math.round((Date.now() - this.t0) / 1000),
        link: 'phone', gps_fix: true, moving: this.phase === 'drive'
      };
    },
    emitStatus(type) {
      this.tx++;
      const p = this.pos();
      handleMessage(topic('status'), JSON.stringify({ id: settings.vehicleId, mode: this.mode, type: type || 'mode_change',
        lat: +p[0].toFixed(6), lon: +p[1].toFixed(6), link: 'phone', tx_count: this.tx }));
    },
    onConfig(obj) {
      if ((obj.mode === 'A' || obj.mode === 'B') && obj.mode !== this.mode) {
        this.mode = obj.mode;
        if (obj.mode === 'B') {
          // Mode B: park the simulated car, arm, then it gets "stolen" about 10 s later
          this.phase = 'stop'; this.phaseAt = Date.now() + 4000; this.speed = 0;
          this.bState = 'armed'; this.stopSent = true;
          setTimeout(() => this.emitStatus('arming'), 300);
          setTimeout(() => this.emitStatus('armed'), 2000);
        } else {
          setTimeout(() => this.emitStatus(), 300);
        }
      }
    },
    tick() {
      const now = Date.now(), dt = Math.min(1, (now - this.last) / 1000);
      this.last = now;
      if (this.phase === 'drive') {
        this.speed = 32 + Math.sin(now / 1500) * 6;
        let d = (this.speed / 3.6) * dt;
        while (d > 0) {
          const a = ROUTE[this.seg], b = ROUTE[(this.seg + 1) % ROUTE.length];
          const len = metres(a, b), left = len * (1 - this.frac);
          if (d < left) { this.frac += d / len; d = 0; }
          else { d -= left; this.seg = (this.seg + 1) % ROUTE.length; this.frac = 0; }
        }
        if (this.mode === 'B') {
          if (this.bState === 'armed') {
            // It started moving while armed: alert the owner, then track it live
            this.bState = 'stolen'; this.stopSent = false; this.lastPing = now;
            handleMessage(topic('alert'), JSON.stringify(this.base('theft_move')));
          } else if (now - this.lastPing >= 1000) {
            this.lastPing = now;
            handleMessage(topic('ping'), JSON.stringify(this.base('track')));
          }
        }
        if (now - this.phaseAt > 18000) { this.phase = 'stop'; this.phaseAt = now; this.speed = 0; }
      } else {
        this.speed = 0;
        if (this.mode === 'B' && this.bState === 'stolen' && !this.stopSent && now - this.phaseAt >= 5000) {
          // Stopped for 5 s: one "stopped here" alert, then silent and armed again
          this.stopSent = true; this.bState = 'armed';
          handleMessage(topic('alert'), JSON.stringify(this.base('theft_stop')));
        }
        if (now - this.phaseAt > 14000) { this.phase = 'drive'; this.phaseAt = now; }
      }
      if (this.mode === 'A' && now - this.lastPing >= 1500) {
        this.lastPing = now;
        handleMessage(topic('ping'), JSON.stringify(this.base('ping')));
      }
    }
  };

  // ------------------------------------------------------------------ tabs, theme, wiring
  function showTab(name) {
    if (name === 'compare' && session && session.role !== 'admin') name = 'map';   // control room only
    activeTab = name;
    document.querySelectorAll('.screen').forEach((s) => {
      const on = s.id === 'screen-' + name;
      s.hidden = !on;
      s.classList.toggle('active', on);
    });
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
    if (name === 'compare' && chart) chart.resize();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = cssVar('--bg');
    restyleChart();
  }

  // ------------------------------------------------------------------ phone app (install, screen on, offline)
  let installEvent = null;
  const isStandalone = () =>
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  function renderInstall() {
    const btn = $('installBtn'), text = $('installText');
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isStandalone()) {
      btn.hidden = true;
      text.textContent = '✓ Locate is installed and running as an app.';
    } else if (installEvent) {
      btn.hidden = false;
      text.textContent = 'Add Locate to your home screen. It opens full-screen like a normal app.';
    } else if (ios) {
      btn.hidden = true;
      text.textContent = 'On iPhone: open this page in Safari, tap the Share button, then "Add to Home Screen".';
    } else if (!window.isSecureContext) {
      btn.hidden = true;
      text.textContent = 'Full install needs a secure https:// link (for example a Netlify link). On this link, use the browser menu ⋮ → "Add to Home screen" to get a shortcut icon.';
    } else {
      btn.hidden = true;
      text.textContent = 'Use the browser menu ⋮ → "Install app" or "Add to Home screen".';
    }
  }

  function initPhoneApp() {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; renderInstall(); });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      feedback('installFeedback', 'ok', 'Installed. Open Locate from your home screen.');
      renderInstall();
    });
    $('installBtn').addEventListener('click', async () => {
      if (!installEvent) return;
      const ev = installEvent;
      installEvent = null;
      ev.prompt();
      try {
        const choice = await ev.userChoice;
        if (choice.outcome !== 'accepted') feedback('installFeedback', 'wait', 'Not installed. You can install it later from here.');
      } catch (e) { /* ignore */ }
      renderInstall();
    });
    renderInstall();

    // Offline cache + installability. Service workers only run on https:// or localhost.
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
    }

    // Keep screen on (Screen Wake Lock). The browser drops the lock whenever the
    // app is hidden, so it is requested again each time the app comes back.
    let lock = null;
    const want = () => !!settings.keepAwake;
    async function acquire() {
      if (!want() || lock || document.visibilityState !== 'visible') return;
      if (!('wakeLock' in navigator)) {
        feedback('wakeFeedback', 'fail', 'This browser cannot keep the screen on. Raise the phone\'s screen timeout instead.');
        return;
      }
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
        feedback('wakeFeedback', 'ok', 'The screen will stay on while Locate is open.');
      } catch (e) {
        feedback('wakeFeedback', 'fail', 'Could not keep the screen on (needs an https:// link or localhost).');
      }
    }
    function renderWake() {
      $('wakeSwitch').setAttribute('aria-checked', String(want()));
      $('wakeLabel').textContent = want() ? 'On' : 'Off';
    }
    $('wakeSwitch').addEventListener('click', () => {
      settings.keepAwake = !want();
      saveSettings();
      renderWake();
      if (want()) acquire();
      else {
        if (lock) { lock.release().catch(() => {}); lock = null; }
        feedback('wakeFeedback', 'ok', 'The phone will sleep normally.');
      }
    });
    document.addEventListener('visibilitychange', acquire);
    renderWake();
    acquire();
  }

  // ------------------------------------------------------------------ report to police
  // Builds a theft report from an alert plus the latest tracked position.
  // Nothing is sent by the app itself: the user emails it, copies it, downloads
  // it or phones it in, then marks the alert as reported.
  const EMERGENCY_NUMBER = '112';      // India's single emergency number; change for other countries
  let profile = { reg: '', desc: '', phone: '', email: '' };   // each person's own; filled in loadUserData()
  let policeAlert = null, policeTimer = null;

  const pad2 = (n) => String(n).padStart(2, '0');
  function policeRef(a) {
    const d = new Date(a.ts);
    return 'LOC-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  const mapsLink = (lat, lon) => 'https://www.google.com/maps?q=' + lat.toFixed(6) + ',' + lon.toFixed(6);

  function buildPoliceReport(a) {
    // Latest position: the live one if the tracker has reported since the alarm
    const live = veh && veh.lat != null && veh.lastSeen && veh.lastSeen >= a.ts;
    const lat = live ? veh.lat : a.lat, lon = live ? veh.lon : a.lon, at = live ? veh.lastSeen : a.ts;
    const L = [];
    L.push('VEHICLE THEFT REPORT (Locate tracker)');
    L.push('Reference: ' + policeRef(a));
    L.push('Report prepared: ' + new Date().toLocaleString());
    L.push('');
    L.push('REPORTED BY');
    L.push('  Name: ' + (session ? (session.name || session.user) : '-'));
    L.push('  Phone: ' + (profile.phone || '(not given)'));
    L.push('');
    L.push('VEHICLE');
    L.push('  Registration: ' + (profile.reg || '(not given)'));
    L.push('  Description: ' + (profile.desc || '(not given)'));
    L.push('  Tracker ID: ' + settings.vehicleId);
    L.push('');
    L.push('WHAT HAPPENED');
    L.push('  ' + (a.type === 'tamper_power'
      ? 'The tracker\'s main power supply was cut (possible tampering). It switched to its backup battery and reported this position.'
      : a.type === 'blackout'
      ? 'The tracker lost its network link while moving (possible signal jammer). It logged its route and uploaded it when the link returned.'
      : a.type === 'theft_move'
      ? 'The vehicle was moved without the owner\'s permission. The tracker raised the alarm.'
      : 'The vehicle was taken and has stopped. The tracker reported where it stopped.'));
    L.push('  Alarm time: ' + new Date(a.ts).toLocaleString());
    L.push('  Alarm location: ' + a.lat.toFixed(6) + ', ' + a.lon.toFixed(6));
    L.push('');
    L.push('LAST KNOWN LOCATION');
    L.push('  ' + lat.toFixed(6) + ', ' + lon.toFixed(6) +
      (live && veh.acc ? ' (accurate to about ' + Math.round(veh.acc) + ' m)' : '') +
      (a.fix === false && !live ? ' (approximate - no GPS fix)' : ''));
    L.push('  Seen at: ' + new Date(at).toLocaleString());
    if (live) L.push('  Status: ' + (veh.moving ? 'MOVING, about ' + Math.round(veh.speed) + ' km/h' : 'stopped'));
    L.push('  Map: ' + mapsLink(lat, lon));
    if (guard.anchor) {
      L.push('');
      L.push('TAKEN FROM');
      L.push('  ' + guard.anchor[0].toFixed(6) + ', ' + guard.anchor[1].toFixed(6) + '  ' + mapsLink(guard.anchor[0], guard.anchor[1]));
      if (guard.state === 'stolen') L.push('  Distance from there now: about ' + Math.round(guard.dist) + ' m');
    }
    if (a.trail) {
      L.push('');
      L.push('ROUTE TAKEN BEFORE IT STOPPED (recorded by the tracker, ' + fmtDist(a.trailM) + ')');
      // At most 12 evenly spaced points, oldest first
      const stepN = Math.max(1, Math.ceil(a.trail.length / 12));
      a.trail.filter((p, i) => i % stepN === 0).forEach((p) =>
        L.push('  ' + clock(a.ts - p[2] * 1000) + '  ' + p[0].toFixed(6) + ', ' + p[1].toFixed(6)));
      L.push('  ' + clock(a.ts) + '  ' + a.lat.toFixed(6) + ', ' + a.lon.toFixed(6) + '  (stopped here)');
      L.push('  Start of route: ' + mapsLink(a.trail[0][0], a.trail[0][1]));
    }
    const pts = recentFixes.filter((p) => p.ts >= a.ts).slice(-5);
    if (pts.length > 1) {
      L.push('');
      L.push('RECENT POSITIONS (newest last)');
      pts.forEach((p) => L.push('  ' + clock(p.ts) + '  ' + p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)));
    }
    L.push('');
    L.push('The tracker is still reporting. The owner can give live updates from the Locate app.');
    return L.join('\n');
  }

  function policeRefresh() {
    if (!policeAlert) return;
    const el2 = $('policePreview');
    // Do not rewrite the text under someone who is selecting it
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel) && el2.contains(sel.anchorNode)) return;
    el2.textContent = buildPoliceReport(policeAlert);
  }

  function openPolice(a) {
    if (!a || a.lat == null) return;
    policeAlert = a;
    $('pReg').value = profile.reg; $('pDesc').value = profile.desc;
    $('pPhone').value = profile.phone; $('pEmail').value = profile.email;
    $('policeCall').textContent = '📞 Call ' + EMERGENCY_NUMBER;
    $('policeCall').href = 'tel:' + EMERGENCY_NUMBER;
    $('policeMark').textContent = a.reported ? '✓ Marked as reported ' + clock(a.reported) : '✓ I have reported it - mark as reported';
    $('policeMark').disabled = !!a.reported;
    $('policeFeedback').textContent = '';
    $('policeDialog').hidden = false;
    $('appRoot').inert = true;
    policeRefresh();
    clearInterval(policeTimer);
    policeTimer = setInterval(policeRefresh, 2000);
    $('policeClose').focus();
  }
  function closePolice() {
    clearInterval(policeTimer); policeTimer = null;
    policeAlert = null;
    $('policeDialog').hidden = true;
    if (session) $('appRoot').inert = false;
  }

  function initPolice() {
    ['pReg', 'pDesc', 'pPhone', 'pEmail'].forEach((id) => $(id).addEventListener('input', () => {
      profile = { reg: $('pReg').value.trim(), desc: $('pDesc').value.trim(), phone: $('pPhone').value.trim(), email: $('pEmail').value.trim() };
      if (session) store.set(ukey('locate.profile'), profile);
      policeRefresh();
    }));
    $('policeClose').addEventListener('click', closePolice);
    $('policeDialog').addEventListener('click', (e) => { if (e.target === $('policeDialog')) closePolice(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && policeAlert) closePolice(); });
    $('bannerPolice').addEventListener('click', () => openPolice(bannerAlert));

    $('policeCopy').addEventListener('click', async () => {
      const text = buildPoliceReport(policeAlert);
      try {
        await navigator.clipboard.writeText(text);
        feedback('policeFeedback', 'ok', 'Report copied. Paste it into a message or email.');
      } catch (e) {
        // Clipboard is blocked on plain http:// links: select the text so Ctrl+C / long-press works
        const r = document.createRange(); r.selectNodeContents($('policePreview'));
        const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r);
        feedback('policeFeedback', 'wait', 'The report is selected below. Press Ctrl+C (or long-press → Copy).');
      }
    });
    $('policeEmail').addEventListener('click', () => {
      const text = buildPoliceReport(policeAlert);
      const subject = 'Vehicle theft report ' + policeRef(policeAlert) + (profile.reg ? ' - ' + profile.reg : '');
      location.href = 'mailto:' + encodeURIComponent(profile.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text);
      feedback('policeFeedback', 'wait', 'Your email app should open with the report. It is sent only when you press Send there.');
    });
    $('policeDownload').addEventListener('click', () => {
      const blob = new Blob([buildPoliceReport(policeAlert)], { type: 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'theft-report-' + policeRef(policeAlert) + '.txt';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      feedback('policeFeedback', 'ok', 'Report downloaded as a text file.');
    });
    $('policeMark').addEventListener('click', () => {
      if (!policeAlert) return;
      policeAlert.reported = Date.now();
      policeAlert.reportRef = policeRef(policeAlert);
      saveAlerts();
      $('policeMark').textContent = '✓ Marked as reported ' + clock(policeAlert.reported);
      $('policeMark').disabled = true;
      feedback('policeFeedback', 'ok', 'Marked as reported to the police. Reference ' + policeAlert.reportRef + '.');
      renderAll();
    });
  }

  // ------------------------------------------------------------------ sign-in and roles
  // "customer" = vehicle owner (map, alerts, controls); "admin" = control room
  // (everything, incl. Compare, broker settings, Demo mode).
  // Accounts, the password check and the sign-in form live in auth.js, which the
  // phone tracker shares. It is a demo gate, NOT real security (see auth.js).
  const Auth = window.LocateAuth;
  const ROLE_LABEL = Auth.ROLE_LABEL;
  let session = null;       // { role, user, name, ts }
  let loginUi = null;

  function showLogin() {
    session = null;
    closePolice();
    Auth.clearSession();
    disconnect();
    stopAlarm();
    stopMyLocation();
    setConn('offline');
    delete document.body.dataset.role;
    $('appRoot').inert = true;
    loginUi.show();
  }

  function enterApp(sess, info) {
    session = sess;
    Auth.saveSession(session);
    document.body.dataset.role = session.role;
    $('userChip').textContent = session.name || ROLE_LABEL[session.role];
    $('accountText').textContent = 'Signed in as ' + (session.name || session.user) + ' (' + session.user + ', ' + ROLE_LABEL[session.role] + ').' +
      (session.role === 'customer' ? ' Control-room tools are hidden in this view.' : '');
    loginUi.hide();
    $('appRoot').inert = false;
    document.title = 'Locate · ' + (session.name || session.user);   // tells two tabs apart
    // This person's own alerts, map state and vehicle (kept apart from other accounts)
    loadUserData();
    resetView();
    if (veh && veh.lat != null) mapUpdateVehicle(true);
    // LOCATE node: the armed state lives in this app, so restore it
    if (isNode() && state.nodeArmed) { guard = { state: 'armed', anchor: [veh.lat, veh.lon], dist: 0 }; mapGuard(); }
    fillSettingsForm();
    ensureVehicle(true);
    if (info && info.created) {
      // New account: start by adding a vehicle
      showTab('vehicles');
      toast('Welcome, ' + (session.name || session.user) + '! Add your first vehicle.');
      setTimeout(() => { try { $('vehName').focus(); } catch (e) { /* ignore */ } }, 300);
    } else {
      showTab('map');
    }
    renderAll();
    connect();
    startMyLocation();     // the owner's own position = centre of the Mode B safe zone
  }

  function fillPwForm() {
    const sel = $('pwRole');
    sel.textContent = '';
    Auth.accounts.forEach((a) => {
      const o = el('option', null, a.name + ' (' + a.user + ', ' + ROLE_LABEL[a.role] + ')');
      o.value = a.user;
      sel.appendChild(o);
    });
  }

  function initAuth() {
    loginUi = Auth.attachLogin({
      hints: {
        customer: 'Customer: see your vehicle on the map, get theft alerts, arm and disarm it.',
        admin: 'Control admin: everything, including the comparison screen, connection settings and Demo mode.'
      },
      onSignedIn: enterApp
    });
    $('logoutBtn').addEventListener('click', showLogin);
    $('logoutBtn2').addEventListener('click', showLogin);

    // Admin: change any account's password (saved in this browser)
    fillPwForm();
    $('pwForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!session || session.role !== 'admin') return;
      const acc = Auth.accounts.find((a) => a.user === $('pwRole').value), pw = $('pwNew').value;
      if (!acc) return;
      if (pw.length < 6) { feedback('pwFeedback', 'fail', 'The password needs 6 characters or more.'); return; }
      Auth.setPassword(acc.user, pw);
      $('pwNew').value = '';
      feedback('pwFeedback', 'ok', 'New password saved for ' + acc.name + ' on this device.');
    });
    $('pwReset').addEventListener('click', () => {
      if (!session || session.role !== 'admin') return;
      Auth.resetPasswords();
      feedback('pwFeedback', 'ok', 'All accounts are back to their demo passwords.');
    });

    const saved = Auth.savedSession();
    if (saved) enterApp(saved); else showLogin();
  }

  function renderAll() {
    renderStatus();
    renderAlerts();
    renderCompare();
    renderControls();
    renderVehicles();
  }
  // A customer sees alerts of their own vehicles; the control room sees all
  function alertVisible(a) {
    if (!a.vid || !session || session.role === 'admin') return true;
    return myVehicles().some((v) => v.id === a.vid);
  }

  function init() {
    applyTheme();
    initMap();
    initChart();
    initControls();
    initSettings();
    initPhoneApp();
    initNotify();
    initPolice();
    initVehicles();

    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
      alertFilter = c.dataset.filter;
      document.querySelectorAll('.chip').forEach((x) => {
        x.classList.toggle('active', x === c);
        x.setAttribute('aria-pressed', String(x === c));
      });
      renderAlerts();
    }));
    $('themeBtn').addEventListener('click', () => {
      settings.theme = settings.theme === 'light' ? 'dark' : 'light';
      saveSettings();
      applyTheme();
    });
    $('bannerShow').addEventListener('click', () => { if (bannerAlert) showOnMap(bannerAlert); });
    $('bannerClose').addEventListener('click', () => { $('alertBanner').hidden = true; stopAlarm(); });
    $('bannerMute').addEventListener('click', () => { stopAlarm(); toast('Alarm silenced. Tracking continues.'); });
    $('guardBtn').addEventListener('click', () => setArmed(!isArmed()));   // ESP32 node only
    document.querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => {
      state.zoneM = +b.dataset.zone;
      saveState();
      renderZone();
      renderStatus();
      toast('Safe zone: theft alert beyond ' + zoneM() + ' m');
    }));
    $('mapModeA').addEventListener('click', () => requestMode('A'));
    $('mapModeB').addEventListener('click', () => requestMode('B'));
    $('armBtn').addEventListener('click', () => (isNode() ? setArmed(true) : requestMode('A')));
    $('disarmBtn').addEventListener('click', () => (isNode() ? setArmed(false) : requestMode('B')));
    $('recenterBtn').addEventListener('click', () => { if (map && veh) { map.flyTo([veh.lat, veh.lon], 18, { duration: 0.8 }); setFollow(true); } });
    $('clearRouteBtn').addEventListener('click', () => {
      trailPts = veh && veh.lat != null ? [[veh.lat, veh.lon]] : [];
      routeMetres = 0;
      if (trail) trail.setLatLngs(trailPts);
      showSilentRoute(null); clearFrozen();
      renderStatus();
    });
    $('modeBtnA').addEventListener('click', () => requestMode('A'));
    $('modeBtnB').addEventListener('click', () => requestMode('B'));
    $('resetBtn').addEventListener('click', () => {
      state.counts = { A: 0, B: 0 };
      stamps = { A: [], B: [] };
      saveState();
      renderCompare();
    });

    renderAll();
    initAuth();     // shows the sign-in page, or resumes a saved session and connects
    let ticks = 0;
    setInterval(() => {
      nodeTick(); renderStatus(); renderCompare();
      // refresh the "last report … ago" lines now and then (not while typing)
      if (++ticks % 5 === 0 && activeTab === 'vehicles' && !/INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '')) renderVehicles();
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
