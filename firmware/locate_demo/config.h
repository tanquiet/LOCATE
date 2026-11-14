// =============================================================================
//  Locate demo - configuration
//  Edit this file, then upload locate_demo.ino. Nothing else needs changing.
// =============================================================================
#pragma once

// Link identifiers (do not change)
#define LINK_WIFI 0
#define LINK_GSM  1

// ----------------------------------------------------------------------------
// WiFi (phone hotspot or venue router; must be 2.4 GHz)
// ----------------------------------------------------------------------------
#define WIFI_SSID      "YourHotspotName"
#define WIFI_PASSWORD  "YourHotspotPassword"

// ----------------------------------------------------------------------------
// MQTT broker
//
// ONE-BROKER RULE: the web app watches exactly one broker, so the WiFi and the
// GSM settings below must end up at the SAME broker.
//   * WiFi can reach the laptop directly (its LAN IP, port 1883).
//   * GSM comes in from the internet, so it needs either an ngrok TCP tunnel to
//     the laptop (host/port printed by ngrok) or a public test broker.
//   * If you use a public test broker, put it in BOTH blocks, leave user/pass
//     empty and change TOPIC_PREFIX to something unique.
// See README "Broker setup".
// ----------------------------------------------------------------------------
// Default: free HiveMQ public broker - no Mosquitto needed, works over WiFi and GSM.
// To use your own Mosquitto instead: WiFi host = laptop IP, user/pass = locate/locate123,
// GSM host/port = your ngrok TCP address (see README).
#define MQTT_WIFI_HOST "broker.hivemq.com"
#define MQTT_WIFI_PORT 1883
#define MQTT_WIFI_USER ""                 // "" = connect without credentials
#define MQTT_WIFI_PASS ""

#define MQTT_GSM_HOST  "broker.hivemq.com"
#define MQTT_GSM_PORT  1883
#define MQTT_GSM_USER  ""
#define MQTT_GSM_PASS  ""

// MUST be unique on a public broker (anyone using the same prefix sees your car).
// The web app's Settings -> Topic prefix must match.
#define TOPIC_PREFIX   "locate-k7q2m9"    // topics are <prefix>/<vehicle id>/ping|alert|config|status
#define VEHICLE_ID     "car1"

// ----------------------------------------------------------------------------
// Mobile network (SIM800L is 2G only: Airtel or Vi. Jio has no 2G.)
// ----------------------------------------------------------------------------
#define GPRS_APN   "airtelgprs.com"       // Vi: "www"
#define GPRS_USER  ""
#define GPRS_PASS  ""
#define MODEM_BAUD 9600                   // SIM800L auto-bauds; 9600 is the most forgiving

// ----------------------------------------------------------------------------
// Behaviour
// ----------------------------------------------------------------------------
#define DEFAULT_MODE         'A'          // mode after power-up: 'A' or 'B'

#define SPEED_THRESHOLD_KMH  5            // at or above this = "moving"
#define DWELL_MS             5000         // must stay below the threshold this long = "stopped"

#define MODE_A_PERIOD_MS     1500         // Mode A ping period
#define MODE_A_LINK          LINK_WIFI    // LINK_WIFI for first tests (no SIM800L yet); LINK_GSM once the modem is wired (falls back to WiFi)
#define MODE_B_LINK          LINK_WIFI    // LINK_WIFI = fast stage demo, LINK_GSM = the real thing (10-30 s)

#define ALERT_JITTER_MAX_MS  3000         // random 0..this wait before the Mode B alert
#define LISTEN_WINDOW_MS     1000         // Mode B: keep the link up this long after the alert for config
#define ALERT_MAX_ATTEMPTS   3            // Mode B: tries per stop if the link fails
#define ALERT_RETRY_MS       5000         // gap between those tries

// Silent route ("breadcrumb trail"): while Mode B is silent the GPS positions are
// stored in RAM and sent inside the ONE stop alert, so the owner still sees the
// route. Reading GPS transmits nothing. When the buffer fills, every second point
// is dropped and recording slows down, so any trip length fits.
#define TRAIL_ENABLED        true
#define TRAIL_MAX_POINTS     30           // keeps the alert under ~1 kB (one modem send)
#define TRAIL_PERIOD_MS      2000         // first recording interval
#define TRAIL_MIN_M          10           // ignore points closer than this to the last one

// ----------------------------------------------------------------------------
// Optional owner check (Bluetooth LE, passive scan only)
// The phone must ADVERTISE the name or the service UUID in its primary
// advertising packet (e.g. with the nRF Connect app). A passive scan cannot
// see names that are only in the scan response.
// Requires the NimBLE-Arduino library only when enabled.
// ----------------------------------------------------------------------------
#define OWNER_CHECK_ENABLED  false
#define OWNER_BLE_NAME       "LocateOwner"                            // "" = do not match by name
#define OWNER_BLE_UUID       "7a0c0001-5f2e-4b1d-9c3a-10ca7e000001"   // "" = do not match by UUID
#define OWNER_SCAN_MS        5000

// ----------------------------------------------------------------------------
// GPS
// ----------------------------------------------------------------------------
#define GPS_BAUD       9600
#define GPS_STALE_MS   3000               // older than this = no live fix (speed treated as 0)
#define FALLBACK_LAT   12.9716            // Bengaluru, used until the first fix
#define FALLBACK_LON   77.5946

// ----------------------------------------------------------------------------
// Timeouts / robustness
// ----------------------------------------------------------------------------
#define WIFI_CONNECT_TIMEOUT_MS  8000
#define MODEM_BOOT_MS            3000     // wait after switching modem power on
#define GSM_REG_TIMEOUT_MS       45000    // wait for network registration
#define GSM_HEALTH_MS            10000    // Mode A: log CSQ / registration and check for modem resets
#define GSM_MAX_FAILS            3        // Mode A: consecutive GSM failures before WiFi fallback
#define GSM_RETRY_MS             120000   // Mode A on WiFi fallback: retry GSM this often (0 = never)
#define TX_LED_MS                80
#define DEBOUNCE_MS              40
#define LONG_PRESS_MS            800      // BOOT held this long = toggle simulated speed (40 <-> 0 km/h)

// ----------------------------------------------------------------------------
// Pins
// ----------------------------------------------------------------------------
#define PIN_GPS_RX      16   // ESP32 RX2  <- GPS TX
#define PIN_GPS_TX      17   // ESP32 TX2  -> GPS RX
#define PIN_MODEM_RX    26   // ESP32 RX1  <- SIM_TXD
#define PIN_MODEM_TX    27   // ESP32 TX1  -> SIM_RXD
#define PIN_MODEM_RST   25   // SIM800L RST (pulled low to reset, otherwise left floating)
#define PIN_MODEM_PWR   14   // modem power switch
#define MODEM_PWR_ON_LEVEL HIGH  // HIGH = modem powered (NPN + P-MOSFET). Use LOW for active-low relay modules.
#define PIN_BUTTON      0    // BOOT button
#define PIN_LED_TX      33   // TX LED via 220 ohm
#define PIN_LED_MODE    2    // on-board LED: ON = Mode B (Locate)
#define PIN_BUZZER      13   // active buzzer via BC547
