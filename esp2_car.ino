/*
 * ESP2 - CAR (motor receiver)
 * Receives type-1 motor commands from ESP1 over ESP-NOW and drives an L298N / L293D.
 * Ignores type-2 telemetry bursts. Stops automatically if commands stop arriving.
 *
 * Wiring: IN1=32, IN2=33 (left motor), IN3=25, IN4=26 (right motor), ENA/ENB jumpers ON.
 * Power the ESP32 separately from the motors (USB / power bank), grounds connected together.
 * Serial test (115200): w/a/s/d = drive, x = stop, r = back to radio control
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_arduino_version.h>

// ---------------- Pins (L298N / L293D, ENA/ENB jumpers ON) ----------------
#define IN1 32   // Motor A (left)
#define IN2 33
#define IN3 25   // Motor B (right)
#define IN4 26

// ---------------- Config ----------------
#define ESPNOW_CHANNEL   1      // must match the command node
#define FAILSAFE_MS      400    // no motor packet for this long -> stop
#define MIN_DUTY         140    // below this most TT/gear motors just hum; raise if they still stall
#define INVERT_LEFT      0      // set 1 if the left motor spins backwards on 'F'
#define INVERT_RIGHT     0      // set 1 if the right motor spins backwards on 'F'
#define BOOT_TEST        0      // 1 = spin each motor briefly at boot (LIFT THE WHEELS)

typedef struct struct_packet {
  uint8_t packetType; // 1 = Motor Command, 2 = RF Telemetry Burst
  char driveCmd;      // 'F', 'B', 'L', 'R', 'S'
  uint8_t speedPWM;   // 0 - 255
  uint32_t pktId;
  float lat;
  float lon;
  bool tamperAlert;
} struct_packet;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile char rxCmd = 'S';
volatile uint8_t rxPwm = 0;
volatile unsigned long rxTime = 0;
volatile uint32_t rxMotorPkts = 0, rxOtherPkts = 0, rxBadLen = 0;
volatile int rxLastBadLen = 0;

bool serialOverride = false;
char activeCmd = 'S';
uint8_t activePwm = 0;

// ---------- motor control ----------
uint8_t toDuty(uint8_t pwm) {
  if (pwm == 0) return 0;
  return max<uint8_t>(pwm, MIN_DUTY);
}

// speed: -255..255 (negative = reverse)
void driveMotor(int pinA, int pinB, int speed, bool invert) {
  if (invert) speed = -speed;
  if (speed > 0)      { analogWrite(pinA, speed);  analogWrite(pinB, 0); }
  else if (speed < 0) { analogWrite(pinA, 0);      analogWrite(pinB, -speed); }
  else                { analogWrite(pinA, 0);      analogWrite(pinB, 0); }
}

void setMotors(int left, int right) {
  driveMotor(IN1, IN2, left,  INVERT_LEFT);
  driveMotor(IN3, IN4, right, INVERT_RIGHT);
}

void applyCommand(char c, uint8_t pwm) {
  int d = toDuty(pwm);
  switch (c) {
    case 'F': setMotors( d,  d); break;
    case 'B': setMotors(-d, -d); break;
    case 'L': setMotors(-d,  d); break;   // spin left
    case 'R': setMotors( d, -d); break;   // spin right
    default:  setMotors( 0,  0); break;
  }
  if (c != activeCmd || pwm != activePwm) {
    Serial.printf("[DRIVE] %c  pwm=%u -> duty=%d\n", c, pwm, (c == 'S') ? 0 : d);
  }
  activeCmd = c;
  activePwm = pwm;
}

// ---------- ESP-NOW receive ----------
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
void OnDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
#else
void OnDataRecv(const uint8_t *mac, const uint8_t *data, int len) {
#endif
  if (len != (int)sizeof(struct_packet)) { rxBadLen++; rxLastBadLen = len; return; }
  struct_packet p;
  memcpy(&p, data, sizeof(p));
  if (p.packetType != 1) { rxOtherPkts++; return; }   // ignore telemetry bursts

  portENTER_CRITICAL(&mux);
  rxCmd = p.driveCmd;
  rxPwm = p.speedPWM;
  rxTime = millis();
  rxMotorPkts++;
  portEXIT_CRITICAL(&mux);
}

// ---------- Serial test driving ----------
void handleSerial() {
  while (Serial.available()) {
    char k = Serial.read();
    char c = 0;
    if (k == 'w') c = 'F';
    else if (k == 's') c = 'B';
    else if (k == 'a') c = 'L';
    else if (k == 'd') c = 'R';
    else if (k == 'x') c = 'S';
    else if (k == 'r') { serialOverride = false; Serial.println("[SERIAL] back to radio control"); }
    if (c) {
      serialOverride = true;
      applyCommand(c, 200);
    }
  }
}

void bootTest() {
  Serial.println("[TEST] left fwd");   setMotors(200, 0);  delay(400);
  Serial.println("[TEST] left rev");   setMotors(-200, 0); delay(400);
  Serial.println("[TEST] right fwd");  setMotors(0, 200);  delay(400);
  Serial.println("[TEST] right rev");  setMotors(0, -200); delay(400);
  setMotors(0, 0);
  Serial.println("[TEST] done");
}

void setup() {
  Serial.begin(115200);
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  setMotors(0, 0);
  delay(300);

#if BOOT_TEST
  bootTest();
#endif

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(OnDataRecv);

  Serial.printf("[CAR ONLINE] ch %d | MAC %s | expecting %u-byte packets\n",
                ESPNOW_CHANNEL, WiFi.macAddress().c_str(), (unsigned)sizeof(struct_packet));
  Serial.println("Serial test: w/a/s/d = drive, x = stop, r = radio control");
}

void loop() {
  handleSerial();

  if (!serialOverride) {
    char c; uint8_t pwm; unsigned long t;
    portENTER_CRITICAL(&mux);
    c = rxCmd; pwm = rxPwm; t = rxTime;
    portEXIT_CRITICAL(&mux);

    if (t == 0 || millis() - t > FAILSAFE_MS) {
      if (activeCmd != 'S') Serial.println("[FAILSAFE] no command -> stop");
      applyCommand('S', 0);
    } else {
      applyCommand(c, pwm);
    }
  }

  static unsigned long lastDiag = 0;
  if (millis() - lastDiag > 2000) {
    lastDiag = millis();
    Serial.printf("[RX] motor pkts %lu | telemetry ignored %lu | wrong size %lu (last %d)\n",
                  (unsigned long)rxMotorPkts, (unsigned long)rxOtherPkts,
                  (unsigned long)rxBadLen, rxLastBadLen);
  }
  delay(5);
}
