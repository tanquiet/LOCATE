# Locate demo cheat sheet

One page to run the demo. Full details are in `README.md`.

## Accounts

| Use | Username | Password |
|---|---|---|
| Control admin (all screens) | `admin` | `admin123` |
| Customer (owner view) | `customer` | `customer123` |

More dummy customers: `priya` / `priya123`, `arjun` / `arjun123`, `meera` / `meera123`.

## Setup A: laptop + one phone

1. Double-click **`start-demo.bat`**. Two server windows open; keep them open.
2. Laptop: `http://localhost:8000` opens. Sign in as **admin**.
3. Phone (same Wi-Fi as the laptop): open the `https://<laptop-ip>:8443/tracker.html` link printed in
   the tracker server window. Tap **Advanced → Proceed**, sign in, **Allow** location.

## Setup B: two phones, no laptop

1. Once, from a laptop: drag **`locate-app.zip`** onto <https://app.netlify.com/drop>. Note the link.
2. Phone 1 (the "car"): `https://<your-link>/tracker.html`, sign in, **Allow** location.
3. Phone 2 (the owner): `https://<your-link>`, sign in as **admin**.

Both phones need mobile data or Wi-Fi. They do not need to be on the same network.

## Two minutes before the judges

On the viewing screen (laptop or Phone 2):

- [ ] Top bar says **Connected** (green). On the tracker phone too.
- [ ] **Settings → Reset for a fresh demo → Yes, reset**.
- [ ] Tap or click the page once (this lets the alarm sound play).
- [ ] **Live map → 🔔 Turn on pop-up alerts** (once per device).
- [ ] Volume up. On a phone it is the **media** volume.
- [ ] Both screens stay on: tracker phone open on the tracker page; **Settings → Keep screen on** on the viewer.
- [ ] Tracker phone: **Movement = Auto** for walking outdoors. Indoors, use **Moving** / **Stopped** instead.

## The demo (about 2 minutes)

The phone tracker has two modes. Pick them on the viewer's **Live map** (the big **A** / **B** buttons),
on **Controls → Tracker mode**, or on the tracker phone itself.

- **Mode A · Always-on:** transmits every 1.5 s, moving or not.
- **Mode B · Locate (armed):** transmits nothing while parked. The moment it moves, the viewer phone
  gets an alarm and the vehicle is followed live. When it stops for 5 s: one "stopped here" alert,
  then silent and armed again.

| # | Do | Judges see | Say |
|---|---|---|---|
| 1 | Viewer: **A** | Counter climbs every 1.5 s, RF lamp flashes, dot on the map | "A normal tracker transmits all the time. A thief's cheap RF detector finds it in seconds." |
| 2 | Viewer: **B**. Put the tracker phone on the table. | **Arming…**, then **Armed · silent** in about 3 s. Counter frozen, lamp dark. | "Parked, Locate transmits nothing. A detector sweep finds nothing." |
| 3 | Pick up the tracker phone and walk. | **STOLEN** banner, repeating alarm and vibration on the viewer, pop-up, live red route | "The moment the thief moves it, the owner's phone goes off." |
| 4 | Stop and stand still 5 s. | "It stopped here" pin in Alerts. The tracker is silent and armed again. | "It reports where it stopped, then goes quiet again." |
| 5 | Viewer: **🚓 Report to police**, then **A** | Ready report; **A** ends the alarm | "One tap gives the police everything they need." |

Indoors: on the tracker phone tap **Moving** for step 3 and **Stopped** for step 4, then **Auto** again.

## Click-through demo (no typing at all)

| Phone | Tap |
|---|---|
| Owner phone | Quick sign-in → **Priya Sharma**. Her **Priya's Activa** opens on the map. |
| Tracker phone | `.../tracker.html` → Quick pair → **Priya's Activa**. |
| Control admin phone (optional) | Quick sign-in → **Control Admin** → **Vehicles**: every owner's vehicles. |

Then use **A** / **B** on Priya's phone as in the walk-away demo. Ready-made demo vehicles:

| Account | Vehicles (quick-pair code) |
|---|---|
| Demo Customer | Family Car (`FAMILY`) |
| Priya Sharma | Priya's Activa (`PRIYA1`) |
| Arjun Rao | Arjun's Bullet (`ARJUN1`), Arjun's Swift (`ARJUN2`) |
| Meera Nair | Meera's Cycle (`MEERA1`) |
| Everyone | Demo car (`CAR1`) |

## Real-user flow: your own account and vehicle (about 1 minute)

1. **Owner phone:** open the app → **New here? Create a free account** → name, username, password.
   It opens on **Vehicles**.
2. **Add a vehicle:** name (e.g. "My Activa"), type (car / motorbike / scooter / bicycle / truck / other),
   registration → **Add vehicle**. A **pairing card** appears with a QR code and a 6-letter code.
3. **Tracker phone:** scan the QR code with the camera (or open `.../tracker.html` and type the code).
   It shows "This phone is the tracker in **My Activa**". No account is needed on the tracker.
4. **Control admin phone:** **Vehicles** lists every vehicle with its owner and live status. Alerts from
   any vehicle reach the control room, even when it is watching another one.
5. Another customer signing in does **not** see your vehicle or its alerts.

Each vehicle has its own channel (`<prefix>/v-<code>/...`). The tap-to-switch vehicle chip is at the top
of the Live map card. For an ESP32, the pairing card shows the `TOPIC_BASE` to put in the sketch.

## Two-phone "walk away" demo (safe zone)

- **Phone 1 - Control admin (stays put):** `https://<laptop-ip>:8443`, tap **Control Admin**, allow
  location. A blue **You** marker appears; in Mode B a dashed circle (the safe zone) is drawn around you.
- **Phone 2 - Customer (walks away = the "thief"):** `https://<laptop-ip>:8443/tracker.html`, tap
  **Demo Customer**, allow location, keep the screen on, **Movement = Auto**.

| # | Do | Admin phone shows |
|---|---|---|
| 1 | Admin: tap **B**, pick the zone size (**20 / 50 / 100 m**). Customer phone held still next to the admin. | **Arming…**, then **Armed · silent**. Nothing is transmitted. |
| 2 | Customer starts walking away. | **Moving - inside your zone**, a short beep, "Tracker is 21 m away…" |
| 3 | Customer keeps walking past the zone. | **THEFT ALERT - it has left your safe zone!** Repeating alarm and vibration, pop-up, live red route, "75 m from you". |
| 4 | Customer stops for 5 s. | "It stopped here" pin. The tracker goes silent again. |
| 5 | Admin: **🚓 Report to police**, then **A** (or **Mark resolved**) | Alarm stops |

Do it outdoors: both phones need a GPS fix (±10-20 m). Use **50 m** or more, because GPS can drift 10-20 m.
If the admin's location is blocked, the zone is centred on the spot where the tracker was parked.

The dashed route needs real movement outdoors (about 10 m or more of walking with a GPS fix). Indoors,
or with the **Moving / Stopped** buttons, the alert arrives without a route; show the route with the
`?demo=1` simulated car instead (sign in as admin, **Compare → Locate**, wait about 25 s).

## Setup C: the ESP32 LOCATE node (`firmware/locate_node`)

1. In the sketch set `WIFI_SSID` / `WIFI_PASS`, upload, open the Serial Monitor at 115200.
2. Laptop: open the app, sign in as **admin**, top bar says **Connected**.
3. Shake the board for 2 s (or type `m`). The app shows **Moving** and draws the live route.

| # | Do | Judges see | Say |
|---|---|---|---|
| 1 | Leave the board still for 8 s | **Radio off**, badge RADIO OFF: PARKED | "Parked, it transmits nothing. A detector sweep of the parked car finds nothing." |
| 2 | Press **🔒 Arm**, then shake the board | **STOLEN**, alarm, live red route, distance from the parked spot | "The moment it moves, the radio wakes and it is tracked live." |
| 3 | Type `j`, wait 15-20 s, type `u` | Nothing during the blackout, then the logged route draws itself as a dashed line with "Blackout over: N logged points recovered" (when not armed: a full **JAMMER BLACKOUT - route recovered** banner) | "The thief switches on a jammer. The tracker logs the route to flash and uploads it when the link returns." |
| 4 | Type `p` | **TAMPER - the tracker's main power was cut** | "Cut its power and it tells you, from its backup battery." |
| 5 | **🚓 Report to police**, then **🔓 Disarm** | Ready report; alarm stops | |

Indoors the route is the firmware's simulated one; the app labels it "simulated position (no GPS fix)".

## What to say if asked

- **"Anyone can make this." / "You lose tracking while it is silent."** Going quiet is easy. Locate
  goes quiet and still hands over the whole route: the GPS only receives, so recording it is
  invisible, and it all arrives in the one message. Point at the dashed line and at **Compare →
  Silent, but nothing is lost** (1 transmission vs the pings an always-on tracker would have sent).

- **"The phone's radio is still on."** Correct. The phone stands in for the tracker to show the logic.
  The real tracker is the ESP32: it cuts power to its modem with a MOSFET while moving.
- **"Guard transmits while moving?"** Yes. Guard is for when the owner is close and wants an instant
  alarm. Locate is the mode that beats the RF detector. The owner chooses with Arm / Disarm.
- **"Is the login secure?" / "Does it call the police?"** It is a demo: the sign-in runs in the browser,
  and the police report is prepared for the owner to send. A product would use a server for both.

## If something goes wrong

| Problem | Fix |
|---|---|
| "Reconnecting" on either device | Check internet. Both sides go through the online broker. |
| No alarm sound | Tap the page once. Turn the media volume up. |
| No STOLEN after walking | Was it **GUARD: ARMED** first? Hold still 3 s to arm. Try **High** sensitivity, or tap **Moving**. |
| No Locate alert after stopping | It must move first, then stop for 5 s. Tap **Moving**, then **Stopped**. |
| Alerts appear that are not yours | Someone else is on the same channel: change **Topic prefix** on both devices. |
| Phone cannot open the laptop link | Same Wi-Fi? Allow Python through Windows Firewall. Or use Setup B. |
| Everything fails | Open the app with `?demo=1` at the end of the link: a simulated car runs the Locate story. |

Not yet verified: the ESP32 firmware has not been compiled or run on hardware, and the phone features
were tested in a desktop browser emulating a phone, not on a real handset. Rehearse once on the real devices.
