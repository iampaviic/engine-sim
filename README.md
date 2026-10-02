# Firing Order

A physically modelled engine sound simulator that runs in the browser, on desktop and mobile. None of the sound is sampled or synthesised from recordings: every cylinder, valve and exhaust pipe is simulated once per audio sample, and what you hear is the pressure wave that leaves the tail pipes.

## Play

Serve the folder over HTTP (the audio worklet needs it) and open it in a browser:

```sh
node tools/serve.mjs        # http://localhost:8080
```

Any static server works, and so does GitHub Pages: the workflow in `.github/workflows/pages.yml` deploys `main` once Pages is set to "GitHub Actions" in the repository settings. Press **START** (or Enter) and use headphones or decent speakers. Most of an engine's character sits below 150 Hz.

## How the sound is made

Sound is pressure changing over time, so the simulator computes pressures:

1. **Cylinders** (0-D thermodynamics). Each cylinder integrates mass and internal energy through compression, a Wiebe-function burn, expansion and gas exchange, with cycle-to-cycle combustion variation, misfire from residual gas, and blow-by.
2. **Valves**. Compressible (choked or subsonic) orifice flow through the cam-driven lift curves, including ramps, overlap and reverse flow. The flow is solved implicitly against the pipe impedance so the valve and the pipe push on each other.
3. **Pipes**. Headers, collectors, X/H-pipes, cats, mufflers and tails are digital waveguides: pressure waves travel both ways at the local speed of sound (it follows exhaust gas temperature), scatter at junctions, lose high frequencies to friction and reflect at open ends. Strong blowdown pulses steepen toward shocks (finite-amplitude propagation), which gives high-load rasp.
4. **Radiation**. Each tail pipe (and the intake) radiates the time derivative of its mass outflow, like a monopole. A listener model adds distance delay (so fly-bys Doppler-shift on their own), a ground reflection, air absorption, head shadow and the cabin.
5. **Knock and valve float**. The unburned end gas in every cylinder integrates its autoignition delay (Livengood-Wu with the Douaud-Eyzat correlation, so octane, compression, boost, intake temperature and spark timing all matter). When it autoignites, the rest of the charge burns at once and the chamber rings at its first acoustic modes (1.84·c/πB, about 5–7 kHz), which the block radiates as the ping. Past the spring limit the valves loft off the cams and bounce on their seats, letting gas back the wrong way: power collapses and the sound turns ragged.
6. **Starting**. The starter is a DC motor on the battery (permanent-magnet with planetary gears, series-wound direct drive, a motorcycle starter, or a race car's external starter), sized to the engine's compression and cold friction. It turns the flywheel through its pinion and a one-way clutch, and its armature inertia, current and speed come from the same crank dynamics: every compression stroke loads it and slows it, and past top centre the engine runs ahead until the next compression catches it up. What you hear follows from that: pinion teeth meeting the ring gear, the brushes and the planetary whine rising and falling with each stroke, the solenoid's clunk, the engine rocking on its mounts, then the catch and the armature running down after the pinion lets go. The ECU fires only once it has synced to the cam and crank, and on a cold start the first squirts of fuel wet the port walls.
7. **Two-strokes**. A two-stroke cylinder fires every turn and has no valves: the piston uncovers ports in the cylinder wall. The sealed crankcase under it draws the charge in through a reed valve (petals that lift with the pressure across them and only let charge in) and squeezes it up the transfer ports; fuel evaporating off the carburettor cools it. Scavenging uses two zones: the fresh charge pushes the burned gas out ahead of it, so what leaves is hotter and more burned than the cylinder average, and some fresh charge always short-circuits into the pipe. The expansion chamber is a stepped waveguide (header, diffuser cone, belly, baffle cone, stinger, packed silencer): the diffuser sends a suction wave back that pulls charge through, and the baffle sends the blowdown pulse back as a plugging pulse that stuffs the escaped charge back in before the port closes. That only lines up over a band of revs, and the band moves with the exhaust gas temperature: the engine comes "on the pipe". A servo-driven power valve lowers the exhaust port roof below its rpm range, and you start it with a kick lever.
8. **Nitrous**. Hold NOS (or N) at full throttle: liquid nitrous oxide sprays into the intake through a solenoid gated by a throttle switch and an rpm window. In the charge it carries 1.57 times the oxygen of air by mass, so the kit adds fuel to match; it releases heat as it splits into nitrogen and oxygen; flashing from liquid to gas it chills the charge, which packs more of it into the cylinders; and the oxygen-rich mixture burns faster, so the controller pulls timing. Push it too far and the knock model hears it. With the throttle shut the same button opens the purge valve and vents the line in a white plume. The bottle drains as you use it; the workshop sets the shot and refills it.
9. **Everything else is also simulated**: an ECU (idle control, fuel cut on overrun, rev limiter, spark map with knock control, launch control, traction control, two-stage cam switching, anti-lag), turbochargers (compressor map with surge, wastegate, blow-off valve or compressor flutter, screamer pipe, sequential stages with their own shafts and valves), twin-screw, Roots and centrifugal superchargers, afterfire in the exhaust, a drivetrain, tyres and a dyno.

Each engine's character comes out of its geometry: firing order, crank and bank angle, header lengths and how they merge. A cross-plane V8 burbles because each bank fires unevenly. A flat-plane V8 or a V12 screams because the pulses arrive evenly. An unequal-length boxer rumbles because the pulses arrive at the collector unevenly.

## Engines

| Engine | Layout |
| --- | --- |
| Berlinetta V12 | 6.5 L 65° V12, naturally aspirated |
| Toro V12 | 60° V12, tri-Y headers |
| Quad-Turbo W16 | 8.0 L W16, four sequential turbos: two below 3,800 rpm, all four above |
| Small-Block V8 | 6.2 L cross-plane pushrod V8 |
| Big-Block 427 | Cross-plane V8, race cam with 84° overlap |
| Blower V8 | Cross-plane V8 with a twin-screw supercharger |
| Flat-Plane V8 | High-revving flat-plane V8 |
| Angel V10 | 72° V10, equal-length 5-into-1 headers |
| GP V10 | 19,000 rpm, pneumatic valves |
| Boxer Six | Flat six with individual throttle bodies |
| Tuner Six | Straight six, big single turbo |
| Rally Four | Turbo four with anti-lag |
| Screamer Four | NA four with a high-rpm cam switch |
| Rumble Boxer | Turbo flat four, unequal-length headers |
| Twin Rotor | Two-rotor Wankel, bridge-ported |
| Big Twin | 45° V-twin, 1.9 L |
| Hot-Vee V8 | 4.0 L cross-plane V8, twin turbos inside the vee |
| Turbo Five | 2.5 L inline-5 turbo, fires 1-2-4-5-3 |
| Two-Stroke Single | 250 cc motocross two-stroke: reed valve, power valve, expansion chamber, kick start |

The **Workshop** changes hardware and rebuilds the model live: silencer, headers (n-into-1, tri-Y, 4-2-1, cast log, or 180° "bundle of snakes" for cross-plane V8s), X/H-pipe or true duals, cats, resonators, rear or side exits, header lengths, air intake (airbox, ram air, open filter), individual throttle bodies, cams, valve springs, flywheel, turbo or supercharger swaps (twin-screw, Roots, centrifugal), boost, blower pulley, blow-off valve, screamer pipe, anti-lag, nitrous shot and refills, rev limit, limiter type, overrun pops, (on the two-stroke) the rpm its expansion chamber is tuned for and the power valve, ignition timing, fuel octane, knock sensor, launch control, traction control and gearbox. It also holds the **mixer** (exhaust pipes, intake, mechanical, road; each can be soloed) and the **A/B compare** slot (factory spec, a stored setup or another engine; hold A/B or B to hear it).

## Engine builder

**Build** opens a workbench for designing a four-stroke or rotary engine from scratch: inline, vee, flat or rotary (1 to 16 cylinders, 2 to 4 rotors), bank angle, bore, stroke, rod length, compression, crankshaft, valvetrain, cams, a second cam profile, induction, intake runners, headers, exhaust, ECU and the car it sits in.

Firing orders are derived, not looked up: every cylinder's top dead centre comes from the crank-pin angles and the bank angle, and the builder enumerates every order that crank can produce and offers the most distinctive ones, from perfectly even to twin-pulse and big-bang. It finds the split-pin offset that makes an odd vee fire evenly. A 65° V12 comes out at 65/55°, a 90° V6 with shared pins at 90/150°, a 45° twin at 405/315°.

Every change is heard immediately (the build hot-swaps into the running engine), and a virtual dyno in a Web Worker runs the same physics faster than real time to draw the torque and power curves, report knock and valve float, and calibrate loudness. Builds are saved to **My garage** in the browser.

## Scenes

- **Fly-by**: roadside mic, full throttle past it, with Doppler.
- **Tunnel run**: cruise to a 320 m tunnel, drop a gear and floor it through; the reverb crossfades at the portals.
- **Quarter mile**: staged on the launch limiter, a sportsman Christmas tree, GO on green (reaction time counts), and a time slip with 60', 330', 1/8, 1000' and 1/4 mile times and trap speeds.
- **Mountain road**: two kilometres of canyon road with seven corners and a tunnel; the car brakes, blips down the gears and powers out.

## Controls

| | Keyboard | Touch / gamepad |
| --- | --- | --- |
| Start / stop | Enter | START button / A |
| Throttle | W or ↑ (A = part throttle), mouse wheel = hand throttle | right pedal / RT |
| Brake | S or ↓ | left pedal / LT |
| Blip | Space | BLIP / X |
| Shift | Q / E or ← / → | − / + / LB, RB |
| Launch control | hold L | LAUNCH / B |
| Nitrous (purges with the throttle shut) | hold N | NOS / R3 |
| Rev, Drive | 1, 2 | mode switch |
| Fly-by, tunnel, quarter mile, mountain | 3, 4, 5, 6 | Scenes |
| A/B compare | hold B | A/B chip, Workshop |
| Dyno run | D | DYNO tab |
| Mic / place | C / V | Y (mic) |
| Garage / workshop | G / T | top bar |

## iOS and Android apps

The same code ships as native apps through [Capacitor](https://capacitorjs.com) 8. The native projects live in `ios/` and `android/`; the app id is `com.iampaviic.firingorder`.

```sh
npm install
npm run sync        # copy the web app into www/ and both native projects
npm run android     # open Android Studio (or: cd android && ./gradlew assembleDebug)
npm run ios         # open Xcode (macOS only)
```

The app needs no network: fonts are bundled and everything is computed on the phone. A small native plugin, `EngineAudio` (Swift and Java, in each app target), sets up the audio session so the engine plays with the iPhone's silent switch on (or alongside other apps' music, as a setting), pauses for calls and when headphones are unplugged, and keeps the screen on while the engine runs. Settings, builds and best times are kept in native storage (Capacitor Preferences) instead of web view storage.

Every push to `main` or `claude/app-shell` runs `.github/workflows/app.yml`: it builds an Android debug APK (downloadable from the run) and compiles the iOS app for the simulator. Icon and launch-screen sources are in `assets/`; regenerate the native sizes with `npx capacitor-assets generate --ios --android`.

## Free and Pro

The apps are free with a one-time **Firing Order Pro** unlock. Free: five engines (Berlinetta V12, Small-Block V8, Tuner Six, Screamer Four, Big Twin), Rev, Drive and Fly-by, the engine view and pressure trace, the basic workshop (listening, silencer, exhaust valve, rev limit, traction control) and the builder with one saved build. Pro adds every engine, the other scenes, the rest of the workshop, spectrum, p–V, dyno, A/B compare, the mixer, launch control, nitrous and unlimited builds. Locked engines play for 30 seconds from the garage. The split lives in `js/config.js` (`FREE`).

Purchases go through [RevenueCat](https://www.revenuecat.com) (`@revenuecat/purchases-capacitor`); `js/platform/purchases.js` is the only code that talks to it, and the rest of the app asks `app.isPro()`. The web version has no store and stays unlocked (`WEB_UNLOCKED` in `js/config.js`); Settings → Pro can show the free version. For testing the purchase screens in a browser, open the page with `?store=mock`. App builds without RevenueCat keys offer "Unlock for testing" instead of a purchase.

To connect the stores:

1. **App Store Connect**: create the app (bundle id `com.iampaviic.firingorder`), then In-App Purchases → Non-Consumable, product id `firingorder_pro`, reference name "Firing Order Pro". Set the price, turn on Family Sharing, add a screenshot of the Pro screen for review.
2. **Play Console**: create the app (package `com.iampaviic.firingorder`), then Monetize → One-time products → product id `firingorder_pro`, name "Firing Order Pro", set the price and activate it.
3. **RevenueCat**: create a project, add the iOS app (with an App Store Connect in-app purchase key) and the Android app (with Google Play service credentials). Import `firingorder_pro` from both stores, create the entitlement `pro` and attach both products, and add a Lifetime package with both products to the `default` offering.
4. Copy the public SDK keys (`appl_…` and `goog_…`) into `STORE.revenueCatKeys` in `js/config.js`.
5. Test with an App Store sandbox account and a Play Console license tester (the Android build has to come from a Play testing track for real purchases).

## On phones

In portrait the tach and figures sit on top and one lab panel shows below: the tabs switch between the pipe schematic (Engine) and the instruments. The pedals sit at the thumbs with modes, START, shifting and the LAUNCH / TC / BLIP / A/B chips between them. Scenes get their own strip above the deck. In landscape the pedals take the sides and the controls float in a pill at the bottom. The workshop and the builder are full-screen with a Hold to rev button, and the builder's spec sheet is its own tab, summed up in one line above the steps.

## Performance

A V12 needs about 12–15% of one desktop core, the W16 about 20%. On slower phones the simulator detects the load and runs the physics at half rate, upsampled. You can force this under Workshop → Physics rate.

## Development tools

Node 18+ runs the real worklet code offline:

```sh
node tools/render.mjs v8-ls rev out.wav        # scenarios: rev idle dyno drive boost flyby
python3 tools/analyze.py out.wav out.png       # spectrogram, waveform
python3 tools/psd.py psd.png out.wav:6:7:6500:label   # spectrum with engine-order markers
node tools/batch.mjs                           # every preset: idle, torque, power, stability
node tools/loudness.mjs                        # loudness trims
node tools/knockcal.mjs                        # per-engine knock calibration
node tools/hold.mjs v12-65 6000 1 '' out.wav   # fixed rpm/throttle on an infinite-inertia dyno
```

Layout: `js/audio/engine-worklet.js` holds the physics and the scene scripts, `js/engine/compile.js` turns an engine spec into a pipe network and valve tables, `js/engine/presets.js` holds the engine library, `js/engine/builder.js` turns builder designs into specs, `js/engine/analyze-worker.js` is the virtual dyno, and `js/ui/*` holds the tach, pressure-wave schematic, scope, garage, workshop, builder and scenes.
