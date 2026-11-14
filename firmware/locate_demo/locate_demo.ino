// =============================================================================
//  Locate - hidden anti-theft vehicle tracker (hackathon demo firmware)
//
//  Board:  ESP32 DevKit (WROOM-32), Arduino framework
//  Tested against (versions assumed):
//    esp32 Arduino core  3.x   (2.0.x also works)
//    TinyGSM             0.12.0
//    TinyGPSPlus         1.0.3
//    PubSubClient        2.8
//    ArduinoJson         7.x
//    NimBLE-Arduino      2.x   (only needed when OWNER_CHECK_ENABLED is true)
//
//  MODE A  "always-on tracker": modem powered and registered all the time,
//          publishes a ping every MODE_A_PERIOD_MS. Easy to catch with an RF
//          detector.
//  MODE B  "Locate": every radio is OFF while the vehicle moves (the modem is
//          power-cut with a MOSFET, WiFi is off, BLE is off or passive-scan
//          only). After the vehicle has been stopped for DWELL_MS it sends ONE
//          alert, listens ~1 s for config, and goes dark again.
//
//  Serial commands (115200 baud):
//    m  switch mode          f  simulate 40 km/h     s  simulate 0 km/h
//    g  use real GPS speed   o  toggle simulated owner present/absent
//    p  print status         h  help
//  BOOT button: short press = switch mode, long press = toggle simulated
//  speed 40 <-> 0 km/h (handy indoors where there is no GPS fix).
// =============================================================================

#include "config.h"

#define TINY_GSM_MODEM_SIM800
#define TINY_GSM_RX_BUFFER 1024

#include <WiFi.h>
#include <TinyGsmClient.h>
#include <TinyGPSPlus.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#if OWNER_CHECK_ENABLED
#include <NimBLEDevice.h>
#endif

#define LINK_NONE 255

// Timestamped logging
#define LOG(fmt, ...) Serial.printf("[%8lu] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)

// ----------------------------------------------------------------------------
// Objects
// ----------------------------------------------------------------------------
HardwareSerial SerialAT(1);    // SIM800L
HardwareSerial SerialGPS(2);   // NEO-M8N
TinyGsm        modem(SerialAT);
TinyGsmClient  gsmClient(modem);
WiFiClient     wifiClient;
PubSubClient   mqtt;
TinyGPSPlus    gps;

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
char topicPing[64], topicAlert[64], topicConfig[64], topicStatus[64];
char clientId[40];

char     mode        = DEFAULT_MODE;   // 'A' or 'B'
char     pendingMode = 0;              // requested mode, applied at the top of loop()
uint32_t txCount     = 0;              // total transmissions since boot

// Radio bookkeeping
bool    modemPowered = false;
bool    wifiOn       = false;
bool    bleScanning  = false;
uint8_t mqttLink     = LINK_NONE;      // link the MQTT session currently runs on

// Speed source
bool  useSimSpeed = false;
float simSpeedKmh = 0;

// Owner / theft flags
bool          simOwnerPresent = false;   // serial 'o'
volatile bool bleOwnerFound   = false;   // set by the passive BLE scan
uint32_t      ownerScanStart  = 0;
bool          stolenFlag      = false;   // {"stolen":true} from the app: ignore the owner check
bool          buzzerOn        = false;

// Mode A
uint8_t  aLink           = LINK_NONE;
bool     aAnnounced      = false;
uint8_t  gsmFails        = 0;
uint32_t aNextEstablish  = 0;
uint32_t aLastPing       = 0;
uint32_t aLastReconnect  = 0;
uint32_t aLastHealth     = 0;
uint32_t aLastGsmTry     = 0;

// Mode B
#define B_IDLE        0   // waiting for the first movement (no alert is armed)
#define B_MOVING      1   // moving: all radios silent
#define B_DWELL       2   // below the threshold, counting DWELL_MS
#define B_SEND        3   // bring link up, send the one alert
#define B_RETRY_WAIT  4   // link failed, waiting to try again
#define B_SENT        5   // alert sent (or suppressed), silent until the car moves again
uint8_t  bState        = B_IDLE;
uint32_t bDwellStart   = 0;
uint32_t bRetryAt      = 0;
uint8_t  bAttempts     = 0;
bool     abortOnMotion = false;        // true while Mode B is bringing a link up

uint32_t txLedOffAt = 0;

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const char* linkName(uint8_t l) {
  return l == LINK_GSM ? "gsm" : (l == LINK_WIFI ? "wifi" : "none");
}

float currentSpeedKmh() {
  if (useSimSpeed) return simSpeedKmh;
  if (gps.speed.isValid() && gps.speed.age() < GPS_STALE_MS) return gps.speed.kmph();
  return 0;   // no live fix: treat as stopped
}

bool isMoving() { return currentSpeedKmh() >= SPEED_THRESHOLD_KMH; }

// Fills lat/lon. Returns true when it is a live GPS fix, false for the last
// known position or the fallback coordinates.
bool getPosition(double& lat, double& lon) {
  if (gps.location.isValid()) {
    lat = gps.location.lat();
    lon = gps.location.lng();
    return gps.location.age() < GPS_STALE_MS;
  }
  lat = FALLBACK_LAT;
  lon = FALLBACK_LON;
  return false;
}

bool ownerPresent() { return simOwnerPresent || bleOwnerFound; }

// ----------------------------------------------------------------------------
// Silent route (breadcrumb trail)
// While Mode B is silent, GPS positions are kept in RAM (the GPS only receives).
// They are sent inside the one stop alert as "trail":[[lat,lon,seconds ago],...].
// RAM only: a power cut loses the route recorded so far.
// ----------------------------------------------------------------------------
struct TrailPoint { double lat, lon; uint32_t ms; };
TrailPoint trail[TRAIL_MAX_POINTS];
uint8_t    trailCount  = 0;
uint32_t   trailPeriod = TRAIL_PERIOD_MS;
uint32_t   trailLastMs = 0;

void trailReset() {
  trailCount  = 0;
  trailPeriod = TRAIL_PERIOD_MS;
  trailLastMs = 0;
}

void trailRecord() {
  if (!TRAIL_ENABLED) return;
  uint32_t now = millis();
  if (trailCount > 0 && now - trailLastMs < trailPeriod) return;
  if (!gps.location.isValid() || gps.location.age() > GPS_STALE_MS) return;   // live fixes only
  double lat = gps.location.lat(), lon = gps.location.lng();
  if (trailCount > 0 &&
      TinyGPSPlus::distanceBetween(trail[trailCount - 1].lat, trail[trailCount - 1].lon, lat, lon) < TRAIL_MIN_M) return;
  if (trailCount >= TRAIL_MAX_POINTS) {
    // Full: keep every second point and record half as often from now on
    uint8_t kept = 0;
    for (uint8_t i = 0; i < trailCount; i += 2) trail[kept++] = trail[i];
    trailCount = kept;
    trailPeriod *= 2;
  }
  trail[trailCount++] = { lat, lon, now };
  trailLastMs = now;
}

// A blocking step must give up when the user asked for a mode change, or (in
// Mode B) when the car starts moving again - the radio must go dark at once.
bool shouldAbort() {
  if (pendingMode) return true;
  if (abortOnMotion && isMoving()) return true;
  return false;
}

void requestMode(char m, const char* source) {
  if (m != 'A' && m != 'B') return;
  if (m == mode) {
    pendingMode = 0;
    LOG("[MODE] %s asked for mode %c - already active", source, m);
    return;
  }
  pendingMode = m;
  LOG("[MODE] %s requested mode %c", source, m);
}

void flashTxLed() {
  digitalWrite(PIN_LED_TX, HIGH);
  txLedOffAt = millis() + TX_LED_MS;
}

// ----------------------------------------------------------------------------
// Status / serial commands / button
// ----------------------------------------------------------------------------
const char* bStateName() {
  switch (bState) {
    case B_IDLE:       return "armed, waiting for movement";
    case B_MOVING:     return "MOVING - radio silent";
    case B_DWELL:      return "stopped? counting dwell";
    case B_SEND:       return "sending alert";
    case B_RETRY_WAIT: return "alert failed, retry pending";
    default:           return "stopped - alert done, silent";
  }
}

void printStatus() {
  double lat, lon;
  bool fix = getPosition(lat, lon);
  Serial.println(F("---------------- Locate status ----------------"));
  if (mode == 'A') {
    Serial.printf("Mode      : A (ALWAYS-ON TRACKER)  link=%s\n", linkName(aLink));
  } else {
    Serial.printf("Mode      : B (LOCATE)  state=%s  alert link=%s\n", bStateName(), linkName(MODE_B_LINK));
  }
  Serial.printf("Radio     : modem=%s  wifi=%s  ble=%s  server=%s\n",
                modemPowered ? "POWERED" : "OFF (power cut)",
                wifiOn ? "ON" : "OFF",
                bleScanning ? "PASSIVE SCAN (rx only)" : "OFF",
                (mqttLink != LINK_NONE && mqtt.connected()) ? linkName(mqttLink) : "not connected");
  Serial.printf("Speed     : %.1f km/h (%s), threshold %d km/h -> %s\n",
                currentSpeedKmh(), useSimSpeed ? "SIMULATED" : "GPS",
                SPEED_THRESHOLD_KMH, isMoving() ? "MOVING" : "stopped");
  Serial.printf("GPS       : fix=%s  sats=%lu  lat=%.6f lon=%.6f%s\n",
                fix ? "yes" : "NO", (unsigned long)(gps.satellites.isValid() ? gps.satellites.value() : 0),
                lat, lon, gps.location.isValid() ? "" : "  (fallback coordinates)");
  Serial.printf("tx_count  : %lu   uptime %lu s\n", (unsigned long)txCount, (unsigned long)(millis() / 1000));
  Serial.printf("Trail     : %u/%d route points stored (recorded every %lu ms while silent)\n",
                (unsigned)trailCount, TRAIL_MAX_POINTS, (unsigned long)trailPeriod);
  Serial.printf("Owner     : check=%s  simulated=%s  ble_found=%s  stolen=%s\n",
                OWNER_CHECK_ENABLED ? "BLE passive scan" : "off",
                simOwnerPresent ? "PRESENT" : "absent", bleOwnerFound ? "yes" : "no",
                stolenFlag ? "YES" : "no");
  Serial.printf("Buzzer    : %s\n", buzzerOn ? "on" : "off");
  Serial.println(F("-----------------------------------------------"));
}

void printHelp() {
  Serial.println(F("Commands: m=switch mode  f=simulate 40 km/h  s=simulate 0 km/h  g=real GPS speed"));
  Serial.println(F("          o=toggle simulated owner  p=status  h=help"));
  Serial.println(F("BOOT button: short press = switch mode, long press = toggle simulated 40/0 km/h"));
}

void setSimSpeed(float kmh) {
  useSimSpeed = true;
  simSpeedKmh = kmh;
  LOG("[SIM] speed forced to %.0f km/h", kmh);
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    switch (c) {
      case 'm': case 'M': {
        char cur = pendingMode ? pendingMode : mode;
        requestMode(cur == 'A' ? 'B' : 'A', "Serial");
        break;
      }
      case 'f': case 'F': setSimSpeed(40); break;
      case 's': case 'S': setSimSpeed(0);  break;
      case 'g': case 'G':
        useSimSpeed = false;
        LOG("[SIM] using real GPS speed");
        break;
      case 'o': case 'O':
        simOwnerPresent = !simOwnerPresent;
        LOG("[OWNER] simulated owner is now %s", simOwnerPresent ? "PRESENT (no alerts)" : "ABSENT (theft mode)");
        break;
      case 'p': case 'P': printStatus(); break;
      case 'h': case 'H': case '?': printHelp(); break;
      default: break;   // ignore CR/LF and anything else
    }
  }
}

void pollButton() {
  static bool     stable = HIGH, lastRead = HIGH;
  static uint32_t lastChange = 0, pressedAt = 0;
  bool     r   = digitalRead(PIN_BUTTON);
  uint32_t now = millis();
  if (r != lastRead) { lastRead = r; lastChange = now; }
  if (r != stable && now - lastChange >= DEBOUNCE_MS) {
    stable = r;
    if (stable == LOW) {
      pressedAt = now;
    } else if (now - pressedAt >= LONG_PRESS_MS) {
      setSimSpeed((useSimSpeed && simSpeedKmh > 0) ? 0 : 40);
    } else {
      char cur = pendingMode ? pendingMode : mode;
      requestMode(cur == 'A' ? 'B' : 'A', "BOOT button");
    }
  }
}

// Everything that must keep running even inside blocking link bring-up.
// It only reads inputs and sets flags; it never changes mode or touches a link.
void backgroundTasks() {
  while (SerialGPS.available()) gps.encode((char)SerialGPS.read());
  pollButton();
  pollSerial();
  uint32_t now = millis();
  if (txLedOffAt && (int32_t)(now - txLedOffAt) >= 0) {
    digitalWrite(PIN_LED_TX, LOW);
    txLedOffAt = 0;
  }
  // Active buzzer: 200 ms beep every second while switched on
  digitalWrite(PIN_BUZZER, (buzzerOn && (now % 1000) < 200) ? HIGH : LOW);
}

// millis()-based wait that keeps servicing inputs. Returns false if aborted.
bool waitServiced(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    backgroundTasks();
    if (shouldAbort()) return false;
    delay(2);
  }
  return true;
}

// ----------------------------------------------------------------------------
// Owner check (BLE, passive scan only: the ESP32 never transmits on Bluetooth)
// ----------------------------------------------------------------------------
#if OWNER_CHECK_ENABLED
class OwnerScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* dev) override {
    if (strlen(OWNER_BLE_NAME) > 0 && dev->haveName() && dev->getName() == OWNER_BLE_NAME) {
      bleOwnerFound = true;
    }
    if (strlen(OWNER_BLE_UUID) > 0 && dev->isAdvertisingService(NimBLEUUID(OWNER_BLE_UUID))) {
      bleOwnerFound = true;
    }
  }
};
OwnerScanCallbacks ownerScanCallbacks;

void ownerScanStartNow() {
  bleOwnerFound = false;
  NimBLEDevice::init("");                        // no advertising is ever started
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&ownerScanCallbacks, false);
  scan->setActiveScan(false);                    // PASSIVE: listen only, no scan requests
  scan->setInterval(100);
  scan->setWindow(100);
  scan->start(OWNER_SCAN_MS, false, true);
  bleScanning    = true;
  ownerScanStart = millis();
  LOG("[RADIO] BLE passive scan ON (receive only) - looking for the owner for %d ms", OWNER_SCAN_MS);
}

void ownerScanStop() {
  if (!bleScanning) return;
  NimBLEDevice::getScan()->stop();
  NimBLEDevice::deinit(true);
  bleScanning = false;
  LOG("[RADIO] BLE OFF");
}

void ownerScanService() {
  if (!bleScanning) return;
  if (bleOwnerFound || millis() - ownerScanStart >= (uint32_t)OWNER_SCAN_MS + 200) {
    ownerScanStop();
    LOG("[OWNER] %s", bleOwnerFound ? "owner phone seen -> OWNER PRESENT (no alerts this trip)"
                                    : "owner phone not seen -> THEFT MODE");
  }
}
#else
void ownerScanStartNow() { bleOwnerFound = false; }   // BLE is never initialised
void ownerScanStop() {}
void ownerScanService() {}
#endif

// ----------------------------------------------------------------------------
// Radio control
// ----------------------------------------------------------------------------
void mqttDrop() {
  if (mqttLink == LINK_NONE) return;
  mqtt.disconnect();
  mqttLink = LINK_NONE;
}

void wifiOff() {
  if (mqttLink == LINK_WIFI) mqttDrop();
  if (!wifiOn) return;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  wifiOn = false;
  LOG("[RADIO] WiFi OFF");
}

bool wifiBringUp() {
  uint32_t t0 = millis();
  LOG("[RADIO] WiFi ON - connecting to \"%s\"", WIFI_SSID);
  wifiOn = true;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > WIFI_CONNECT_TIMEOUT_MS) {
      LOG("[WIFI] connect timed out after %d ms", WIFI_CONNECT_TIMEOUT_MS);
      return false;
    }
    if (!waitServiced(50)) return false;
  }
  LOG("[WIFI] connected in %lu ms, IP %s, RSSI %d dBm",
      (unsigned long)(millis() - t0), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

// Switches the SIM800L supply with the MOSFET. When the supply is cut the UART
// and RST pins are parked low / floating so the modem cannot be back-powered
// through its I/O pins.
void modemPower(bool on) {
  if (on == modemPowered) return;
  if (on) {
    pinMode(PIN_MODEM_RST, INPUT);                       // released (module has its own pull-up)
    digitalWrite(PIN_MODEM_PWR, MODEM_PWR_ON_LEVEL);
    SerialAT.begin(MODEM_BAUD, SERIAL_8N1, PIN_MODEM_RX, PIN_MODEM_TX);
    modemPowered = true;
    LOG("[RADIO] GSM modem power ON");
  } else {
    SerialAT.end();
    pinMode(PIN_MODEM_TX, OUTPUT);
    digitalWrite(PIN_MODEM_TX, LOW);
    pinMode(PIN_MODEM_RX, INPUT);
    pinMode(PIN_MODEM_RST, INPUT);
    digitalWrite(PIN_MODEM_PWR, !MODEM_PWR_ON_LEVEL);
    modemPowered = false;
    LOG("[RADIO] GSM modem power CUT (MOSFET off)");
  }
}

void modemResetPulse() {
  LOG("[GSM] pulsing RST");
  pinMode(PIN_MODEM_RST, OUTPUT);
  digitalWrite(PIN_MODEM_RST, LOW);
  delay(150);
  pinMode(PIN_MODEM_RST, INPUT);
}

void logGsmSignal() {
  int csq = modem.getSignalQuality();   // AT+CSQ: 0-31, 99 = unknown
  bool reg = modem.isNetworkConnected();
  if (csq == 99) {
    LOG("[GSM] CSQ=99 (no signal reading), registered=%s", reg ? "yes" : "no");
  } else {
    LOG("[GSM] CSQ=%d (%d dBm, %s), registered=%s", csq, -113 + 2 * csq,
        csq >= 15 ? "good" : (csq >= 10 ? "ok" : "WEAK"), reg ? "yes" : "no");
  }
}

// Cold-starts the modem: power-cycle, AT sync, SIM check, wait for network
// registration, attach GPRS. This is the one place that blocks for a long time
// (10-30 s is normal); the button, serial and GPS are still serviced, and a
// mode request (or movement in Mode B) aborts it.
bool gsmBringUp() {
  uint32_t t0 = millis();
  if (mqttLink == LINK_GSM) mqttLink = LINK_NONE;
  if (modemPowered) {
    gsmClient.stop();                 // clear TinyGSM's socket state
    modemPower(false);                // always start from a clean power-up
    if (!waitServiced(1500)) return false;
  }
  modemPower(true);
  if (!waitServiced(MODEM_BOOT_MS)) return false;

  bool alive = false;
  for (int attempt = 0; attempt < 2 && !alive; attempt++) {
    for (int i = 0; i < 8 && !alive; i++) {
      alive = modem.testAT(1000);
      backgroundTasks();
      if (shouldAbort()) return false;
    }
    if (!alive && attempt == 0) {
      modemResetPulse();
      if (!waitServiced(MODEM_BOOT_MS)) return false;
    }
  }
  if (!alive) {
    LOG("[GSM] modem does not answer AT - check 5 V supply, MOSFET, TX/RX wiring");
    return false;
  }
  if (!modem.init()) {
    LOG("[GSM] modem init failed (SIM missing or not seated?)");
    return false;
  }
  if ((int)modem.getSimStatus() != 1) {   // 1 = SIM_READY
    LOG("[GSM] SIM not ready (missing, PIN-locked or bad contact)");
    return false;
  }

  LOG("[GSM] waiting for network registration (up to %d s)...", GSM_REG_TIMEOUT_MS / 1000);
  uint32_t regStart = millis(), lastLog = millis();
  while (!modem.isNetworkConnected()) {
    if (millis() - regStart > GSM_REG_TIMEOUT_MS) {
      LOG("[GSM] registration timed out - no 2G coverage here? (Airtel/Vi only)");
      return false;
    }
    if (millis() - lastLog >= 3000) {
      lastLog = millis();
      if (!modem.testAT(500)) {
        LOG("[GSM] modem stopped answering while registering - BROWN-OUT? "
            "Check the 1000 uF capacitor and the buck converter (needs 2 A peaks)");
        return false;
      }
      logGsmSignal();
    }
    if (!waitServiced(500)) return false;
  }
  logGsmSignal();
  LOG("[GSM] registered on \"%s\" after %lu ms", modem.getOperator().c_str(), (unsigned long)(millis() - regStart));

  if (shouldAbort()) return false;
  LOG("[GSM] attaching GPRS, APN \"%s\"", GPRS_APN);
  if (!modem.gprsConnect(GPRS_APN, GPRS_USER, GPRS_PASS)) {
    LOG("[GSM] GPRS attach failed (wrong APN? no data balance?)");
    return false;
  }
  LOG("[GSM] GPRS up, IP %s, total bring-up %lu ms",
      modem.getLocalIP().c_str(), (unsigned long)(millis() - t0));
  return true;
}

// ----------------------------------------------------------------------------
// MQTT
// ----------------------------------------------------------------------------
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    LOG("[CONFIG] ignored invalid JSON (%s)", err.c_str());
    return;
  }
  LOG("[CONFIG] message received on %s", topic);
  if (doc["mode"].is<const char*>()) {
    const char* m = doc["mode"];
    if (m[0] == 'A' || m[0] == 'B') requestMode(m[0], "App");
  }
  if (doc["buzzer"].is<bool>()) {
    buzzerOn = doc["buzzer"].as<bool>();
    LOG("[CONFIG] buzzer %s", buzzerOn ? "ON" : "OFF");
  }
  if (doc["stolen"].is<bool>()) {
    stolenFlag = doc["stolen"].as<bool>();
    LOG("[CONFIG] reported stolen = %s%s", stolenFlag ? "YES" : "no",
        stolenFlag ? " (owner check is ignored, alerts always sent)" : "");
  }
}

// Connects with a PERSISTENT session and a QoS 1 subscription, so the broker
// queues config messages while Mode B is dark and delivers them in the short
// listen window after the next alert.
bool mqttConnect(uint8_t link) {
  mqttDrop();
  const char *host, *user, *pass;
  uint16_t port;
  if (link == LINK_GSM) {
    mqtt.setClient(gsmClient);
    host = MQTT_GSM_HOST; port = MQTT_GSM_PORT; user = MQTT_GSM_USER; pass = MQTT_GSM_PASS;
  } else {
    mqtt.setClient(wifiClient);
    host = MQTT_WIFI_HOST; port = MQTT_WIFI_PORT; user = MQTT_WIFI_USER; pass = MQTT_WIFI_PASS;
  }
  mqtt.setServer(host, port);
  bool hasUser = strlen(user) > 0;
  uint32_t t0 = millis();
  bool ok = mqtt.connect(clientId, hasUser ? user : nullptr, hasUser ? pass : nullptr,
                         nullptr, 0, false, nullptr, false /* cleanSession */);
  if (!ok) {
    LOG("[LINK] server connect over %s to %s:%u FAILED (state %d)", linkName(link), host, port, mqtt.state());
    return false;
  }
  mqttLink = link;
  mqtt.subscribe(topicConfig, 1);
  LOG("[LINK] connected to server %s:%u over %s in %lu ms", host, port, linkName(link),
      (unsigned long)(millis() - t0));
  return true;
}

bool publishRaw(const char* topic, JsonDocument& doc, bool retained) {
  doc["tx_count"] = txCount + 1;
  static char buf[1280];           // an alert with a full trail is about 1 kB
  if (measureJson(doc) >= sizeof(buf)) {
    LOG("[TX] message too large for the buffer - sending it without the trail");
    doc.remove("trail");
  }
  size_t n = serializeJson(doc, buf, sizeof(buf));
  bool ok = mqtt.publish(topic, (const uint8_t*)buf, (unsigned int)n, retained);
  if (ok) {
    txCount++;
    flashTxLed();
    LOG("[TX #%lu] %s (%u bytes) %s", (unsigned long)txCount, topic, (unsigned)n, buf);
  } else {
    LOG("[TX] publish to %s FAILED", topic);
  }
  return ok;
}

// Ping (Mode A) or theft_stop alert (Mode B)
bool publishPosition(bool isAlert, uint8_t link) {
  double lat, lon;
  bool fix = getPosition(lat, lon);
  JsonDocument doc;
  doc["id"]        = VEHICLE_ID;
  doc["mode"]      = isAlert ? "B" : "A";
  doc["type"]      = isAlert ? "theft_stop" : "ping";
  doc["lat"]       = lat;
  doc["lon"]       = lon;
  doc["speed_kmh"] = roundf(currentSpeedKmh() * 10.0f) / 10.0f;
  doc["tx_count"]  = 0;   // filled in by publishRaw
  doc["uptime_s"]  = (uint32_t)(millis() / 1000);
  doc["link"]      = linkName(link);
  doc["gps_fix"]   = fix; // extra field: false = last known / fallback position
  if (isAlert && trailCount > 0) {
    // The route recorded while silent, oldest first: [lat, lon, seconds before now]
    uint32_t now = millis();
    JsonArray tr = doc["trail"].to<JsonArray>();
    for (uint8_t i = 0; i < trailCount; i++) {
      JsonArray p = tr.add<JsonArray>();
      p.add(serialized(String(trail[i].lat, 6)));
      p.add(serialized(String(trail[i].lon, 6)));
      p.add((uint32_t)((now - trail[i].ms) / 1000));
    }
  }
  return publishRaw(isAlert ? topicAlert : topicPing, doc, false);
}

// One retained "which mode am I in" message so the app can show the right
// badge. Sent when Mode A comes up, and as a goodbye just before Mode B goes dark.
bool publishModeStatus(char m, uint8_t link) {
  JsonDocument doc;
  doc["id"]       = VEHICLE_ID;
  doc["mode"]     = (m == 'A') ? "A" : "B";
  doc["type"]     = "mode_change";
  doc["tx_count"] = 0;
  doc["uptime_s"] = (uint32_t)(millis() / 1000);
  doc["link"]     = linkName(link);
  return publishRaw(topicStatus, doc, true);
}

// ----------------------------------------------------------------------------
// MODE A - always-on tracker
// ----------------------------------------------------------------------------
void modeAUseWifi() {
  if (wifiBringUp()) {
    aLink = LINK_WIFI;
    aLastGsmTry = millis();
    mqttConnect(LINK_WIFI);   // if this fails the reconnect logic keeps trying
  } else {
    wifiOff();
    aLink = LINK_NONE;
    aNextEstablish = millis() + 5000;
    LOG("[MODE A] no link available, trying again in 5 s");
  }
}

void modeAEstablish() {
  if (MODE_A_LINK == LINK_GSM) {
    if (gsmBringUp() && mqttConnect(LINK_GSM)) {
      aLink = LINK_GSM;
      gsmFails = 0;
      aLastHealth = millis();
      return;
    }
    if (shouldAbort()) return;
    LOG("[MODE A] WARNING: GSM unavailable - falling back to WiFi at the same ping rate");
  }
  modeAUseWifi();
}

void modeAGsmFailed() {
  if (shouldAbort()) return;
  if (++gsmFails >= GSM_MAX_FAILS) {
    LOG("[MODE A] WARNING: GSM failed %d times - falling back to WiFi", gsmFails);
    gsmFails = 0;
    modeAUseWifi();
  }
}

void modeAReconnect() {
  if (aLink == LINK_GSM) {
    if (modem.testAT(500) && modem.isGprsConnected()) {
      if (mqttConnect(LINK_GSM)) { gsmFails = 0; return; }
    } else {
      LOG("[GSM] modem not answering or GPRS lost - brown-out/reset suspected, re-initialising");
      if (gsmBringUp() && mqttConnect(LINK_GSM)) { gsmFails = 0; aAnnounced = false; return; }
    }
    modeAGsmFailed();
  } else {
    if (WiFi.status() != WL_CONNECTED) {
      LOG("[WIFI] connection lost, reconnecting");
      wifiOff();
      if (!wifiBringUp()) { wifiOff(); aLink = LINK_NONE; aNextEstablish = millis() + 3000; return; }
    }
    mqttConnect(LINK_WIFI);
  }
}

// Every GSM_HEALTH_MS: log signal + registration, and catch a modem that has
// silently reset (a brown-out leaves it answering AT but with GPRS gone).
void modeAGsmHealth() {
  logGsmSignal();
  bool alive = modem.testAT(500);
  if (alive && modem.isGprsConnected()) return;
  LOG("[GSM] %s - brown-out/reset detected, re-initialising the modem",
      alive ? "GPRS context lost" : "modem not answering");
  if (gsmBringUp() && mqttConnect(LINK_GSM)) { gsmFails = 0; aAnnounced = false; return; }
  modeAGsmFailed();
}

void loopModeA() {
  uint32_t now = millis();

  if (aLink == LINK_NONE) {
    if ((int32_t)(now - aNextEstablish) >= 0) modeAEstablish();
    return;
  }

  if (aLink == LINK_GSM) {
    if (now - aLastHealth >= GSM_HEALTH_MS) {
      aLastHealth = now;
      modeAGsmHealth();
      if (aLink != LINK_GSM) return;
    }
  } else if (MODE_A_LINK == LINK_GSM && GSM_RETRY_MS > 0 && now - aLastGsmTry >= GSM_RETRY_MS) {
    LOG("[MODE A] retrying GSM (pings pause while the modem registers)");
    if (gsmBringUp()) {
      wifiOff();
      if (mqttConnect(LINK_GSM)) {
        aLink = LINK_GSM; gsmFails = 0; aAnnounced = false; aLastHealth = millis();
        LOG("[MODE A] back on GSM");
      } else {
        aLink = LINK_NONE; aNextEstablish = millis();
      }
    }
    aLastGsmTry = millis();
    return;
  }

  if (!mqtt.connected()) {
    if (now - aLastReconnect >= 3000) {
      aLastReconnect = now;
      if (mqttLink != LINK_NONE) LOG("[LINK] server connection lost");
      mqttLink = LINK_NONE;
      modeAReconnect();
    }
    return;
  }
  mqtt.loop();   // receives config messages (mode / buzzer / stolen)

  if (!aAnnounced) aAnnounced = publishModeStatus('A', aLink);

  if (now - aLastPing >= MODE_A_PERIOD_MS) {
    aLastPing = now;
    publishPosition(false, aLink);
  }
}

// ----------------------------------------------------------------------------
// MODE B - Locate
// ----------------------------------------------------------------------------
void radiosOffB() {
  mqttDrop();                       // closes the TCP session cleanly
  if (modemPowered) {
    delay(200);                     // let the modem push out the close
    // Power is CUT, not AT+CFUN=0 / sleep: a registered modem still talks to
    // the network periodically, and a detector would hear it.
    modemPower(false);
  }
  wifiOff();
}

void startTrip() {
  bState = B_MOVING;
  trailReset();                     // a new trip: start a new recorded route
  LOG("[MODE B] movement detected (%.1f km/h) - radio stays COMPLETELY SILENT%s", currentSpeedKmh(),
      TRAIL_ENABLED ? ", recording the route in memory" : "");
  ownerScanStartNow();
  if (!OWNER_CHECK_ENABLED) {
    LOG("[OWNER] %s", simOwnerPresent ? "simulated owner present -> no alert will be sent"
                                      : "no owner -> THEFT MODE");
  }
}

// Returns 1 = alert sent, 0 = failed, -1 = aborted (car moved / mode change)
int sendAlertB() {
  abortOnMotion = true;
  int result = 0;

  uint32_t jitter = (uint32_t)random(0, ALERT_JITTER_MAX_MS + 1);   // hardware RNG on ESP32
  LOG("[MODE B] waiting a random %lu ms before transmitting", (unsigned long)jitter);
  if (waitServiced(jitter)) {
    uint8_t link = MODE_B_LINK;
    bool up = (link == LINK_GSM) ? gsmBringUp() : wifiBringUp();
    if (up && !shouldAbort() && mqttConnect(link)) {
      if (publishPosition(true, link)) {
        result = 1;
        LOG("[MODE B] alert sent - listening %d ms for config", LISTEN_WINDOW_MS);
        uint32_t t0 = millis();
        while (millis() - t0 < LISTEN_WINDOW_MS) {
          mqtt.loop();
          backgroundTasks();
          if (isMoving()) break;    // moving again: go dark immediately
          delay(5);
        }
      }
    }
  }
  if (result != 1 && shouldAbort()) result = -1;
  radiosOffB();
  abortOnMotion = false;
  return result;
}

void loopModeB() {
  uint32_t now = millis();
  bool moving = isMoving();

  switch (bState) {
    case B_IDLE:
    case B_SENT:
      if (moving) startTrip();
      break;

    case B_MOVING:
      ownerScanService();
      trailRecord();
      if (!moving) {
        bDwellStart = now;
        bState = B_DWELL;
        LOG("[MODE B] speed below %d km/h - must stay there for %d ms", SPEED_THRESHOLD_KMH, DWELL_MS);
      }
      break;

    case B_DWELL:
      ownerScanService();
      if (moving) {
        bState = B_MOVING;
        LOG("[MODE B] moving again - dwell timer reset, still silent");
      } else if (now - bDwellStart >= DWELL_MS) {
        ownerScanStop();
        if (ownerPresent() && !stolenFlag) {
          LOG("[MODE B] vehicle stopped, OWNER PRESENT - no alert, radio stays off");
          bState = B_SENT;
        } else {
          LOG("[MODE B] vehicle stopped for %d ms -> sending ONE theft alert over %s (with %u recorded route points)",
              DWELL_MS, linkName(MODE_B_LINK), (unsigned)trailCount);
          bAttempts = 0;
          bState = B_SEND;
        }
      }
      break;

    case B_SEND: {
      int r = sendAlertB();
      if (r == 1) {
        bState = B_SENT;
        LOG("[MODE B] all radios OFF - no more alerts until the vehicle moves and stops again");
      } else if (r < 0) {
        bState = B_MOVING;          // not sent; a new stop will try again
        LOG("[MODE B] alert aborted, radios OFF");
      } else if (++bAttempts >= ALERT_MAX_ATTEMPTS) {
        bState = B_SENT;
        LOG("[MODE B] alert FAILED %d times - giving up for this stop, radios OFF", bAttempts);
      } else {
        bRetryAt = millis() + ALERT_RETRY_MS;
        bState = B_RETRY_WAIT;
        LOG("[MODE B] alert failed (attempt %d/%d) - radios OFF, retry in %d ms",
            bAttempts, ALERT_MAX_ATTEMPTS, ALERT_RETRY_MS);
      }
      break;
    }

    case B_RETRY_WAIT:
      if (moving) {
        bState = B_MOVING;
        LOG("[MODE B] moving again before the retry - silent");
      } else if ((int32_t)(now - bRetryAt) >= 0) {
        bState = B_SEND;
      }
      break;
  }
}

// ----------------------------------------------------------------------------
// Mode switching
// ----------------------------------------------------------------------------
void enterMode() {
  uint32_t now = millis();
  digitalWrite(PIN_LED_MODE, mode == 'B' ? HIGH : LOW);
  abortOnMotion = false;
  bleOwnerFound = false;
  // Mode A timers / link state
  aLink = LINK_NONE; aAnnounced = false; gsmFails = 0;
  aNextEstablish = now; aLastPing = now; aLastReconnect = now; aLastHealth = now; aLastGsmTry = now;
  // Mode B state
  bState = B_IDLE; bAttempts = 0; bDwellStart = now; bRetryAt = now;
  trailReset();

  if (mode == 'A') {
    LOG("[MODE] now in MODE A - ALWAYS-ON TRACKER: modem stays registered, ping every %d ms", MODE_A_PERIOD_MS);
  } else {
    LOG("[MODE] now in MODE B - LOCATE: all radios off; ONE alert %d ms after the vehicle stops", DWELL_MS);
    LOG("[MODE B] armed - the first alert needs the vehicle to move, then stop");
  }
}

void switchMode(char m) {
  LOG("[MODE] switching %c -> %c", mode, m);
  // Tell the app before going dark (only possible if a link is up right now).
  if (m == 'B' && mqttLink != LINK_NONE && mqtt.connected()) {
    publishModeStatus('B', mqttLink);
    uint32_t t0 = millis();
    while (millis() - t0 < 250) { mqtt.loop(); delay(5); }
  }
  // Clean teardown of every link; each mode then starts from "all off".
  ownerScanStop();
  mqttDrop();
  wifiOff();
  modemPower(false);
  mode = m;
  enterMode();
}

// ----------------------------------------------------------------------------
// setup / loop
// ----------------------------------------------------------------------------
void setup() {
  pinMode(PIN_MODEM_PWR, OUTPUT);
  digitalWrite(PIN_MODEM_PWR, !MODEM_PWR_ON_LEVEL);   // modem off until a mode asks for it
  pinMode(PIN_MODEM_TX, OUTPUT);
  digitalWrite(PIN_MODEM_TX, LOW);
  pinMode(PIN_MODEM_RST, INPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED_TX, OUTPUT);
  pinMode(PIN_LED_MODE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_LED_TX, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("=== Locate demo firmware ==="));

  SerialGPS.setRxBufferSize(1024);                    // survives the blocking modem calls
  SerialGPS.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  // Radios start off. Bluetooth is never started unless the owner check runs.
  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);

  snprintf(topicPing,   sizeof(topicPing),   "%s/%s/ping",   TOPIC_PREFIX, VEHICLE_ID);
  snprintf(topicAlert,  sizeof(topicAlert),  "%s/%s/alert",  TOPIC_PREFIX, VEHICLE_ID);
  snprintf(topicConfig, sizeof(topicConfig), "%s/%s/config", TOPIC_PREFIX, VEHICLE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "%s/%s/status", TOPIC_PREFIX, VEHICLE_ID);
  // Stable per-device client id (needed for the persistent session)
  snprintf(clientId, sizeof(clientId), "locate-%s-%04X", VEHICLE_ID,
           (unsigned)((ESP.getEfuseMac() >> 32) & 0xFFFF));

  mqtt.setBufferSize(1400);        // room for an alert that carries the recorded route
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);
  mqtt.setCallback(onMqttMessage);

  LOG("vehicle \"%s\", client id %s, topics %s/%s/...", VEHICLE_ID, clientId, TOPIC_PREFIX, VEHICLE_ID);
  printHelp();
  enterMode();
}

void loop() {
  backgroundTasks();

  if (pendingMode) {
    char m = pendingMode;
    pendingMode = 0;
    if (m != mode) switchMode(m);
  }

  if (mode == 'A') loopModeA();
  else             loopModeB();
}
