/*
 * ESP1 - COMMAND NODE / TRACKER
 * Hosts the "StealthNode_Command" hotspot + web control page (http://192.168.4.1),
 * sends motor commands (type 1) to the car and RF telemetry bursts (type 2) that the scanner detects.
 *
 * Library needed: "WebSockets" by Markus Sattler (Library Manager)
 * Keyboard on the web page: W A S D / arrows = drive, Space or X = stop
 */

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <esp_now.h>
#include <Wire.h>

// ---------------- Config ----------------
#define USE_PWR_SENSE    0     // 1 = read 12V bus on GPIO34 through an EXTERNAL divider (HIGH = OK)
#define MAIN_PWR_PIN     34
#define USE_IMU_MOTION   1     // 1 = IMU shake also triggers PURSUIT, 0 = only driving does
#define STEALTH_TX_MS    0     // adaptive mode: 0 = radio silent while parked
#define PURSUIT_HOLD_MS  400   // stay in PURSUIT this long after motion stops
#define ESPNOW_CHANNEL   1
#define MOTOR_REPEAT_MS  100   // resend held drive command to the car every 100 ms
#define STOP_REPEATS     5
#define DRIVE_TIMEOUT_MS 700   // browser silent this long while driving -> auto STOP

const char* ssid = "StealthNode_Command";
const char* password = "password123";
// ----------------------------------------

WebServer server(80);
WebSocketsServer ws(81);
uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
esp_now_peer_info_t peerInfo;

typedef struct struct_packet {
  uint8_t packetType; // 1 = Motor Command, 2 = RF Telemetry Burst
  char driveCmd;      // 'F', 'B', 'L', 'R', 'S'
  uint8_t speedPWM;   // 0 - 255 motor speed
  uint32_t pktId;
  float lat;
  float lon;
  bool tamperAlert;
} struct_packet;

struct_packet txPacket;

enum ImuType { IMU_NONE, IMU_MPU6050, IMU_ICM20948 };
ImuType imuType = IMU_NONE;
uint8_t imuAddr = 0x68;

enum SystemMode { MODE_DISARMED, MODE_ARMED };
SystemMode currentMode = MODE_ARMED;
enum TrackerState { STATE_IDLE, STATE_STEALTH, STATE_PURSUIT, STATE_TAMPER_ALERT };
TrackerState currentState = STATE_STEALTH;
const char *STATE_TXT[] = { "IDLE", "STEALTH", "PURSUIT", "TAMPER" };

enum TxMode { TX_ADAPTIVE, TX_CONTINUOUS };
TxMode txMode = TX_ADAPTIVE;
unsigned long contIntervalMs = 200;

uint8_t currentThrottlePWM = 160;
const uint8_t SPEED_THRESHOLD = 120;
char currentDriveDir = 'S';
unsigned long lastMotorTx = 0, lastDriveCmdTime = 0;
uint8_t stopRepeatsLeft = 0;
unsigned long motorPkts = 0;

float motionMagnitude = 0.0;
const float IMU_THRESHOLD = 1.5;
unsigned long lastMotionTime = 0, lastTransmitTime = 0, packetCounter = 0, sendErrors = 0;
unsigned long dynamicTxInterval = 0;
bool mainPowerIntact = true;
bool simPowerCut = false;
float simLat = 12.9716, simLon = 77.5946;

const char index_html[] PROGMEM = R"rawliteral(<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stealth Command</title><style>
body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding:10px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin:10px auto;max-width:440px}
.badge{font-weight:bold;padding:10px;border-radius:6px;display:block;margin:8px 0}
.stealth{background:#1f6feb;color:#fff}.pursuit{background:#da3633;color:#fff}.idle{background:#238636;color:#fff}
.btn{padding:10px 14px;margin:4px;border:2px solid transparent;border-radius:6px;cursor:pointer;font-weight:bold;color:#fff}
.on{border-color:#fff}
.dpad{display:grid;grid-template-columns:repeat(3,75px);gap:6px;justify-content:center;margin-top:8px}
.dpad button{height:55px;background:#21262d;color:#fff;border:1px solid #30363d;border-radius:6px;font-weight:bold;user-select:none;-webkit-user-select:none;touch-action:none}
.dpad button.act{background:#58a6ff;color:#000}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;font-size:0.88rem}
.box{background:#0d1117;padding:8px;border-radius:6px;border:1px solid #21262d}
input[type=range]{width:90%;margin:10px 0;accent-color:#58a6ff}
#link{font-size:0.8rem}
</style></head><body>
<h3>SPEED-ADAPTIVE RF TELEMETRY</h3>
<div id="link">link: connecting...</div>
<div class="card">
  <div id="stateBadge" class="badge stealth">READY</div>
  <div class="grid">
    <div class="box"><b>Mode:</b> <span id="sysMode">ARMED</span></div>
    <div class="box"><b>12V Bus:</b> <span id="pwrStat">OK</span></div>
    <div class="box"><b>Speed / IMU:</b> <span id="imuVal">0</span></div>
    <div class="box"><b>TX Interval:</b> <span id="txInt">-</span></div>
  </div>
  <div class="box" style="margin-top:8px;text-align:left">
    <b>RF Bursts:</b> <span id="pktCnt">0</span> &nbsp; <b>Motor pkts:</b> <span id="motCnt">0</span>
    &nbsp; <b>Drive:</b> <span id="drv">S</span> &nbsp; <b>IMU:</b> <span id="imuType">-</span>
  </div>
</div>
<div class="card">
  <div><b>TRANSMIT MODE</b></div>
  <button id="bAd" class="btn" style="background:#1f6feb" onclick="send('TA')">ADAPTIVE (threat-aware)</button>
  <button id="bCo" class="btn" style="background:#8957e5" onclick="send('TC')">CONTINUOUS</button>
  <div style="margin-top:6px"><b>Continuous interval: <span id="ciTxt">200</span> ms</b></div>
  <input type="range" min="50" max="2000" step="50" value="200" id="ci"
         oninput="document.getElementById('ciTxt').innerText=this.value"
         onchange="send('I'+this.value)">
</div>
<div class="card">
  <button class="btn" style="background:#d29922" onclick="send('A')">ARM (Stealth Trap)</button>
  <button class="btn" style="background:#238636" onclick="send('D')">DISARM</button><br>
  <button class="btn" style="background:#da3633" onclick="send('C')">SIM 12V CUT</button>
  <button class="btn" style="background:#30363d" onclick="send('R')">RESTORE 12V</button>
</div>
<div class="card">
  <div><b>VEHICLE SPEED (PWM): <span id="spdTxt">160</span> / 255</b></div>
  <div style="font-size:0.8rem;color:#8b949e">Keyboard: W A S D / arrows = drive, Space or X = stop</div>
  <input type="range" min="70" max="255" value="160" id="spdSlider"
         oninput="document.getElementById('spdTxt').innerText=this.value;send('s'+this.value)">
  <div class="dpad">
    <div></div><button data-d="F">FWD</button><div></div>
    <button data-d="L">LEFT</button>
    <button data-d="S" style="background:#da3633">STOP</button>
    <button data-d="R">RIGHT</button>
    <div></div><button data-d="B">REV</button><div></div>
  </div>
</div>
<script>
let ws=null;
function setLink(t){document.getElementById('link').innerText='link: '+t}
function connect(){
  ws=new WebSocket('ws://'+location.hostname+':81/');
  ws.onopen=()=>setLink('live (websocket)');
  ws.onclose=()=>{setLink('reconnecting...');setTimeout(connect,1000)};
  ws.onerror=()=>{try{ws.close()}catch(e){}};
  ws.onmessage=e=>{try{upd(JSON.parse(e.data))}catch(x){}};
}
connect();
function send(s){
  if(ws&&ws.readyState===1) ws.send(s);
  else fetch('/cmd?c='+encodeURIComponent(s)).catch(()=>{});
}
function spd(){return document.getElementById('spdSlider').value}
let lastDrive='S';
function drive(d){
  if(d===lastDrive) return;
  lastDrive=d; send('m'+d+spd());
  document.querySelectorAll('[data-d]').forEach(b=>b.classList.toggle('act',b.dataset.d===d&&d!=='S'));
}
setInterval(()=>{if(lastDrive!=='S') send('m'+lastDrive+spd())},200);

document.querySelectorAll('[data-d]').forEach(b=>{
  b.addEventListener('pointerdown',e=>{e.preventDefault();try{b.setPointerCapture(e.pointerId)}catch(x){};drive(b.dataset.d)});
  ['pointerup','pointercancel'].forEach(ev=>b.addEventListener(ev,e=>{e.preventDefault();drive('S')}));
  b.addEventListener('contextmenu',e=>e.preventDefault());
});

const KEY={w:'F',a:'L',s:'B',d:'R',arrowup:'F',arrowleft:'L',arrowdown:'B',arrowright:'R'};
let held=[];
function cur(){return held.length?KEY[held[held.length-1]]:'S'}
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT') return;
  const k=e.key.toLowerCase();
  if(k===' '||k==='x'){e.preventDefault();held=[];drive('S');return}
  if(!(k in KEY)) return;
  e.preventDefault();
  if(e.repeat) return;
  held=held.filter(x=>x!==k); held.push(k); drive(cur());
});
document.addEventListener('keyup',e=>{
  const k=e.key.toLowerCase();
  if(!(k in KEY)) return;
  held=held.filter(x=>x!==k); drive(cur());
});
window.addEventListener('blur',()=>{held=[];drive('S')});

function upd(d){
  document.getElementById('sysMode').innerText=d.mode;
  document.getElementById('imuVal').innerText=d.imu;
  document.getElementById('txInt').innerText=d.txms>0?d.txms+' ms':'RADIO SILENT';
  document.getElementById('pktCnt').innerText=d.pkts;
  document.getElementById('motCnt').innerText=d.mpkts;
  document.getElementById('drv').innerText=d.drv;
  document.getElementById('imuType').innerText=d.imutype;
  document.getElementById('pwrStat').innerText=d.pwr?"12V OK":"CUT! (LIPO)";
  document.getElementById('bAd').className='btn'+(d.txmode=='adaptive'?' on':'');
  document.getElementById('bCo').className='btn'+(d.txmode=='cont'?' on':'');
  let b=document.getElementById('stateBadge');
  b.innerText=d.state; b.className='badge '+d.cls;
}
setInterval(()=>{if(!ws||ws.readyState!==1) fetch('/status').then(r=>r.json()).then(upd).catch(()=>{})},500);
</script></body></html>)rawliteral";

// ---------- IMU (auto-detects ICM-20948 or MPU6050-family) ----------
bool imuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(imuAddr);
  Wire.write(reg); Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool imuRead(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(imuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)imuAddr, (int)len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

bool initIMU() {
  Wire.begin(21, 22);
  Wire.setClock(400000);
  Wire.setTimeOut(5);

  const uint8_t addrs[2] = { 0x68, 0x69 };
  for (uint8_t i = 0; i < 2; i++) {
    imuAddr = addrs[i];
    uint8_t who = 0;

    imuWrite(0x7F, 0x00);
    if (imuRead(0x00, &who, 1) && who == 0xEA) {
      imuWrite(0x06, 0x80); delay(100);
      imuWrite(0x7F, 0x00);
      imuWrite(0x06, 0x01); delay(20);
      imuWrite(0x07, 0x00);
      imuWrite(0x7F, 0x20);
      imuWrite(0x14, 0x05);   // +-8 g, 4096 LSB/g
      imuWrite(0x7F, 0x00);
      imuType = IMU_ICM20948;
      Serial.printf("IMU: ICM-20948 @0x%02X\n", imuAddr);
      return true;
    }

    if (imuRead(0x75, &who, 1) &&
        (who == 0x68 || who == 0x70 || who == 0x71 || who == 0x72 || who == 0x73 || who == 0x98)) {
      imuWrite(0x6B, 0x00); delay(10);
      imuWrite(0x1C, 0x10);   // +-8 g, 4096 LSB/g
      imuType = IMU_MPU6050;
      Serial.printf("IMU: MPU-family (WHO_AM_I 0x%02X) @0x%02X\n", who, imuAddr);
      return true;
    }
  }
  Serial.println("IMU: none found - motion only from driving");
  return false;
}

bool readAccelG(float &ax, float &ay, float &az) {
  uint8_t b[6];
  uint8_t reg = (imuType == IMU_ICM20948) ? 0x2D : 0x3B;
  if (!imuRead(reg, b, 6)) return false;
  ax = (int16_t)((b[0] << 8) | b[1]) / 4096.0f;
  ay = (int16_t)((b[2] << 8) | b[3]) / 4096.0f;
  az = (int16_t)((b[4] << 8) | b[5]) / 4096.0f;
  return true;
}

void updateMotion() {
  static unsigned long lastSample = 0;
  static float gEst = 9.81f;
  if (imuType == IMU_NONE || millis() - lastSample < 10) return;
  lastSample = millis();
  float ax, ay, az;
  if (!readAccelG(ax, ay, az)) return;
  float mag = sqrtf(ax * ax + ay * ay + az * az) * 9.81f;
  gEst += 0.01f * (mag - gEst);
  float dyn = fabsf(mag - gEst);
  motionMagnitude = 0.8f * motionMagnitude + 0.2f * dyn;
}

// ---------- power ----------
void updatePower() {
  bool hwOk = true;
#if USE_PWR_SENSE
  static unsigned long lastRead = 0;
  static uint8_t lowCount = 0;
  if (millis() - lastRead >= 10) {
    lastRead = millis();
    if (digitalRead(MAIN_PWR_PIN) == LOW) { if (lowCount < 5) lowCount++; }
    else lowCount = 0;
  }
  hwOk = lowCount < 5;
#endif
  mainPowerIntact = hwOk && !simPowerCut;
}

// ---------- ESP-NOW ----------
void transmitMotor() {
  txPacket.packetType = 1;
  txPacket.driveCmd = currentDriveDir;
  txPacket.speedPWM = currentThrottlePWM;
  esp_err_t r = esp_now_send(broadcastAddress, (uint8_t *)&txPacket, sizeof(txPacket));
  if (r != ESP_OK) sendErrors++;
  motorPkts++;
  lastMotorTx = millis();
}

void setDrive(char c, uint8_t spd) {
  currentDriveDir = c;
  currentThrottlePWM = spd;
  if (c == 'S') stopRepeatsLeft = STOP_REPEATS;
  Serial.printf("[MOTOR] %c @ PWM %u\n", c, spd);
  transmitMotor();
}

void serviceMotor() {
  unsigned long now = millis();

  if (currentDriveDir != 'S' && now - lastDriveCmdTime > DRIVE_TIMEOUT_MS) {
    Serial.println("[MOTOR] no refresh from browser -> STOP");
    setDrive('S', currentThrottlePWM);
    return;
  }

  if (now - lastMotorTx < MOTOR_REPEAT_MS) return;
  if (currentDriveDir != 'S') {
    transmitMotor();
  } else if (stopRepeatsLeft > 0) {
    stopRepeatsLeft--;
    transmitMotor();
  }
}

void sendRFTelemetryBurst() {
  packetCounter++; simLat += 0.0001; simLon += 0.0001;
  txPacket.packetType = 2;
  txPacket.driveCmd = currentDriveDir;
  txPacket.speedPWM = currentThrottlePWM;
  txPacket.pktId = packetCounter;
  txPacket.lat = simLat; txPacket.lon = simLon;
  txPacket.tamperAlert = !mainPowerIntact;
  esp_err_t r = esp_now_send(broadcastAddress, (uint8_t *)&txPacket, sizeof(txPacket));
  if (r != ESP_OK) sendErrors++;
  Serial.printf("[TX] #%lu %s %s every %lu ms | PWM %u | %s\n",
                packetCounter, txMode == TX_CONTINUOUS ? "CONT" : "ADAPT", STATE_TXT[currentState],
                dynamicTxInterval, currentThrottlePWM, r == ESP_OK ? "ok" : esp_err_to_name(r));
}

// ---------- commands (from WebSocket or /cmd fallback) ----------
// mF160 = drive F at 160 | s160 = speed | TA / TC = tx mode | I200 = cont interval
// A = arm | D = disarm | C = sim 12V cut | R = restore
void handleCmd(const String &c) {
  if (c.length() == 0) return;
  char t = c[0];
  unsigned long now = millis();

  if (t == 'm' && c.length() >= 2) {
    char d = c[1];
    if (d != 'F' && d != 'B' && d != 'L' && d != 'R' && d != 'S') return;
    uint8_t s = (c.length() > 2) ? constrain(c.substring(2).toInt(), 0, 255) : currentThrottlePWM;
    lastDriveCmdTime = now;
    if (d != currentDriveDir || s != currentThrottlePWM) setDrive(d, s);
    if (d != 'S' && s >= SPEED_THRESHOLD) lastMotionTime = now;
  } else if (t == 's') {
    uint8_t s = constrain(c.substring(1).toInt(), 0, 255);
    if (s == currentThrottlePWM) return;
    if (currentDriveDir != 'S') { lastDriveCmdTime = now; setDrive(currentDriveDir, s); }
    else currentThrottlePWM = s;
  } else if (t == 'T') {
    txMode = (c.length() > 1 && c[1] == 'C') ? TX_CONTINUOUS : TX_ADAPTIVE;
    lastTransmitTime = 0;
    Serial.printf("[TXMODE] %s\n", txMode == TX_CONTINUOUS ? "CONTINUOUS" : "ADAPTIVE");
  } else if (t == 'I') {
    contIntervalMs = constrain(c.substring(1).toInt(), 50, 5000);
    Serial.printf("[TXMODE] continuous interval %lu ms\n", contIntervalMs);
  } else if (t == 'A') { currentMode = MODE_ARMED;    Serial.println("[MODE] ARMED"); }
  else if (t == 'D')   { currentMode = MODE_DISARMED; Serial.println("[MODE] DISARMED"); }
  else if (t == 'C')   { simPowerCut = true;  Serial.println("[SIM] 12V CUT"); }
  else if (t == 'R')   { simPowerCut = false; Serial.println("[SIM] 12V RESTORED"); }
}

void buildStatus(char *buf, size_t n) {
  const char *st = "DISARMED", *cls = "idle";
  if (currentState == STATE_TAMPER_ALERT) { st = "12V CUT - MAX RF STREAM"; cls = "pursuit"; }
  else if (txMode == TX_CONTINUOUS)       { st = "CONTINUOUS RF STREAM"; cls = "pursuit"; }
  else if (currentState == STATE_PURSUIT) { st = "PURSUIT (SPEED-SCALED RF)"; cls = "pursuit"; }
  else if (currentState == STATE_STEALTH) { st = "STEALTH (RADIO SILENT)"; cls = "stealth"; }
  const char *it = imuType == IMU_ICM20948 ? "ICM-20948" : imuType == IMU_MPU6050 ? "MPU6050" : "none";

  snprintf(buf, n,
           "{\"mode\":\"%s\",\"state\":\"%s\",\"cls\":\"%s\",\"imu\":\"PWM %u | %.1f m/s2\",\"txms\":%lu,"
           "\"pwr\":%s,\"pkts\":%lu,\"mpkts\":%lu,\"drv\":\"%c\",\"imutype\":\"%s\",\"txmode\":\"%s\"}",
           currentMode == MODE_ARMED ? "ARMED" : "DISARMED", st, cls,
           currentThrottlePWM, motionMagnitude, dynamicTxInterval,
           mainPowerIntact ? "true" : "false", packetCounter, motorPkts, currentDriveDir, it,
           txMode == TX_CONTINUOUS ? "cont" : "adaptive");
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_TEXT) {
    char tmp[48];
    size_t n = length < sizeof(tmp) - 1 ? length : sizeof(tmp) - 1;
    memcpy(tmp, payload, n);
    tmp[n] = 0;
    handleCmd(String(tmp));
  } else if (type == WStype_CONNECTED) {
    Serial.printf("[WS] client %u connected\n", num);
  } else if (type == WStype_DISCONNECTED) {
    Serial.printf("[WS] client %u disconnected\n", num);
    if (currentDriveDir != 'S') setDrive('S', currentThrottlePWM);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
#if USE_PWR_SENSE
  pinMode(MAIN_PWR_PIN, INPUT);
#endif
  initIMU();

  WiFi.mode(WIFI_AP_STA);
  IPAddress local_IP(192, 168, 4, 1), gateway(192, 168, 4, 1), subnet(255, 255, 255, 0);
  WiFi.softAPConfig(local_IP, gateway, subnet);
  WiFi.softAP(ssid, password, ESPNOW_CHANNEL, 0, 4);
  WiFi.setSleep(false);

  Serial.print("AP Started! Connect to StealthNode_Command and open http://");
  Serial.println(WiFi.softAPIP());
  Serial.printf("ESP-NOW ch %d | packet %u bytes | sender STA MAC %s\n",
                ESPNOW_CHANNEL, (unsigned)sizeof(struct_packet), WiFi.macAddress().c_str());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
  } else {
    memset(&peerInfo, 0, sizeof(peerInfo));
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = ESPNOW_CHANNEL;
    peerInfo.ifidx = WIFI_IF_STA;
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) Serial.println("ESP-NOW add peer FAILED");
  }

  server.on("/", []() { server.send_P(200, "text/html", index_html); });
  server.on("/cmd", []() { handleCmd(server.arg("c")); server.send(200, "text/plain", "OK"); });
  server.on("/status", []() {
    char buf[360];
    buildStatus(buf, sizeof(buf));
    server.send(200, "application/json", buf);
  });
  server.begin();

  ws.begin();
  ws.onEvent(onWsEvent);
}

void loop() {
  server.handleClient();
  ws.loop();

  unsigned long now = millis();
  updatePower();
  updateMotion();
  serviceMotor();

#if USE_IMU_MOTION
  if (motionMagnitude > IMU_THRESHOLD) lastMotionTime = now;
#endif
  if (currentDriveDir != 'S' && currentThrottlePWM >= SPEED_THRESHOLD) lastMotionTime = now;

  TrackerState prev = currentState;
  if (!mainPowerIntact && currentMode == MODE_ARMED) {
    currentState = STATE_TAMPER_ALERT;
    dynamicTxInterval = 120;
  } else if (currentMode == MODE_DISARMED) {
    currentState = STATE_IDLE;
    dynamicTxInterval = 0;
  } else if (lastMotionTime != 0 && now - lastMotionTime < PURSUIT_HOLD_MS) {
    currentState = STATE_PURSUIT;
    int imuSpeed = constrain((int)(motionMagnitude * 30), 120, 255);
    int effectiveSpeed = max((int)currentThrottlePWM, imuSpeed);
    dynamicTxInterval = map(constrain(effectiveSpeed, 120, 255), 120, 255, 800, 120);
  } else {
    currentState = STATE_STEALTH;
    dynamicTxInterval = STEALTH_TX_MS;
  }

  if (txMode == TX_CONTINUOUS && currentState != STATE_TAMPER_ALERT) {
    dynamicTxInterval = contIntervalMs;
  }

  if (currentState != prev) {
    Serial.printf("[STATE] %s -> %s\n", STATE_TXT[prev], STATE_TXT[currentState]);
    lastTransmitTime = 0;
  }

  if (dynamicTxInterval > 0 && (lastTransmitTime == 0 || now - lastTransmitTime >= dynamicTxInterval)) {
    lastTransmitTime = now;
    sendRFTelemetryBurst();
  }

  static unsigned long lastPush = 0;
  if (now - lastPush >= 200 && ws.connectedClients() > 0) {
    lastPush = now;
    char buf[360];
    buildStatus(buf, sizeof(buf));
    ws.broadcastTXT(buf);
  }
}
