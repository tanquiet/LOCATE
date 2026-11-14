# Locate - hidden anti-theft vehicle tracker (hackathon demo)

Locate proves three things to the judges with an RC car and a cheap RF detector:

1. A normal always-on tracker is **easy to catch**: the detector beeps every 1-2 s.
2. Locate is **invisible to the same detector while the vehicle moves**: every radio is switched off.
3. Locate sends **one alert, with location, after the vehicle stops**.

```
firmware/locate_demo/locate_demo.ino   ESP32 firmware
firmware/locate_demo/config.h          all settings
firmware/locate_node/locate_node.ino   LOCATE node firmware (ESP32 + ICM-20948): see "LOCATE node" below
broker/mosquitto.conf                  MQTT broker config (laptop)
app/index.html, style.css, app.js      web app (no build step)
app/auth.js                            sign-in and dummy accounts (shared)
app/tracker.html, tracker.js           phone tracker: a phone stands in for the ESP32
app/sw.js, manifest.webmanifest        installable phone app + offline cache
app/serve_https.py                     local HTTPS server (phones need https for GPS)
start-demo.bat                         starts both local servers and opens the app
locate-app.zip                         the app packaged for a hosting site (two-phone demo)
DEMO.md                                one-page demo cheat sheet  <-- start here on demo day
```

**Running a demo? Open `DEMO.md`.** By default everything talks through the free HiveMQ public broker
(no Mosquitto needed); the Mosquitto setup in section 3 is the optional private alternative.

> **Status of this code:** the web app and phone tracker were tested end to end in a desktop browser
> (including one emulating a phone with simulated GPS and motion), not on a real handset. The firmware
> was written against the library versions listed below but has **not been compiled or run on
> hardware yet** - do the bring-up checklist before relying on it. The firmware knows Always-on and
> Locate; Guard mode exists only in the phone tracker.

---

## 1. Hardware

### Parts

- ESP32 DevKit (WROOM-32) on an RC car / rover
- u-blox NEO-M8N GPS module
- SIM800L **V2 (5 V board)** 2G modem + antenna, with an **Airtel or Vi 2G SIM** (Jio has no 2G). PIN lock off, data pack active.
- Logic-level P-channel MOSFET (AO3401A, IRLML6402, DMG2305UX or NDP6020P) + BC547 NPN, or a ready-made relay/MOSFET switch module
- 1000 uF / 10 V+ electrolytic capacitor (plus a 470 uF on the 5 V rail near the ESP32 is a good idea)
- 2S 18650 pack, fuse (3 A), switch, 3 A buck converter set to **5.0 V**
- TX LED + 220 ohm, optional active buzzer + BC547 + 1 k

### Wiring table

| From | To | Notes |
|---|---|---|
| 2S pack + | fuse -> switch -> buck IN+ | buck OUT set to **5.0 V before connecting anything** |
| Buck OUT 5 V | ESP32 `VIN`, GPS `VCC`, MOSFET source | common 5 V rail |
| Buck OUT GND | ESP32 `GND`, GPS `GND`, SIM800L `GND` | one common ground |
| GPS `TX` | ESP32 `GPIO16` (RX2) | 9600 baud |
| GPS `RX` | ESP32 `GPIO17` (TX2) | |
| SIM800L `TXD` | ESP32 `GPIO26` (RX1) | |
| SIM800L `RXD` | ESP32 `GPIO27` (TX1) | |
| SIM800L `RST` | ESP32 `GPIO25` | pulled low to reset, otherwise floating |
| SIM800L `VDD` | ESP32 `3V3` | logic-level reference only |
| SIM800L `5V` | MOSFET drain (switched 5 V) | **1000 uF across SIM800L 5V/GND, right at the module** |
| ESP32 `GPIO14` | 1 k -> BC547 base | HIGH = modem powered |
| ESP32 `GPIO33` | 220 ohm -> LED -> GND | TX LED, flashes on every transmission |
| ESP32 `GPIO2` | on-board LED | ON = Mode B (Locate), OFF = Mode A |
| ESP32 `GPIO0` | BOOT button (on board) | mode switch |
| ESP32 `GPIO13` | 1 k -> BC547 base; collector -> buzzer -; buzzer + -> 5 V | optional, off by default |

### MOSFET power switch (why and how)

Locate must cut the modem's **power**, not just put it to sleep: a registered modem still talks to
the network periodically (`AT+CFUN=0` and sleep modes are not enough for a demo with an RF detector).

High-side P-MOSFET with an NPN driver:

```
 5 V rail ----+-----------------+
              |                 |
            [10k]            Source
              |              P-MOSFET  (AO3401A / IRLML6402 / NDP6020P)
              +---- Gate ----+
              |              Drain ------+------ SIM800L 5V
          Collector                      |
 GPIO14 --[1k]-- Base  BC547          [1000 uF]
              |    |                     |
            [10k] Emitter               GND
              |    |
             GND  GND
```

- **Gate pull-up (10 k, gate to 5 V):** with nothing driving the gate, Vgs = 0 and the MOSFET is OFF.
  The modem stays off during ESP32 boot and reset.
- **Why the NPN driver:** the gate has to reach 5 V to switch the MOSFET fully off. An ESP32 pin only
  reaches 3.3 V, which would leave Vgs = -1.7 V (partly on) and push 5 V back into the GPIO. The
  BC547 does the level shift: GPIO14 HIGH -> BC547 on -> gate pulled to GND -> Vgs = -5 V -> modem powered.
- **Base pull-down (10 k, base to GND):** keeps the BC547 off while GPIO14 is floating at boot.
- **Use a logic-level MOSFET.** Parts like the IRF9540 need about -10 V and will starve the modem.
- **Capacitor on the modem side** of the MOSFET: it supplies the 2 A transmit bursts. Charging it at
  switch-on causes a short dip on the 5 V rail; if the ESP32 resets when the modem turns on, add
  470 uF at ESP32 `VIN` or a 100 nF capacitor from gate to source to slow the turn-on.
- **Relay / MOSFET module instead:** put it in the SIM800L 5 V line and drive it from GPIO14. If the
  module is active-low, set `MODEM_PWR_ON_LEVEL LOW` in `config.h`.

When the power is cut the firmware also parks the UART TX pin low and floats RST, so the modem
cannot stay half-alive through its I/O pins. Verify with a multimeter (checklist step 4).

---

## 2. Firmware

### Libraries (Arduino IDE 2.x -> Library Manager)

| Library | Version assumed |
|---|---|
| esp32 board package by Espressif (Boards Manager) | 3.x (2.0.x also works) |
| TinyGSM (Volodymyr Shymanskyy) | 0.12.0 |
| TinyGPSPlus (Mikal Hart) | 1.0.3 |
| PubSubClient (Nick O'Leary) | 2.8 |
| ArduinoJson (Benoit Blanchon) | 7.x |
| NimBLE-Arduino (h2zero) | 2.x - **only** if `OWNER_CHECK_ENABLED` is `true` |

### config.h

Open `firmware/locate_demo/config.h` and set:

1. `WIFI_SSID` / `WIFI_PASSWORD` - the phone hotspot (2.4 GHz).
2. `MQTT_WIFI_HOST` - the laptop's IP on that hotspot (`ipconfig` on Windows, `ip addr` on Linux), plus user/password.
3. `MQTT_GSM_HOST` / `MQTT_GSM_PORT` - how the tracker reaches the **same** broker over mobile data (section 3).
4. `GPRS_APN` - `airtelgprs.com` for Airtel, `www` for Vi.
5. Leave the rest at the defaults: `SPEED_THRESHOLD_KMH 5`, `DWELL_MS 5000`, `MODE_A_PERIOD_MS 1500`,
   `MODE_B_LINK LINK_WIFI` (fast stage demo), `OWNER_CHECK_ENABLED false`.

If GSM is unreliable at the venue, set `MODE_A_LINK LINK_WIFI`: Mode A then pings over WiFi only.
A WiFi burst is weaker than a GSM burst, so hold the detector closer.

### Upload

1. Board: **ESP32 Dev Module**, pick the COM port.
2. Open `locate_demo.ino`, press Upload. If it sticks on "Connecting...", hold BOOT until it starts.
3. Open Serial Monitor at **115200**. Every radio ON/OFF and every transmission is logged.

### How the two modes behave

**Mode A - always-on tracker.** Modem powered, registered and GPRS-attached the whole time. Publishes
a ping every 1.5 s, moving or not. If GSM is unavailable it logs a warning, falls back to WiFi at the
same rate and retries GSM every 2 minutes.

**Mode B - Locate.**

- Nothing is transmitted until the vehicle has moved at least once (so switching to Mode B while parked does not fire an alert).
- Speed >= 5 km/h: modem power cut by the MOSFET, WiFi off, Bluetooth off (or passive scan only).
- Speed < 5 km/h for 5 s: wait a random 0-3 s, bring up the link (`MODE_B_LINK`), publish **one**
  alert, listen about 1 s for commands, switch everything off again.
- Only one alert per stop. Driving again re-arms it. If the car moves during link bring-up, the radio is cut immediately.

**Silent route (breadcrumb trail).** Silent does not mean blind. While Mode B is silent the tracker
keeps storing its GPS position (a GPS receiver transmits nothing): one point every 2 s, at least 10 m
apart, up to 30 points. When the buffer fills, every second point is dropped and recording slows
down, so a trip of any length fits. The whole route is sent **inside the one stop alert** as
`"trail": [[lat, lon, seconds_before_the_alert], ...]` (oldest first). The app draws it as a dashed
amber line from an **S** marker ("went silent here") to the stop, shows its length in the banner, the
Alerts list and the Compare screen, and adds it to the police report. Settings are `TRAIL_*` in
`config.h`. Limits: the route lives in RAM, so a power cut loses it; without a GPS fix (indoors, or
when using simulated speed) nothing is recorded and the alert is sent without a route. The phone
tracker and Demo mode do the same thing, so it can be shown without the ESP32.

**Switching mode** (all timers and links are reset, and it is logged): BOOT button short press,
Serial `m`, or the app. On A -> B the tracker sends one last "I am now in Locate mode" message so the
app can show the green badge, then goes dark.

**Commands from the app in Mode B:** the tracker only listens during its ~1 s window after an alert.
The broker queues commands in the meantime (persistent session, QoS 1), so a mode change or buzzer
command sent while the car is silent applies at its **next stop**.

### Serial commands

| Key | Action |
|---|---|
| `m` | switch mode |
| `f` | simulate 40 km/h |
| `s` | simulate 0 km/h |
| `g` | use real GPS speed |
| `o` | toggle simulated owner present / absent |
| `p` | print status (mode, radio state, speed, GPS fix, tx_count, link) |
| `h` | help |

**No GPS fix indoors?** Real GPS speed needs a sky view, and most venues have none. Two ways around it:

- Tethered: use `f` / `s` in the Serial Monitor.
- Untethered (not in the original spec, added for stage use): **hold BOOT for about 1 s** to toggle
  simulated speed between 40 and 0 km/h. A short press still switches mode.

Without a fix the position sent is the fallback 12.9716, 77.5946 (Bengaluru) and the message carries `"gps_fix": false`.

### Optional owner check

Set `OWNER_CHECK_ENABLED true`, install NimBLE-Arduino, and make the owner's phone advertise
`OWNER_BLE_NAME` or `OWNER_BLE_UUID` (the nRF Connect app can do this). When the car starts moving,
the tracker listens passively for 5 s - it never transmits on Bluetooth. Owner seen: "Owner present",
no alert at the next stop. Not seen: theft mode. Serial `o` simulates the owner without any phone,
even with the check disabled.

### Messages

Topics are `<TOPIC_PREFIX>/<VEHICLE_ID>/...`, by default `tracker/car1/...`.

| Topic | Direction | Payload |
|---|---|---|
| `tracker/car1/ping` | tracker -> app | `{"id","mode":"A","type":"ping","lat","lon","speed_kmh","tx_count","uptime_s","link":"gsm\|wifi","gps_fix"}` |
| `tracker/car1/alert` | tracker -> app | `{"id","mode":"B","type":"theft_stop","lat","lon","speed_kmh","tx_count","uptime_s","link","gps_fix","trail"}` (`trail` only when a route was recorded) |
| `tracker/car1/config` | app -> tracker | `{"mode":"A\|B"}`, `{"buzzer":true\|false}`, `{"stolen":true\|false}` |
| `tracker/car1/status` | tracker -> app | `{"id","mode","type":"mode_change","tx_count","uptime_s","link"}` (retained) |

`tx_count` is the total number of transmissions since boot. Additions to the original spec:
`gps_fix`, the `status` topic (so the app knows the mode after a button press) and `stolen`
(sent by "Report stolen"; makes the tracker ignore the owner check).

---

## 2b. LOCATE node (ESP32 + ICM-20948) and the web app

`firmware/locate_node/locate_node.ino` is a second firmware with a different behaviour from Mode A / B
above, and the web app understands it without any setting:

| Node state | Radio | What the app shows |
|---|---|---|
| `PARKED` | off | **Radio off** (telemetry stopped for 5 s). Compare badge: RADIO OFF: PARKED |
| `PURSUIT` | on, one report a second | **Moving**, live dot and solid route. Compare badge: PURSUIT: LIVE TRACKING |
| `STORE_FORWARD` | off, route logged to flash | Nothing during the blackout. When the link returns: **JAMMER BLACKOUT - route recovered**, the logged route drawn as a dashed line |
| main power cut | one alert | **TAMPER - the tracker's main power was cut**, pin on the map, "on backup battery" |

**Set-up.** Copy `wifi_secrets.example.h` to `wifi_secrets.h` (same folder) and put your Wi-Fi name and
password in it (2.4 GHz, with internet). That file is in `.gitignore`, so it is never published. Keep `USE_NETWORK 1`.
`MQTT_HOST` is the public HiveMQ broker the app already uses, and `TOPIC_BASE` must be
`<Topic prefix>/<Vehicle ID>` from the app's Settings (the defaults `locate-k7q2m9/car1` match).
Open the app, sign in, and shake the board for 2 s (or type `m` in the Serial Monitor).

**Arm / Disarm.** The node takes no commands, so arming is kept in the app (in that browser): press
**Arm** while it is parked, and the next movement raises **STOLEN** with the alarm, live route and
distance from the parked spot. When it goes silent the stop location is saved in Alerts. The app must
have seen the node move once before **Arm** works this way. Buzzer, mode buttons and "Report stolen"
answer "this tracker does not take commands".

**Serial demo keys:** `m` move, `j` / `u` jammer on / off (off triggers the upload), `p` / `r` power cut / restore.

**Things to know.**
- Indoors the position is the firmware's simulated route (`src:"sim"`); the app labels it
  "simulated position (no GPS fix)".
- The app cannot tell "parked" from "being jammed" while the node is silent; it finds out when the
  logged route arrives.
- Two changes were made to the sketch as supplied: the broker / topic settings above, and
  `LINK_GRACE_MS`: without it, the 3 failed sends while Wi-Fi was still connecting at the start of
  every trip were treated as a jammer blackout.
- The app side was tested with simulated node messages through the broker. The sketch itself has not
  been compiled or run on a board here.
- This node transmits while moving and is silent while parked, the opposite of Mode B. The Compare
  screen's "Always-on vs Locate" counters do not count node messages.

---

## 3. Broker setup (laptop)

Install Mosquitto 2.x (<https://mosquitto.org/download/>). `broker/mosquitto.conf` opens port **1883**
(MQTT, for the ESP32) and **9001** (WebSockets, for the web app), with a password file and no anonymous access.

**Windows (PowerShell):**

```powershell
cd broker
net stop mosquitto          # only if the installer started the service; needs an admin shell
& "C:\Program Files\mosquitto\mosquitto_passwd.exe" -c passwd locate    # type the password twice
& "C:\Program Files\mosquitto\mosquitto.exe" -c mosquitto.conf -v
```

Allow `mosquitto.exe` through Windows Firewall on private networks when prompted (ports 1883 and 9001),
and make sure the hotspot network is set to "Private".

**Linux:**

```bash
sudo apt install mosquitto mosquitto-clients
sudo systemctl stop mosquitto          # free port 1883
cd broker
mosquitto_passwd -c passwd locate      # type the password twice
chmod 600 passwd
mosquitto -c mosquitto.conf -v
```

Use the same user and password in `config.h` (default there: `locate` / `locate123`) and in the app's Settings.

### Reaching the broker over GSM

Over mobile data the tracker comes in from the internet and cannot see the laptop's LAN address. Pick one:

**(a) Public test broker** - quickest. Use it for **both** links so the app sees everything:

| | HiveMQ public broker | test.mosquitto.org |
|---|---|---|
| `MQTT_WIFI_HOST` and `MQTT_GSM_HOST` | `broker.hivemq.com` | `test.mosquitto.org` |
| `MQTT_*_PORT` | `1883` | `1883` |
| `MQTT_*_USER` / `MQTT_*_PASS` | `""` | `""` |
| App: Broker URL | `ws://broker.hivemq.com/mqtt` | `ws://test.mosquitto.org/mqtt` |
| App: port | `8000` | `8080` |

Set `TOPIC_PREFIX` to something unique (for example `locate-x7k2q`) in `config.h` and in the app.
Public brokers are open to everyone: anyone who guesses the prefix can read and send messages. Demo use only.

**(b) Tunnel or port-forward to the laptop** - keeps everything on your own broker:

```bash
ngrok tcp 1883
# Forwarding  tcp://0.tcp.in.ngrok.io:14753 -> localhost:1883
```

Put that host and port into `MQTT_GSM_HOST` / `MQTT_GSM_PORT` (they change every time ngrok restarts;
ngrok TCP tunnels need a free account that has been verified). Keep `MQTT_WIFI_HOST` as the laptop's LAN
IP and the app pointing at the laptop on port 9001. A router port-forward of TCP 1883 works the same way.

**One-broker rule:** the app watches one broker. Mode A (GSM) and Mode B (WiFi by default) must both
publish to it, otherwise half the demo never reaches the screen.

---

## 4. Web app

```bash
cd app
python -m http.server 8000
```

- Laptop: <http://localhost:8000>
- Phones on the same network: `http://<laptop-ip>:8000`
- No hardware: open Settings and switch on **Demo mode**, or open `http://<laptop-ip>:8000/?demo=1`

The app assumes the broker runs on the machine that serves the page, port 9001. Enter the password
in **Settings**, press **Test connection**, then **Save and connect**. Settings, alert history and
counters live in the browser's localStorage (the broker password is stored there in plain text - demo only).

The page loads Leaflet, MQTT.js and Chart.js from CDNs and map tiles from OpenStreetMap, so the
laptop and phones need internet. Sound and vibration start working after the first tap on the page.

### Sign-in and roles

The app opens on a sign-in page with two accounts:

The app opens on a sign-in page with two roles:

| Role | Sees |
|---|---|
| Customer (vehicle owner) | Live map, Alerts, Controls (arm / disarm, buzzer, report stolen), personal settings |
| Control admin | Everything: also Compare, mode switching, broker settings, Demo mode, phone tracker link, history, account passwords |

Dummy accounts (invented people, defined in `app/auth.js`):

| Name | Role | Username | Password |
|---|---|---|---|
| Demo Customer | Customer | `customer` | `customer123` |
| Priya Sharma | Customer | `priya` | `priya123` |
| Arjun Rao | Customer | `arjun` | `arjun123` |
| Meera Nair | Customer | `meera` | `meera123` |
| Control Admin | Control admin | `admin` | `admin123` |
| Control Room 2 | Control admin | `control` | `control123` |

The sign-in page lists these under "Demo accounts" (tap one to fill it in); set `SHOW_DEMO_ACCOUNTS`
to `false` in `app/auth.js` to hide that list. All customers see the same vehicle (`car1`).
A Control admin can change any account's password under Settings → Account, or reset them all
(saved in that browser). A session lasts 12 hours; five wrong tries lock the form for 30 seconds.
Nothing is loaded from the tracker until someone signs in.

**This is a demo gate, not security.** The app has no server, so the check runs in the browser and
anyone who can read `app.js` or the broker topic can bypass it. A real product needs server-side
accounts and broker access control per customer.

The phone tracker page (`tracker.html`) uses the same sign-in and the same accounts (both roles may
use it). Until someone signs in it runs nothing: no GPS, no motion sensor, no connection. Signing out
stops it. The accounts and the sign-in form live in one shared file, `app/auth.js`. On one phone, the
app and the tracker opened from the same link share the session, so you sign in once.

### Report to police

When a theft alert or Guard alarm arrives, **🚓 Report to police** appears on the red banner and on
the alert in the Alerts list. It opens a prepared report: reference number, who is reporting, vehicle
registration and description (typed once, remembered), what happened, alarm time and place, last known
location with a Google Maps link (updates live while the tracker keeps reporting), where it was taken
from, and the most recent positions. From there: **Call 112**, **Email report** (opens your email app),
**Copy report**, **Download**, and **mark as reported**, which tags the alert "Reported to police".

**The app does not contact the police itself.** There is no police system to connect to, so nothing
is sent until the user emails it or calls. The emergency number is `EMERGENCY_NUMBER` in `app/app.js`
(112 for India).

### Phone as the tracker (demo without the ESP32)

`app/tracker.html` turns a phone into the tracker. It uses the phone's real GPS and sends the same
messages with the same Mode A / Mode B rules as the firmware, so the Locate app cannot tell the
difference (the "Sent over" field says "Phone tracker"). It has buttons to force "Moving" / "Stopped"
for indoor use, and a 2 km/h threshold for walking demos. App commands work too: buzzer = the phone vibrates.

Phones only share GPS with `https://` pages, so serve the app over HTTPS on the LAN:

```bash
# once: self-signed certificate for the laptop's IP (kept outside app/ so the key is never served)
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=Locate demo" -addext "subjectAltName=IP:<laptop-ip>,IP:127.0.0.1,DNS:localhost"
# every time
cd app
python serve_https.py          # prints https://<laptop-ip>:8443/tracker.html
```

On the phone open `https://<laptop-ip>:8443/tracker.html`, tap **Advanced → Proceed** on the certificate
warning, allow location, keep the screen on. Watch it on the laptop at `http://localhost:8000`.
A Netlify `https://` link works as well, with no certificate warning.

**Guard mode (phone tracker only).** A third mode besides Always-on and Locate: hold the phone still
for 3 s to arm it. The moment it moves, the laptop shows **STOLEN**, sounds an alarm that repeats until
silenced, raises a pop-up, and follows the phone live on the map (position every second, red route,
"parked here" marker, distance from the parked spot). When it stops for 5 s the stop location is saved
in Alerts. **Mark resolved** on the laptop (or **Re-arm** on the phone) arms it again. Guard messages are
not counted in the Always-on vs Locate comparison. Guard is the opposite trade-off to Locate - it
transmits while moving - so present it as a separate "owner is nearby" feature, not as Locate itself.

Movement is detected by the motion sensor (shaking sustained for 0.6 s, so one bump is ignored) or by
GPS (speed, or leaving the armed spot by more than 20 m). The position is GPS smoothed with a small
Kalman filter that holds the dot steady while the phone is still.

Limit: a web page cannot switch off the phone's own mobile radio, so the RF-detector part of the demo
still needs the ESP32. The phone shows the tracking, the silence rule and the single alert.

### Install it on a phone (works like an app)

The app is a PWA: it gets a home-screen icon, opens full-screen without the browser bar, opens
fast from its cache, and runs Demo mode with no internet once it has been opened online.

| Phone | How |
|---|---|
| Android (Chrome) | Settings screen → **Install app**, or browser menu ⋮ → **Install app** |
| iPhone (Safari) | Share button → **Add to Home Screen** |

A **full install needs an `https://` link**: drag the `app` folder onto <https://app.netlify.com/drop> to get one. On a plain
`http://192.168.x.x:8000` LAN link, phones only make a shortcut that opens in the browser, and the
offline cache and **Keep screen on** switch do not work there. `http://localhost` counts as secure.

**Keep screen on** (Settings) stops the phone sleeping during the demo.

After changing the app files, bump `VERSION` in `app/sw.js` so installed phones drop their old copy.

| Screen | What it shows |
|---|---|
| Live map | vehicle, route trail, stop-alert pins, status card (Safe / Theft mode / Alert) |
| Alerts | newest first, filter chips, "Open in Google Maps", "Mark resolved" |
| Compare | judges' screen: both counters, RF detector lamp, mode badge and toggle, per-minute chart |
| Controls | buzzer, report stolen (with a confirm step) |
| Settings | broker, topic prefix, vehicle ID, test connection, Demo mode |

---

## 5. Bring-up checklist

Do these in order; each step isolates one thing.

1. **Buck at 5.0 V** - measure the output with nothing connected. Then connect the ESP32 only.
2. **GPS NMEA visible** - near a window, Serial `p` shows `fix=yes` and satellites within a few minutes
   (the module's own LED starts blinking on a fix). No fix yet is fine; `sats` rising means the wiring is right.
3. **SIM800L AT / CSQ / CREG OK** - boot in Mode A. The log should show `GSM modem power ON`,
   `CSQ=<10..31>`, `registered on "<operator>"`, `GPRS up`. CSQ 99 or a registration timeout: antenna, SIM
   seating, 2G coverage. "modem stopped answering while registering" means a brown-out: check the 1000 uF capacitor and the buck.
4. **MOSFET cuts modem power** - switch to Mode B (BOOT). Log shows `GSM modem power CUT`. Measure the
   SIM800L 5 V pin: it must fall to about 0 V and the module's network LED must go dark. Switch back to A: 5 V returns.
5. **WiFi publish works** - Mode B, Serial `f` then `s`. After about 5-8 s the log shows `WiFi ON`,
   `[TX #n] tracker/car1/alert ...`, `WiFi OFF`, and the TX LED flashes once.
6. **GSM publish works** - Mode A: a `[TX #n] tracker/car1/ping` line every 1.5 s with `"link":"gsm"`.
7. **App receives both** - Compare screen: the "Always-on tracker" counter climbs in Mode A; a Mode B stop
   adds exactly 1 to "Locate" and raises the red banner.

---

## 6. RF detector demo script (about 90 seconds)

Before going on stage: power the tracker a minute early so Mode A is registered on the network, open
the app on the **Compare** screen, tap the page once (enables sound), press **Reset counters**.

| # | Time | Do | Say / show |
|---|---|---|---|
| 1 | 0:00 | **Baseline.** Tracker switched off, detector 5-10 cm from the car. | "The detector is quiet. Nothing is transmitting." |
| 2 | 0:15 | Power on, **Mode A** (on-board LED off). Drive the RC car. | Detector beeps every 1-2 s, TX LED flashes, the "Always-on tracker" counter climbs. "This is every tracker on the market. A thief finds it in seconds." |
| 3 | 0:40 | Press **BOOT** -> **Mode B** (on-board LED on). Drive. | Detector silent. App shows green **LOCATE: SILENT**, the lamp stays dark. "Same hardware, same detector. Nothing to find." |
| 4 | 1:00 | **Stop the car.** Wait for the dwell time (5 s + up to 3 s). | One beep, one TX LED flash, red **THEFT ALERT** banner, the map flies to the location. |
| 5 | 1:15 | Drive again. | Silent again. Point at the counters: "Always-on: dozens. Locate: 1." |

If the venue has no GPS fix, use the BOOT long press to mark "driving" (step 3) and "stopped" (step 4).

### Venue RF-noise tips

- Lower the detector's sensitivity until it is quiet with the tracker off, then stop.
- Hold the detector 5-10 cm from the tracker, always at the same distance.
- Keep the phone hotspot and the laptop several metres from the car.
- Ask people near the table to pocket their phones during the demo.
- Always show the baseline first, so a noisy room is visibly not your tracker.
- Record a backup video in a quiet room, and keep the app's Demo mode ready on a second phone.

---

## 7. Manual test list

Firmware (Serial Monitor open):

- [ ] Mode A, GSM up: ping every ~1.5 s, `"link":"gsm"`, TX LED flashes each time, `tx_count` increments.
- [ ] Mode A, SIM removed: warning logged, pings continue with `"link":"wifi"`.
- [ ] Mode A, pull the modem's power briefly: brown-out/reset is logged and the modem re-initialises.
- [ ] Mode B, `f`: log says radio silent; `p` shows modem OFF, wifi OFF, ble OFF; no `[TX]` lines.
- [ ] Mode B, `s`: one alert after 5-8 s, then radios OFF. Waiting longer sends nothing more.
- [ ] Mode B, `f` then `s` again: exactly one more alert.
- [ ] Mode B, `s` then `f` within 5 s: no alert (dwell reset).
- [ ] Mode B, `o` (owner present), `f`, `s`: "OWNER PRESENT - no alert".
- [ ] Mode B with `MODE_B_LINK LINK_GSM`: alert arrives 10-30 s after the stop, then modem power is cut.
- [ ] Mode switch by BOOT button, by Serial `m`, and from the app in Mode A: each is logged, on-board LED follows.
- [ ] Mode switch from the app while in Mode B: applied right after the next alert.
- [ ] Buzzer toggle from the app (if fitted).
- [ ] Restart the broker: the tracker (Mode A) and the app both reconnect on their own within a few seconds.

Web app:

- [ ] Demo mode: counters climb in "Always-on tracker"; switch to Locate, counter freezes, one alert about 25 s later.
- [ ] That alert draws a dashed route from an "S" marker to the stop, and Compare shows "Silent, but nothing is lost".
- [ ] Alert: banner, map flies to it, sound and vibration (after one tap), pin on the map, entry in Alerts.
- [ ] Alerts: filter chips, "Open in Google Maps", "Mark resolved" (pin turns grey, badge count drops).
- [ ] Controls: report stolen shows the confirm step; with the broker stopped, commands show "Failed".
- [ ] Settings: wrong password -> "Test connection" reports it; correct one -> "Connection works".
- [ ] Reload the page: settings, alerts and counters are still there.
- [ ] Phone: bottom tab bar, no sideways scrolling, light and dark themes.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| ESP32 resets when the modem switches on | inrush into the 1000 uF capacitor: add 470 uF at `VIN`, slow the gate, check the buck is a real 3 A part |
| `modem does not answer AT` | TX/RX swapped, MOSFET not switching, no common ground |
| Registers, then `GPRS attach failed` | wrong APN or no data balance |
| Mode A works on GSM but the app shows nothing | GSM and the app are on different brokers (one-broker rule) |
| App says "Reconnecting - wrong username or password" | set the password in Settings |
| Phone cannot open the app | laptop firewall, or the hotspot isolates clients; test with the laptop's IP from the phone browser |
| Detector still beeps in Mode B | it is hearing the hotspot or a phone - move them away and repeat the baseline |
