/*
 * LOCATE - Adversarial Counter-Surveillance Node  (indoor demo firmware)
 * ---------------------------------------------------------------------
 * ESP32 + ICM-20948 (I2C) + optional NEO-M8N (UART2).
 *
 * States
 *   PARKED         radio OFF, IMU watching for sustained vibration/motion
 *   PURSUIT        radio ON, telemetry burst every second
 *   STORE_FORWARD  network blackout while moving: modem uncoupled, route logged
 *                  to flash (LittleFS), burst-uploaded when the link returns
 *
 * Events (type in Serial Monitor, 115200 baud, line ending "No line ending"/any)
 *   m  toggle FORCE-MOVING (pretend the car is moving without shaking)
 *   j  simulate RF JAMMER on        u  jammer off (triggers shadow-log upload)
 *   p  simulate MAIN 12V CUT        r  restore main power
 *   s  status                       x  clear shadow log
 *   i  print one raw IMU reading (mg)
 *
 * Indoor demo: shake/carry the board for ~2 s -> PURSUIT. Stop for ~8 s -> PARKED.
 * With no GPS fix the position is a SIMULATED route (labelled src:"sim").
 *
 * WEB APP: with USE_NETWORK 1 this talks to the Locate web app (app/index.html)
 * through the same public broker the app uses. TOPIC_BASE must be
 * "<Topic prefix>/<Vehicle ID>" from the app's Settings (defaults below match).
 * The ESP32 does not need to be on the same network as the phones / laptop,
 * only on one with internet.
 *
 * Libraries (Library Manager):
 *   - TinyGPSPlus                      (Mikal Hart)
 *   (no IMU library needed: the ICM-20948 is read directly over I2C with Wire)
 *   - PubSubClient (Nick O'Leary)      only if USE_NETWORK = 1
 *
 * Wiring:  IMU SDA->GPIO21, SCL->GPIO22, VCC->3V3, GND->GND
 *          GPS TX->GPIO16, GPS RX->GPIO17, GND shared (power GPS from its own USB)
 *          Buzzer (active) + -> GPIO25, - -> GND.   LED = onboard GPIO2.
 */

// ---------------- User config ----------------
#define USE_NETWORK   1        // 0 = simulated network (Serial only), 1 = real Wi-Fi + MQTT (needed for the web app)
#define USE_GPS       1        // 1 = use NEO-M8N when it has a fix, else simulated route
#define ADC_TAMPER    0        // 1 = detect 12V cut with a divider on ADC_PIN

#define DEVICE_ID     "locate-01"
// Wi-Fi name and password live in wifi_secrets.h, next to this sketch. That file is
// NOT published (see .gitignore). First time: copy wifi_secrets.example.h to
// wifi_secrets.h and fill it in. The network must be 2.4 GHz, with internet and no
// browser login page.
#if __has_include("wifi_secrets.h")
  #include "wifi_secrets.h"
#else
  #define WIFI_SSID   "YOUR_WIFI_NAME"
  #define WIFI_PASS   "YOUR_WIFI_PASSWORD"
#endif
#define MQTT_HOST     "broker.hivemq.com"    // same public broker the web app uses
#define MQTT_PORT     1883
#define TOPIC_BASE    "locate-k7q2m9/car1"   // = app Settings "Topic prefix" / "Vehicle ID"; publishes .../telemetry and .../alert

#define SDA_PIN 21
#define SCL_PIN 22
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
#define GPS_BAUD   9600
#define BUZZER_PIN 25
#define LED_PIN    2
#define ADC_PIN    35                    // input-only pin is fine for ADC
#define DIVIDER_RATIO 5.7f               // (R1+R2)/R2, e.g. 47k + 10k
#define MAIN_PWR_MIN_V 8.0f              // below this = main supply cut

// Motion "edge filter": RMS of dynamic acceleration over 500 ms windows
#define VIB_THRESH_MG   60.0f            // above = active window
#define START_WINDOWS   4                // 4 x 500 ms = 2 s sustained -> moving
#define STOP_WINDOWS    16               // 16 x 500 ms = 8 s quiet -> parked

#define TELEM_MS        1000
#define BLACKOUT_FAILS  3                // consecutive failed sends -> STORE_FORWARD
#define LINK_GRACE_MS   15000            // after the radio switches on, give Wi-Fi + MQTT this long to connect
                                         // before failed sends count as a blackout
#define PROBE_MS        8000             // modem wake-up probe period in STORE_FORWARD
#define MAX_LOG_BYTES   200000

// Simulated route (used when there is no GPS fix)
#define DEMO_LAT   12.971600
#define DEMO_LON   77.594600
#define DEMO_SPEED_KMH 60.0f
// ---------------------------------------------

#include <Wire.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>
#if USE_NETWORK
  #include <WiFi.h>
  #include <PubSubClient.h>
#endif

enum State { PARKED, PURSUIT, STORE_FORWARD };
static const char *STATE_NAME[] = { "PARKED", "PURSUIT", "STORE_FORWARD" };

// Declared up here (before any function) so the Arduino IDE's auto-generated
// prototypes, which it places above the first function, can see this type.
struct Pos { double lat, lon; float spd; const char *src; };

bool imuOk = false;
uint8_t icmAddr = 0x69;       // 0x69 if AD0 is high (most breakouts), 0x68 if AD0 is low

// ---------- ICM-20948 raw I2C driver (accelerometer only) ----------
// Registers (user bank 0 unless noted)
#define ICM_WHO_AM_I      0x00   // should read 0xEA
#define ICM_USER_CTRL     0x03
#define ICM_PWR_MGMT_1    0x06
#define ICM_PWR_MGMT_2    0x07
#define ICM_INT_STATUS_1  0x1A   // bit0 = new raw data ready
#define ICM_ACCEL_XOUT_H  0x2D   // 6 bytes: X_H X_L Y_H Y_L Z_H Z_L
#define ICM_REG_BANK_SEL  0x7F
// user bank 2
#define ICM_ACCEL_CONFIG  0x14   // FS_SEL bits[2:1]: 00 = +-2 g (16384 LSB/g)

bool icmWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(icmAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool icmRead(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(icmAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated start
  if (Wire.requestFrom((int)icmAddr, (int)len) != len) return false;   // (int,int) overload works on ESP32 core 2.x and 3.x
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

void icmBank(uint8_t bank) { icmWrite(ICM_REG_BANK_SEL, bank << 4); }

void i2cScan() {
  Serial.print(F("I2C scan:"));
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf(" 0x%02X", a); found++; }
  }
  Serial.println(found ? "" : " nothing found - check SDA/SCL/3V3/GND");
}

bool icmInit() {
  const uint8_t addrs[2] = { 0x69, 0x68 };
  for (uint8_t i = 0; i < 2; i++) {
    icmAddr = addrs[i];
    icmBank(0);
    uint8_t who = 0;
    if (!icmRead(ICM_WHO_AM_I, &who, 1)) continue;
    Serial.printf("WHO_AM_I @0x%02X = 0x%02X\n", icmAddr, who);
    if (who != 0xEA) continue;

    icmWrite(ICM_PWR_MGMT_1, 0x80);   // device reset
    delay(100);
    icmBank(0);
    icmWrite(ICM_PWR_MGMT_1, 0x01);   // wake, auto-select best clock
    delay(20);
    icmWrite(ICM_PWR_MGMT_2, 0x00);   // accel + gyro enabled
    icmWrite(ICM_USER_CTRL, 0x00);    // no DMP / I2C master

    icmBank(2);
    icmWrite(ICM_ACCEL_CONFIG, 0x01); // +-2 g, DLPF on (reset default)
    icmBank(0);
    delay(20);
    return true;
  }
  return false;
}

// Returns acceleration in mg. false if the read failed.
bool icmReadAccel(float &ax, float &ay, float &az) {
  uint8_t b[6];
  if (!icmRead(ICM_ACCEL_XOUT_H, b, 6)) return false;
  int16_t x = (int16_t)((b[0] << 8) | b[1]);
  int16_t y = (int16_t)((b[2] << 8) | b[3]);
  int16_t z = (int16_t)((b[4] << 8) | b[5]);
  const float LSB_PER_MG = 16.384f;   // 16384 LSB/g at +-2 g
  ax = x / LSB_PER_MG; ay = y / LSB_PER_MG; az = z / LSB_PER_MG;
  return true;
}

HardwareSerial GPSSerial(2);
TinyGPSPlus gps;

#if USE_NETWORK
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
#endif

State state = PARKED;
bool radioIsOn = false;
uint32_t radioOnAt = 0;       // when the radio was last switched on
bool linkSeen = false;        // the link has worked at least once since then
bool jammed = false;          // simulated jammer
bool simPowerCut = false;     // simulated 12V cut
bool mainPower = true;
bool forceMoving = false;
bool moving = false;

float lastRms = 0;
double lastLat = DEMO_LAT, lastLon = DEMO_LON;
double simLat = DEMO_LAT, simLon = DEMO_LON;
float simHeading = 45.0f;
uint32_t seqNo = 0;
int consecFails = 0;

const char *LOG_FILE = "/shadow.log";

// ---------- helpers ----------
void chirp(int n, int onMs = 60) {
  for (int i = 0; i < n; i++) {
    digitalWrite(BUZZER_PIN, HIGH); delay(onMs);
    digitalWrite(BUZZER_PIN, LOW);  delay(70);
  }
}

size_t logSize() {
  File f = LittleFS.open(LOG_FILE, "r");
  if (!f) return 0;
  size_t s = f.size(); f.close(); return s;
}

void appendLog(const char *line) {
  if (logSize() > MAX_LOG_BYTES) return;
  File f = LittleFS.open(LOG_FILE, "a");
  if (!f) return;
  f.println(line);
  f.close();
}

// ---------- network layer (real or simulated) ----------
void radioOn() {
  if (radioIsOn) return;
  radioIsOn = true;
  radioOnAt = millis();
  linkSeen = false;
#if USE_NETWORK
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setSocketTimeout(2);
#endif
  Serial.println(F("[RADIO] ON"));
}

void radioOff() {
  if (!radioIsOn) return;
  radioIsOn = false;
#if USE_NETWORK
  mqtt.disconnect();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
#endif
  Serial.println(F("[RADIO] OFF (zero RF signature)"));
}

void serviceNet() {
  if (!radioIsOn || jammed) return;
#if USE_NETWORK
  if (WiFi.status() != WL_CONNECTED) return;
  if (!mqtt.connected()) mqtt.connect(DEVICE_ID);
  mqtt.loop();
#endif
}

bool netUp() {
  if (!radioIsOn || jammed) return false;
#if USE_NETWORK
  return WiFi.status() == WL_CONNECTED && mqtt.connected();
#else
  return true;
#endif
}

bool publishMsg(const char *sub, const char *payload) {
  if (!netUp()) return false;
  linkSeen = true;
  Serial.printf("[PUB %s] %s\n", sub, payload);
#if USE_NETWORK
  char topic[64];
  snprintf(topic, sizeof(topic), "%s/%s", TOPIC_BASE, sub);
  return mqtt.publish(topic, payload);
#else
  return true;
#endif
}

// real: wait up to 4 s for a link; simulated: instant
bool probeNet() {
  radioOn();
  uint32_t t = millis();
  do {
    serviceNet();
    if (netUp()) return true;
    delay(100);
  } while (millis() - t < 4000 && USE_NETWORK);
  return netUp();
}

// ---------- position ----------
Pos currentPos(bool advanceSim) {
  Pos p;
#if USE_GPS
  if (gps.location.isValid() && gps.location.age() < 3000) {
    p.lat = gps.location.lat(); p.lon = gps.location.lng();
    p.spd = gps.speed.isValid() ? gps.speed.kmph() : 0;
    p.src = "gps";
    lastLat = p.lat; lastLon = p.lon;
    return p;
  }
#endif
  if (advanceSim) {
    float v = DEMO_SPEED_KMH / 3.6f * (TELEM_MS / 1000.0f);   // metres this tick
    simHeading += 2.0f;                                        // gentle turn
    double h = simHeading * DEG_TO_RAD;
    simLat += v * cos(h) / 111320.0;
    simLon += v * sin(h) / (111320.0 * cos(simLat * DEG_TO_RAD));
  }
  p.lat = simLat; p.lon = simLon;
  p.spd = (state == PARKED) ? 0 : DEMO_SPEED_KMH;
  p.src = "sim";
  lastLat = p.lat; lastLon = p.lon;
  return p;
}

void buildTelemetry(char *buf, size_t n, const Pos &p) {
  snprintf(buf, n,
    "{\"id\":\"%s\",\"seq\":%lu,\"t\":%lu,\"state\":\"%s\",\"lat\":%.6f,\"lon\":%.6f,"
    "\"spd\":%.1f,\"src\":\"%s\",\"vib\":%.0f,\"pwr\":\"%s\"}",
    DEVICE_ID, (unsigned long)seqNo++, (unsigned long)millis(), STATE_NAME[state],
    p.lat, p.lon, p.spd, p.src, lastRms, mainPower ? "main" : "lipo");
}

// send now, or store to flash if the link is down
bool sendOrStore(const char *payload) {
  if (publishMsg("telemetry", payload)) { consecFails = 0; return true; }
  appendLog(payload);
  consecFails++;
  return false;
}

// burst-upload the shadow log; delete it only if everything went out
void flushShadowLog() {
  File f = LittleFS.open(LOG_FILE, "r");
  if (!f) return;
  int sent = 0; bool ok = true;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (!line.length()) continue;
    if (!publishMsg("telemetry", line.c_str())) { ok = false; break; }
    sent++;
  }
  f.close();
  if (ok) {
    LittleFS.remove(LOG_FILE);
    Serial.printf("[FORWARD] shadow log uploaded: %d points, log cleared\n", sent);
  } else {
    Serial.printf("[FORWARD] upload interrupted after %d points, log kept\n", sent);
  }
}

// ---------- tamper ----------
void sendTamperAlert() {
  char buf[200];
  snprintf(buf, sizeof(buf),
    "{\"id\":\"%s\",\"alert\":\"MAIN_POWER_CUT\",\"priority\":\"high\",\"t\":%lu,"
    "\"lat\":%.6f,\"lon\":%.6f}",
    DEVICE_ID, (unsigned long)millis(), lastLat, lastLon);
  Serial.println(F("[TAMPER] main 12V lost -> LiPo failover, sending alert"));
  chirp(3, 120);
  bool wasOn = radioIsOn;
  if (!wasOn) probeNet();
  if (!publishMsg("alert", buf)) {
    appendLog(buf);   // goes out with the shadow log when the link returns
    Serial.println(F("[TAMPER] alert stored (no link)"));
  }
  if (!wasOn && state == PARKED) radioOff();
}

void checkPower() {
  float volts = 12.0f;
#if ADC_TAMPER
  volts = analogReadMilliVolts(ADC_PIN) / 1000.0f * DIVIDER_RATIO;
#endif
  bool ok = !simPowerCut && volts > MAIN_PWR_MIN_V;
  if (mainPower && !ok) { mainPower = false; sendTamperAlert(); }
  else if (!mainPower && ok) { mainPower = true; Serial.println(F("[POWER] main restored")); }
}

// ---------- motion detection ----------
void updateMotion() {
  static float gEst = 1000.0f;           // gravity estimate, mg
  static double sumSq = 0; static int n = 0;
  static uint32_t winStart = millis();
  static int active = 0, quiet = 0;

  static uint32_t lastSample = 0;
  float ax, ay, az;
  if (imuOk && millis() - lastSample >= 5 && icmReadAccel(ax, ay, az)) {   // ~200 Hz polling
    lastSample = millis();
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    gEst += 0.005f * (mag - gEst);
    float dyn = mag - gEst;
    sumSq += dyn * dyn; n++;
  }

  if (millis() - winStart >= 500) {
    winStart = millis();
    lastRms = n ? sqrtf(sumSq / n) : 0;
    sumSq = 0; n = 0;

    if (lastRms > VIB_THRESH_MG) { active++; quiet = 0; }
    else                         { quiet++;  active = 0; }

    if (!moving && active >= START_WINDOWS) moving = true;
    if (moving && quiet >= STOP_WINDOWS)    moving = false;
  }
}

// ---------- serial commands ----------
void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 'm': forceMoving = !forceMoving;
                Serial.printf("[CMD] force-moving %s\n", forceMoving ? "ON" : "OFF"); break;
      case 'j': jammed = true;  Serial.println(F("[CMD] JAMMER ON (network blackout)")); break;
      case 'u': jammed = false; Serial.println(F("[CMD] jammer OFF")); break;
      case 'p': simPowerCut = true;  Serial.println(F("[CMD] main 12V CUT")); break;
      case 'r': simPowerCut = false; Serial.println(F("[CMD] main 12V restored")); break;
      case 'i': {
        float ax, ay, az;
        if (imuOk && icmReadAccel(ax, ay, az))
          Serial.printf("[IMU] ax=%.0f ay=%.0f az=%.0f mg  |a|=%.0f mg\n", ax, ay, az, sqrtf(ax*ax+ay*ay+az*az));
        else Serial.println(F("[IMU] read failed"));
        break;
      }
      case 'x': LittleFS.remove(LOG_FILE); Serial.println(F("[CMD] shadow log cleared")); break;
      case 's':
        Serial.printf("[STATUS] state=%s moving=%d rms=%.0fmg radio=%d link=%d jam=%d power=%s log=%uB imu=%d\n",
          STATE_NAME[state], moving || forceMoving, lastRms, radioIsOn, netUp(), jammed,
          mainPower ? "main" : "lipo", (unsigned)logSize(), imuOk);
#if USE_NETWORK
        if (radioIsOn) Serial.printf("         wifi=%s mqtt=%s (state %d)\n",
          WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected",
          mqtt.connected() ? "connected" : "NOT connected", mqtt.state());
#endif
        break;
    }
  }
}

void enterState(State s) {
  if (s == state) return;
  Serial.printf("[STATE] %s -> %s\n", STATE_NAME[state], STATE_NAME[s]);
  state = s;
  consecFails = 0;
  chirp(s == PURSUIT ? 2 : 1);
}

// ---------- Arduino ----------
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);
  delay(300);
  Serial.println(F("\nLOCATE demo firmware"));

  if (!LittleFS.begin(true)) Serial.println(F("LittleFS mount failed"));

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  i2cScan();
  imuOk = icmInit();
  Serial.println(imuOk ? F("ICM-20948 OK")
                       : F("ICM-20948 NOT FOUND - check wiring; use 'm' to force moving"));

#if USE_GPS
  GPSSerial.setRxBufferSize(1024);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
#endif
#if USE_NETWORK
  Serial.printf("Network: Wi-Fi \"%s\" -> %s:%d, topics %s/telemetry and %s/alert\n",
                WIFI_SSID, MQTT_HOST, MQTT_PORT, TOPIC_BASE, TOPIC_BASE);
#else
  Serial.println(F("Network: SIMULATED (Serial only). Set USE_NETWORK 1 to reach the web app."));
#endif
  Serial.println(F("Commands: m=force move  j/u=jammer on/off  p/r=12V cut/restore  s=status  i=IMU  x=clear log"));
  chirp(1, 100);
}

void loop() {
#if USE_GPS
  while (GPSSerial.available()) gps.encode(GPSSerial.read());
#endif
  handleSerial();
  updateMotion();
  checkPower();

  bool isMoving = moving || forceMoving;
  uint32_t now = millis();
  static uint32_t lastTelem = 0, lastProbe = 0, lastNet = 0;

  // ---- state transitions ----
  switch (state) {
    case PARKED:
      if (isMoving) { enterState(PURSUIT); radioOn(); }
      break;

    case PURSUIT:
      if (!isMoving) {
        if (logSize() && probeNet()) flushShadowLog();
        radioOff(); enterState(PARKED);
      } else if (consecFails >= BLACKOUT_FAILS && (linkSeen || now - radioOnAt >= LINK_GRACE_MS)) {
        // network blackout while still moving: uncouple the modem, log locally.
        // (Not while Wi-Fi is still connecting for the first time after the radio came on.)
        Serial.println(F("[JAMMER?] blackout while in motion -> modem uncoupled, store & forward"));
        radioOff(); enterState(STORE_FORWARD); lastProbe = now;
      }
      break;

    case STORE_FORWARD:
      if (now - lastProbe >= PROBE_MS) {
        lastProbe = now;
        if (probeNet()) { flushShadowLog(); enterState(PURSUIT); }
        else radioOff();
      }
      if (!isMoving) {
        if (probeNet()) flushShadowLog();
        radioOff(); enterState(PARKED);
      }
      break;
  }

  // ---- periodic work ----
  if (radioIsOn && now - lastNet >= 500) { lastNet = now; serviceNet(); }

  if (state != PARKED && now - lastTelem >= TELEM_MS) {
    lastTelem = now;
    Pos p = currentPos(true);
    char buf[256];
    buildTelemetry(buf, sizeof(buf), p);
    if (state == PURSUIT) {
      if (logSize() && netUp()) flushShadowLog();
      sendOrStore(buf);
    } else {
      appendLog(buf);   // STORE_FORWARD: modem off, just log the route
      Serial.printf("[LOG] %s\n", buf);
    }
  } else if (state == PARKED) {
    currentPos(false);  // keep last-known position fresh from GPS if it has a fix
  }

  // ---- LED status ----
  uint32_t period = (state == PARKED) ? 0 : (state == PURSUIT ? 500 : 150);
  digitalWrite(LED_PIN, period ? ((now / period) & 1) : LOW);
  delay(2);
}
