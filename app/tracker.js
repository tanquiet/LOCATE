/* Locate phone tracker: the phone plays the part of the tracker in the car.

   Two modes:
     A  Always-on : sends its position every 1.5 s, moving or not (what normal
                    trackers do - easy for a thief's RF detector to find).
     B  Locate    : armed and SILENT while parked - nothing is sent. The moment
                    it starts moving it alerts the owner's phone, then sends its
                    position every second until it has stopped for 5 s; then one
                    "stopped here" alert and it is silent and armed again.

   Movement = motion sensor (sustained shaking, so one bump is ignored) or GPS
   speed. Indoors, the Moving / Stopped buttons force it.
   Position = GPS smoothed with a small Kalman filter, so the dot holds still
   while the phone is still.

   Broker, topic prefix and vehicle ID come from the Locate app's saved
   settings (same site = same localStorage). */
(function () {
  'use strict';

  const MODE_A_PERIOD_MS = 1500;
  const DWELL_MS = 5000;           // Mode B: still this long after a theft = "stopped here"
  const ARM_MS = 3000;             // Mode B: still this long to arm
  const TRACK_MS = 1000;           // Mode B: position while it is being moved
  const GPS_MOVING_KMH = 5;
  const FALLBACK = { lat: 12.9716, lon: 77.5946 };

  const $ = (id) => document.getElementById(id);
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  // Same defaults as app.js
  const s = Object.assign({
    broker: 'wss://broker.hivemq.com', port: 8884, username: '', password: '',
    prefix: 'locate-k7q2m9', vehicleId: 'car1', theme: 'dark'
  }, load('locate.settings', {}));
  document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';

  // Pairing: this tracker belongs to ONE vehicle, chosen with the code from the
  // Locate app. "K7Q2M9" -> channel "v-k7q2m9"; "CAR1" -> the shared demo car.
  function codeToId(c) {
    c = String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c === 'CAR1') return 'car1';
    return /^[A-Z0-9]{6}$/.test(c) ? 'v-' + c.toLowerCase() : null;
  }
  let pairing = load('locate.tracker.pair', null);
  const urlPair = new URLSearchParams(location.search).get('pair');
  if (urlPair !== null) {
    const id = codeToId(urlPair);
    if (id) { pairing = { id: id, code: urlPair.trim().toUpperCase() }; save('locate.tracker.pair', pairing); }
    history.replaceState(null, '', location.pathname);            // keep the code out of the address bar
  }
  if (pairing) s.vehicleId = pairing.id;
  let vehicleName = pairing && pairing.name ? pairing.name : null;
  const topic = (leaf) => s.prefix + '/' + s.vehicleId + '/' + leaf;

  // source: 'motion' (auto: motion sensor + GPS), 'move' (forced), 'stop' (forced)
  const t = Object.assign({ mode: 'A', source: 'motion' }, load('locate.tracker.v2', {}));
  if (t.mode !== 'A' && t.mode !== 'B') t.mode = 'A';                     // older versions had more modes
  if (t.source !== 'move' && t.source !== 'stop') t.source = 'motion';
  const persist = () => save('locate.tracker.v2', { mode: t.mode, source: t.source });

  let client = null;
  let txCount = 0;
  const t0 = Date.now();

  // ---------------------------------------------------------------- log + lamp
  function log(msg) {
    const el = $('log');
    const line = new Date().toLocaleTimeString() + '  ' + msg + '\n';
    el.textContent = (line + el.textContent).slice(0, 6000);
  }
  let lampTimer = null;
  function flash() {
    $('txLamp').classList.add('on');
    clearTimeout(lampTimer);
    lampTimer = setTimeout(() => $('txLamp').classList.remove('on'), 300);
  }

  // ---------------------------------------------------------------- motion sensor
  // The size of the shaking (gravity removed) is smoothed. It only counts as
  // movement after it has stayed above the line for MOTION_CONFIRM_MS (a few
  // walking steps), so a single bump or putting the phone down is ignored.
  const MOTION_LINE = 0.6;         // m/s², smoothed
  const MOTION_CONFIRM_MS = 600;
  const MOTION_GAP_MS = 450;       // a pause longer than this restarts the confirmation
  const MOTION_HOLD_MS = 1500;     // stays "moving" this long after the last confirmed shake
  let motionLevel = 0, motionEvents = 0, gravityMag = null;
  let burstStart = 0, lastAbove = 0, motionLastActive = 0;

  function onMotion(e) {
    let a = null;
    const acc = e.acceleration;
    if (acc && acc.x != null && acc.y != null && acc.z != null) {
      a = Math.hypot(acc.x, acc.y, acc.z);               // gravity already removed by the phone
    } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
      const g = e.accelerationIncludingGravity;
      const m = Math.hypot(g.x, g.y, g.z);
      gravityMag = gravityMag == null ? m : gravityMag * 0.95 + m * 0.05;
      a = Math.abs(m - gravityMag);
    }
    if (a == null || !isFinite(a)) return;
    motionEvents++;
    motionLevel = motionLevel * 0.85 + a * 0.15;
    const now = Date.now();
    if (motionLevel >= MOTION_LINE * sensBoost) {
      if (!burstStart || now - lastAbove > MOTION_GAP_MS) burstStart = now;
      lastAbove = now;
      if (now - burstStart >= MOTION_CONFIRM_MS) motionLastActive = now;
    }
  }
  const sensorMoving = () => Date.now() - motionLastActive < MOTION_HOLD_MS;
  const hasSensor = () => motionEvents > 0;

  function startMotion() {
    window.addEventListener('devicemotion', onMotion);
    setTimeout(() => {
      if (hasSensor()) { log('motion sensor on'); return; }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        $('motionPerm').hidden = false;
        log('tap "Allow motion sensor"');
      } else {
        log('no motion sensor readings - GPS and the Moving/Stopped buttons still work');
      }
    }, 3000);
  }

  // ---------------------------------------------------------------- GPS (smoothed)
  let fix = null;            // smoothed: {lat, lon, acc (filter estimate), rawAcc, ts}
  let variance = -1;         // filter variance, m²
  let gpsSpeed = 0;          // km/h
  let heading = null;        // degrees, only while really moving
  let speedRef = null;       // older smoothed point, for computing speed

  function metres(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function onPos(p) {
    const c = p.coords, now = Date.now();
    const rawAcc = Math.max(c.accuracy || 50, 3);
    if (rawAcc > 100 && fix) return;                     // useless reading, keep the last good one
    const phoneSpeed = (typeof c.speed === 'number' && c.speed >= 0 && isFinite(c.speed)) ? c.speed : null;

    // Kalman filter. q = how far the phone may have really moved per second.
    // Still (motion sensor quiet, no GPS speed) -> tiny q -> the position holds steady.
    const reallyMoving = sensorMoving() || (phoneSpeed !== null && phoneSpeed > 1) || t.source === 'move';
    const q = reallyMoving ? 4 : (hasSensor() ? 0.3 : 1.5);
    let lat, lon;
    if (variance < 0 || !fix) {
      lat = c.latitude; lon = c.longitude; variance = rawAcc * rawAcc;
      log('GPS fix: ' + lat.toFixed(5) + ', ' + lon.toFixed(5) + ' (±' + Math.round(rawAcc) + ' m)');
    } else {
      const dt = Math.min(10, Math.max(0, (now - fix.ts) / 1000));
      variance += dt * q * q;
      const k = variance / (variance + rawAcc * rawAcc);
      lat = fix.lat + k * (c.latitude - fix.lat);
      lon = fix.lon + k * (c.longitude - fix.lon);
      variance = (1 - k) * variance;
    }
    fix = { lat: lat, lon: lon, acc: Math.sqrt(variance), rawAcc: rawAcc, ts: now };

    // Speed: the phone's own value when it gives one, otherwise from the smoothed track
    if (phoneSpeed !== null) {
      gpsSpeed = phoneSpeed * 3.6;
    } else if (speedRef && now - speedRef.ts >= 2500 && rawAcc <= 25) {
      gpsSpeed = metres(speedRef, fix) / ((now - speedRef.ts) / 1000) * 3.6;
    } else if (rawAcc > 25) {
      gpsSpeed = 0;
    }
    if (!speedRef || now - speedRef.ts >= 2500) speedRef = { lat: lat, lon: lon, ts: now };
    heading = (typeof c.heading === 'number' && isFinite(c.heading) && gpsSpeed > 2) ? Math.round(c.heading) : null;
    $('gpsWarn').hidden = true;
  }

  function onPosErr(err) {
    const w = $('gpsWarn');
    w.hidden = false;
    if (err.code === 1) {
      w.innerHTML = '<strong>Location is blocked.</strong> Allow location for this page (tap the icon left of the address bar → Permissions → Location), then reload. ' +
        (window.isSecureContext ? '' : 'Phones only share location with <strong>https://</strong> pages; open the https link from the README.');
    } else {
      w.innerHTML = '<strong>No GPS fix yet.</strong> Go near a window or outside. Until then the Bengaluru test location is sent.';
    }
    log('GPS: ' + (err.message || 'error ' + err.code));
  }

  function startGps() {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      onPosErr({ code: 1, message: 'location needs an https:// page' });
      return;
    }
    navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  const gpsFresh = () => (fix && Date.now() - fix.ts <= 5000 ? gpsSpeed : 0);
  const gpsMoving = () => gpsFresh() >= GPS_MOVING_KMH && fix && fix.rawAcc <= 30;

  function moving() {
    if (t.source === 'move') return true;
    if (t.source === 'stop') return false;
    return sensorMoving() || gpsMoving();
  }
  function speed() {
    if (t.source === 'move') return 40;
    if (t.source === 'stop') return 0;
    const g = gpsFresh();
    if (moving()) return Math.max(g, 4);                 // sensor says walking but GPS has no speed yet
    return 0;
  }
  function position() {
    // A phone standing still often sends no new readings, so the last fix stays "live" for 2 min
    if (fix) return { lat: fix.lat, lon: fix.lon, live: Date.now() - fix.ts < 120000 };
    return { lat: FALLBACK.lat, lon: FALLBACK.lon, live: false };
  }

  // ---------------------------------------------------------------- sending
  function publish(leaf, body, retain) {
    if (!client || !client.connected) return false;
    body.tx_count = txCount + 1;
    body.ts = Date.now();
    client.publish(topic(leaf), JSON.stringify(body), { qos: leaf === 'alert' ? 1 : 0, retain: !!retain });
    txCount++;
    flash();
    $('vTx').textContent = txCount;
    if (body.type !== 'ping') log('SENT #' + txCount + ' ' + leaf + ' ' + (body.type || ''));
    return true;
  }
  function sendPosition(leaf, type) {
    const p = position();
    const body = {
      id: s.vehicleId, mode: t.mode, type: type,
      lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6),
      speed_kmh: Math.round(speed() * 10) / 10,
      uptime_s: Math.round((Date.now() - t0) / 1000),
      link: 'phone', gps_fix: p.live,
      acc_m: fix ? Math.max(3, Math.round(fix.acc)) : undefined,
      moving: moving()
    };
    if (heading !== null) body.heading = heading;
    if (t.mode === 'B' && parked && fix) body.dist_m = Math.round(metres(parked, fix));
    return publish(leaf, body, false);
  }
  function sendStatus(type) {
    const body = {
      id: s.vehicleId, mode: t.mode, type: type || 'mode_change',
      uptime_s: Math.round((Date.now() - t0) / 1000), link: 'phone'
    };
    if (type === 'armed' && parked) { body.lat = +parked.lat.toFixed(6); body.lon = +parked.lon.toFixed(6); }
    return publish('status', body, true);
  }

  // ---------------------------------------------------------------- mode logic
  // Mode B (Locate, armed):
  //   arming  - a few seconds to put the phone down; nothing is sent
  //   armed   - SILENT. Watching the motion sensor and GPS.
  //   stolen  - it moved: ONE alarm to the owner's phone, then the position every
  //             second while moving. Stopped for 5 s: one "stopped here" alert,
  //             then silent and armed again where it stopped.
  let lastPing = 0;
  let bState = 'arming', armAt = 0, armStuckAt = 0;
  let parked = null;         // where it was armed (distance is measured from here)
  let anchor = null;         // where it was last still (to notice a smooth ride with no shaking)
  let awayCount = 0, moveSent = false, stillSince = 0;
  let sensBoost = 1;         // raised if this phone's sensor never reads "still"

  function startArming(why) {
    bState = 'arming';
    armAt = Date.now() + ARM_MS;
    armStuckAt = Date.now();
    parked = null; anchor = null; awayCount = 0;
    log('LOCATE arming - leave the phone still (' + why + ')');
    sendStatus('arming');
  }
  function armHere(silent) {
    bState = 'armed';
    anchor = fix ? { lat: fix.lat, lon: fix.lon } : null;
    if (!silent || !parked) parked = anchor;
    awayCount = 0; moveSent = false; stillSince = 0;
    log('LOCATE ARMED' + (anchor ? ' at ' + anchor.lat.toFixed(5) + ', ' + anchor.lon.toFixed(5) : ' (no GPS fix yet)') + ' - silent');
    if (!silent) sendStatus('armed');
  }

  function setMode(m, why) {
    if (m !== 'A' && m !== 'B') return;
    if (m === t.mode) return;
    t.mode = m;
    persist();
    lastPing = Date.now();
    log('MODE ' + (m === 'A' ? 'A Always-on' : 'B Locate') + ' - ' + why);
    if (m === 'B') startArming(why); else sendStatus();
    render();
  }

  function leftAnchor() {
    if (!anchor || !fix || fix.rawAcc > 30) return false;
    return metres(anchor, fix) > Math.max(25, 2.5 * fix.rawAcc);
  }

  function tickLocate(now, mv) {
    if (bState === 'arming') {
      if (sensorMoving() && t.source === 'motion') {
        armAt = now + ARM_MS;
        if (now - armStuckAt > 8000) {
          // Reads "moving" for 8 s while the phone should be still: the sensor is too jumpy here
          sensBoost = Math.max(sensBoost * 1.5, motionLevel / MOTION_LINE * 1.8);
          armStuckAt = now; motionLastActive = 0; burstStart = 0;
          log('this phone\'s motion sensor is noisy - movement line raised');
        }
      }
      if (t.source === 'move') armAt = now + ARM_MS;   // forced "Moving": wait for Auto / Stopped
      if (now >= armAt) armHere(false);              // arms without a GPS fix too (indoors)
      return;
    }
    if (bState === 'armed') {
      if (fix && !anchor) anchor = { lat: fix.lat, lon: fix.lon };
      if (anchor && !parked) parked = anchor;
      awayCount = leftAnchor() ? awayCount + 1 : 0;
      if (mv || (t.source !== 'stop' && awayCount >= 2)) {
        bState = 'stolen'; moveSent = false; stillSince = 0;
        log('MOVEMENT DETECTED - alerting the owner');
      }
      return;
    }
    // stolen
    if (!moveSent) {
      if (sendPosition('alert', 'theft_move')) { moveSent = true; lastPing = now; log('owner alerted - tracking live'); }
      return;
    }
    if (mv) {
      stillSince = 0;
      if (now - lastPing >= TRACK_MS) { lastPing = now; sendPosition('ping', 'track'); }
    } else {
      if (!stillSince) stillSince = now;
      if (now - stillSince >= DWELL_MS && sendPosition('alert', 'theft_stop')) {
        log('stopped for 5 s - location sent, silent and armed again here');
        armHere(true);
      }
    }
  }

  function tick() {
    const now = Date.now();
    if (t.mode === 'A') {
      if (now - lastPing >= MODE_A_PERIOD_MS && client && client.connected) {
        lastPing = now;
        sendPosition('ping', 'ping');
      }
    } else {
      tickLocate(now, moving());
    }
    render();
  }

  // ---------------------------------------------------------------- UI
  const STATE_TEXT = {
    A: ['MODE A · ALWAYS-ON', 'Sending every 1.5 s. Easy for a thief\'s detector to find.'],
    arming: ['MODE B · ARMING…', 'Put the phone down and leave it still for a few seconds.'],
    armed: ['MODE B · ARMED', 'Silent - nothing is being sent. Moving it alerts the owner.'],
    stolen: ['MOVING · OWNER ALERTED', 'Sending the position every second until it stops.']
  };
  function render() {
    const key = t.mode === 'A' ? 'A' : bState;
    const st = STATE_TEXT[key];
    $('stateText').textContent = st[0];
    $('stateSub').textContent = st[1] + (key === 'stolen' && parked && fix ? ' ' + Math.round(metres(parked, fix)) + ' m from where it was parked.' : '');
    $('stateCard').dataset.state = key;
    $('modeA').setAttribute('aria-pressed', String(t.mode === 'A'));
    $('modeB').setAttribute('aria-pressed', String(t.mode === 'B'));
    $('srcMotion').setAttribute('aria-pressed', String(t.source === 'motion'));
    $('srcMove').setAttribute('aria-pressed', String(t.source === 'move'));
    $('srcStop').setAttribute('aria-pressed', String(t.source === 'stop'));
    const mv = moving();
    const why = t.source !== 'motion' ? 'forced' : sensorMoving() ? 'motion sensor' : gpsMoving() ? 'GPS' : hasSensor() ? 'sensor + GPS' : 'GPS';
    $('vSpeed').textContent = (mv ? 'MOVING' : 'still') + ' · ' + speed().toFixed(1) + ' km/h (' + why + ')';
    $('vAcc').textContent = fix ? '±' + Math.round(fix.rawAcc) + ' m' + (fix.rawAcc > 30 ? ' (weak)' : '') : '-';
    const p = position();
    $('vPos').textContent = p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) + (fix ? '' : ' (test location)');
  }

  function setConn(state, text) {
    $('conn').dataset.state = state;
    $('connText').textContent = text;
  }

  function connect() {
    if (typeof mqtt === 'undefined') { setConn('offline', 'Needs internet'); log('connection library did not load - check internet'); return; }
    let raw = String(s.broker || '').trim();
    if (!/^wss?:\/\//i.test(raw)) raw = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + raw;
    let url;
    try { const u = new URL(raw); if (!u.port && s.port) u.port = String(s.port); if (!u.pathname || u.pathname === '/') u.pathname = '/mqtt'; url = u.toString(); }
    catch (e) { setConn('offline', 'Check Settings'); return; }
    $('vTopic').textContent = topic('…');
    client = mqtt.connect(url, {
      username: s.username || undefined, password: s.password || undefined,
      clientId: 'locate-phone-' + Math.random().toString(16).slice(2, 10),
      keepalive: 20, reconnectPeriod: 1500, connectTimeout: 8000, clean: true
    });
    client.on('connect', () => {
      setConn('online', 'Connected');
      log('connected');
      client.subscribe([topic('config'), s.prefix + '/registry/' + s.vehicleId]);
      if (t.mode === 'A') sendStatus();
      else sendStatus(bState === 'arming' ? 'arming' : 'armed');
    });
    client.on('reconnect', () => setConn('reconnecting', 'Reconnecting…'));
    client.on('error', (e) => log('connection error: ' + (e && e.message)));
    client.on('message', (tp, payload) => {
      if (tp.indexOf('/registry/') >= 0) {
        // The owner's record of this vehicle: its name (or empty = the vehicle was removed)
        let r = null; try { r = payload.length ? JSON.parse(payload.toString()) : null; } catch (e) { return; }
        if (r && typeof r.name === 'string') {
          vehicleName = r.name.slice(0, 30);
          pairing.name = vehicleName; save('locate.tracker.pair', pairing);
          $('pairWarn').hidden = true;
          log('paired to ' + vehicleName + (r.ownerName ? ' (' + r.ownerName + ')' : ''));
        } else if (!r) {
          $('pairWarn').hidden = false;
          $('pairWarn').innerHTML = '<strong>This vehicle was removed by its owner.</strong> Tap Unpair and pair again with a new code.';
        }
        showName();
        return;
      }
      let m; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
      if (m.mode === 'A' || m.mode === 'B') setMode(m.mode, 'from the app');
      if (m.rearm === true && t.mode === 'B') { startArming('from the app'); render(); }
      if (m.buzzer === true && navigator.vibrate) { try { navigator.vibrate([200, 150, 200, 150, 200]); } catch (e) { /* ignore */ } }
      if (typeof m.buzzer === 'boolean') log('buzzer ' + (m.buzzer ? 'ON' : 'OFF') + ' from the app');
      if (typeof m.stolen === 'boolean') log('reported stolen = ' + m.stolen);
    });
  }

  // Keep the screen on: most phones stop GPS and motion readings once the screen sleeps
  let lock = null;
  async function wake() {
    if (lock || document.visibilityState !== 'visible') return;
    if (!('wakeLock' in navigator)) { $('vWake').textContent = 'not supported - raise screen timeout'; return; }
    try {
      lock = await navigator.wakeLock.request('screen');
      $('vWake').textContent = 'on';
      lock.addEventListener('release', () => { lock = null; $('vWake').textContent = 'off (page hidden)'; });
    } catch (e) { $('vWake').textContent = 'blocked'; }
  }

  // ---------------------------------------------------------------- wiring
  $('modeA').addEventListener('click', () => setMode('A', 'tapped on the phone'));
  $('modeB').addEventListener('click', () => setMode('B', 'tapped on the phone'));
  const setSource = (src) => { t.source = src; persist(); log('movement: ' + src); render(); };
  $('srcMotion').addEventListener('click', () => setSource('motion'));
  $('srcMove').addEventListener('click', () => setSource('move'));
  $('srcStop').addEventListener('click', () => setSource('stop'));
  $('motionPerm').addEventListener('click', async () => {
    try {
      const r = await DeviceMotionEvent.requestPermission();   // iPhone only; must be inside a tap
      log('motion sensor permission: ' + r);
      if (r === 'granted') $('motionPerm').hidden = true;
    } catch (e) { log('motion sensor permission failed: ' + e.message); }
  });
  document.addEventListener('visibilitychange', wake);

  // ---------------------------------------------------------------- pairing
  // Until it is paired nothing runs: no GPS, no motion sensor, no connection.
  let started = false;

  function showName() {
    const name = vehicleName || (s.vehicleId === 'car1' ? 'Demo car' : 'code ' + (pairing ? pairing.code : ''));
    $('userChip').textContent = name;
    $('vehName').textContent = name;
  }

  function start() {
    $('login').hidden = true;
    $('appRoot').inert = false;
    showName();
    if (started) return;
    started = true;
    log('paired to "' + s.vehicleId + '", prefix "' + s.prefix + '"');
    persist();
    if (t.mode === 'B') { bState = 'arming'; armAt = Date.now() + ARM_MS; armStuckAt = Date.now(); }
    render();
    startGps();
    startMotion();
    connect();
    wake();
    setInterval(tick, 200);
    // The vehicle's name comes from the owner's vehicle list (retained on the broker)
    if (s.vehicleId !== 'car1') setTimeout(() => {
      if (!vehicleName && client && client.connected) {
        $('pairWarn').hidden = false;
        $('pairWarn').innerHTML = '<strong>Code ' + (pairing ? pairing.code : '') + ' was not found.</strong> Check it in the Locate app (Vehicles → Pair tracker). It still sends, but nobody may be watching.';
      }
    }, 8000);
  }

  function pairWith(code, name) {
    const id = codeToId(code);
    if (!id) { $('pairError').textContent = '✕ The code has 6 letters and numbers, e.g. K7Q2M9.'; return; }
    pairing = { id: id, code: String(code).trim().toUpperCase() };
    const quick = QUICK.find((q) => q[0] === pairing.code);
    if (!name && quick) name = quick[2];                        // a demo code typed by hand
    if (name) { pairing.name = name; vehicleName = name; }
    save('locate.tracker.pair', pairing);
    s.vehicleId = id;
    start();
  }

  $('pairForm').addEventListener('submit', (e) => { e.preventDefault(); pairWith($('pairInput').value); });
  $('pairInput').addEventListener('input', () => { $('pairError').textContent = ''; });

  // Quick pair: the demo accounts' ready-made vehicles (same list as DEMO_FLEET in app.js)
  const QUICK = [
    ['CAR1', '🚗', 'Demo car', 'Shared, everyone sees it'],
    ['FAMILY', '🚗', 'Family Car', 'Demo Customer'],
    ['PRIYA1', '🛵', 'Priya\'s Activa', 'Priya Sharma'],
    ['ARJUN1', '🏍️', 'Arjun\'s Bullet', 'Arjun Rao'],
    ['ARJUN2', '🚗', 'Arjun\'s Swift', 'Arjun Rao'],
    ['MEERA1', '🚲', 'Meera\'s Cycle', 'Meera Nair']
  ];
  QUICK.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'demo-acc';
    const n = document.createElement('strong'); n.textContent = q[1] + ' ' + q[2];
    const c = document.createElement('span'); c.textContent = q[3];
    b.appendChild(n); b.appendChild(c);
    b.setAttribute('aria-label', 'Be the tracker for ' + q[2]);
    b.addEventListener('click', () => pairWith(q[0], q[2]));
    $('quickPair').appendChild(b);
  });
  // Unpair: forget the vehicle and reload, which stops GPS, sensors and the connection
  $('logoutBtn').addEventListener('click', () => {
    if (!confirm('Unpair this tracker? It stops sending until it is paired again.')) return;
    try { localStorage.removeItem('locate.tracker.pair'); } catch (e) { /* ignore */ }
    location.reload();
  });

  if (pairing) start();
  else { $('login').hidden = false; setTimeout(() => $('pairInput').focus(), 50); }
})();
