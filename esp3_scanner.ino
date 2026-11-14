/*
 * ESP3 - "THIEF" RF SCANNER
 * Listens for type-2 telemetry bursts from ESP1. Beeps faster as the signal gets stronger,
 * solid tone when on top of the tracker. Sweeps channels 1-13 while nothing is heard.
 *
 * Buzzer (active): + -> GPIO25, - -> GND. Onboard LED (GPIO2) flashes once per packet.
 * Calibrate in Serial Monitor (115200): 'c' = scanner on top of transmitter,
 *                                       'f' = scanner far away, 'p' = print levels
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_arduino_version.h>

#define BUZZER_PIN        25
#define LED_PIN           2
#define START_CHANNEL     1
#define SWEEP_CHANNELS    1      // 1 = hop channels 1..13 until the tracker is found
#define HOP_IF_SILENT_MS  3000
#define LOST_TIMEOUT_MS   2500   // upper limit; actual timeout adapts to the burst rate

#define BEEP_SLOW_MS      1000   // gap between beeps when far
#define BEEP_FAST_MS      60     // gap between beeps just below solid
#define BEEP_ON_MS        35
#define LED_PULSE_MS      40
#define RSSI_ALPHA        0.35f

// Defaults - recalibrate live: 'c' = on top of transmitter, 'f' = far away
int rssiFar   = -80;   // at/below: slowest beeps
int rssiSolid = -50;   // at/above: continuous tone

// MUST be byte-identical to the struct in the sender
typedef struct struct_packet {
  uint8_t  packetType;
  char     driveCmd;
  uint8_t  speedPWM;
  uint32_t pktId;
  float    lat;
  float    lon;
  bool     tamperAlert;
} struct_packet;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

volatile int8_t   espnowRssi = -100;
volatile bool     newPkt = false;
volatile uint32_t goodPkts = 0, otherType = 0, badLen = 0;
volatile int      lastBadLen = 0;
volatile uint8_t  lastOtherType = 0;
volatile unsigned long lastAnyRx = 0, lastBurst = 0, burstGap = 0;

struct_packet rxPkt;
int8_t  rxRssi = -100;
uint8_t rxMac[6];

int channel = START_CHANNEL;
float smoothedRSSI = -100.0f;
bool haveSignal = false;
unsigned long ledOffTime = 0;

#if ESP_ARDUINO_VERSION < ESP_ARDUINO_VERSION_VAL(3, 0, 0)
// Core 2.x: RSSI is not in the ESP-NOW callback, so sniff it from ESP-NOW frames only
void promiscuous_rx_cb(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  const wifi_promiscuous_pkt_t *p = (const wifi_promiscuous_pkt_t *)buf;
  if (p->rx_ctrl.sig_len < 28) return;
  const uint8_t *d = p->payload;
  if (d[24] == 0x7F && d[25] == 0x18 && d[26] == 0xFE && d[27] == 0x34)
    espnowRssi = p->rx_ctrl.rssi;
}
#endif

#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
void OnDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  int8_t rssi = info->rx_ctrl->rssi;
  const uint8_t *mac = info->src_addr;
#else
void OnDataRecv(const uint8_t *mac, const uint8_t *data, int len) {
  int8_t rssi = espnowRssi;
#endif
  unsigned long now = millis();
  lastAnyRx = now;

  if (len != (int)sizeof(struct_packet)) { badLen++; lastBadLen = len; return; }

  struct_packet tmp;
  memcpy(&tmp, data, sizeof(tmp));
  if (tmp.packetType != 2) { otherType++; lastOtherType = tmp.packetType; return; }

  portENTER_CRITICAL(&mux);
  rxPkt = tmp;
  rxRssi = rssi;
  memcpy(rxMac, mac, 6);
  burstGap = now - lastBurst;
  lastBurst = now;
  goodPkts++;
  newPkt = true;
  portEXIT_CRITICAL(&mux);
}

void setChannel(int ch) {
  channel = ch;
  esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
}

void handleSerial() {
  while (Serial.available()) {
    char k = Serial.read();
    if (k == 'c') {
      if (!haveSignal) { Serial.println("[CAL] no signal yet - wait for [RF DETECTED] lines"); continue; }
      rssiSolid = (int)smoothedRSSI - 3;
      if (rssiFar >= rssiSolid - 10) rssiFar = rssiSolid - 30;
      Serial.printf("[CAL] SOLID tone at >= %d dBm (far = %d dBm)\n", rssiSolid, rssiFar);
    } else if (k == 'f') {
      if (!haveSignal) { Serial.println("[CAL] no signal - move a bit closer and retry"); continue; }
      rssiFar = (int)smoothedRSSI;
      if (rssiSolid <= rssiFar + 10) rssiSolid = rssiFar + 30;
      Serial.printf("[CAL] FAR = %d dBm (solid = %d dBm)\n", rssiFar, rssiSolid);
    } else if (k == 'p') {
      Serial.printf("[CAL] far = %d dBm, solid = %d dBm, now = %.0f dBm\n", rssiFar, rssiSolid, smoothedRSSI);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);    digitalWrite(LED_PIN, LOW);
  delay(300);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  setChannel(START_CHANNEL);

#if ESP_ARDUINO_VERSION < ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&promiscuous_rx_cb);
  setChannel(START_CHANNEL);
#endif

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(OnDataRecv);

  Serial.printf("[THIEF RF SCANNER ONLINE] my MAC %s, channel %d, expecting %u-byte packets\n",
                WiFi.macAddress().c_str(), channel, (unsigned)sizeof(struct_packet));
  Serial.println("Calibrate: 'c' = scanner on top of transmitter, 'f' = scanner far away, 'p' = print");

  digitalWrite(BUZZER_PIN, HIGH); delay(100); digitalWrite(BUZZER_PIN, LOW);
}

void loop() {
  unsigned long now = millis();
  handleSerial();

  // ---- new tracker packet ----
  if (newPkt) {
    struct_packet p; int8_t rssi; uint8_t mac[6]; unsigned long gap;
    portENTER_CRITICAL(&mux);
    p = rxPkt; rssi = rxRssi; memcpy(mac, rxMac, 6); gap = burstGap;
    newPkt = false;
    portEXIT_CRITICAL(&mux);

    if (!haveSignal) smoothedRSSI = rssi;
    else smoothedRSSI = RSSI_ALPHA * rssi + (1.0f - RSSI_ALPHA) * smoothedRSSI;
    haveSignal = true;

    digitalWrite(LED_PIN, HIGH);
    ledOffTime = now + LED_PULSE_MS;

    int clamped = constrain((int)smoothedRSSI, rssiFar, rssiSolid);
    int bars = map(clamped, rssiFar, rssiSolid, 1, 15);

    Serial.print("[RF DETECTED] ch");
    Serial.print(channel);
    Serial.print(" RSSI:[");
    for (int i = 0; i < 15; i++) Serial.print(i < bars ? "#" : ".");
    Serial.printf("] %d dBm (raw %d)%s | Tx Gap: %lu ms | PWM: %u | Pkt #%lu%s\n",
                  (int)smoothedRSSI, rssi, smoothedRSSI >= rssiSolid ? " SOLID" : "",
                  gap, p.speedPWM, (unsigned long)p.pktId,
                  p.tamperAlert ? " | TAMPER!" : "");
  }

  if ((long)(now - ledOffTime) >= 0) digitalWrite(LED_PIN, LOW);

  // ---- signal lost? (timeout adapts to the tracker's burst rate) ----
  unsigned long lostAfter = constrain(burstGap * 2 + 150, 300UL, (unsigned long)LOST_TIMEOUT_MS);
  if (haveSignal && now - lastBurst > lostAfter) {
    haveSignal = false;
    Serial.println("[SIGNAL LOST] tracker silent (stealth / out of range)");
  }

  // ---- buzzer: faster with strength, solid tone when on top ----
  static unsigned long nextBeep = 0, beepOffAt = 0;
  static bool buzzerOn = false;

  if (!haveSignal) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOn = false;
  } else if (smoothedRSSI >= rssiSolid) {
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerOn = true;
    beepOffAt = now + BEEP_ON_MS;
    nextBeep = now;
  } else {
    float r = constrain(smoothedRSSI, (float)rssiFar, (float)rssiSolid);
    float t = (r - rssiFar) / (float)(rssiSolid - rssiFar);
    t = t * t;
    unsigned long gapMs = BEEP_SLOW_MS - (unsigned long)(t * (BEEP_SLOW_MS - BEEP_FAST_MS));

    if (!buzzerOn && (long)(now - nextBeep) >= 0) {
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerOn = true;
      beepOffAt = now + BEEP_ON_MS;
      nextBeep = now + gapMs;
    }
    if (buzzerOn && (long)(now - beepOffAt) >= 0) {
      digitalWrite(BUZZER_PIN, LOW);
      buzzerOn = false;
    }
  }

  // ---- channel sweep while nothing is heard ----
#if SWEEP_CHANNELS
  static unsigned long lastHop = 0;
  if (now - lastAnyRx > HOP_IF_SILENT_MS && now - lastHop > HOP_IF_SILENT_MS) {
    lastHop = now;
    setChannel(channel % 13 + 1);
    Serial.printf("[SWEEP] listening on channel %d\n", channel);
  }
#endif

  // ---- diagnostics ----
  static unsigned long lastDiag = 0;
  static uint32_t seenBad = 0, seenOther = 0;
  if (now - lastDiag > 2000) {
    lastDiag = now;
    if (badLen != seenBad) {
      Serial.printf("[DIAG] %lu packets with wrong size (last %d bytes, expected %u)\n",
                    (unsigned long)badLen, lastBadLen, (unsigned)sizeof(struct_packet));
      seenBad = badLen;
    }
    if (otherType != seenOther) {
      Serial.printf("[DIAG] %lu packets ignored with packetType=%u\n",
                    (unsigned long)otherType, lastOtherType);
      seenOther = otherType;
    }
  }
}
