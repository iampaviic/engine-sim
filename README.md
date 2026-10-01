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
6. **Everything else is also simulated**: an ECU (idle control, fuel cut on overrun, rev limiter, spark map with knock control, launch control, traction control, VTEC-style cam switching, anti-lag), turbochargers (compressor map with surge, wastegate, blow-off valve or compressor flutter, screamer pipe), twin-screw, Roots and centrifugal superchargers, afterfire in the exhaust, a drivetrain, tyres and a dyno.

Each engine's character comes out of its geometry: firing order, crank and bank angle, header lengths and how they merge. A cross-plane V8 burbles because each bank fires unevenly. A flat-plane V8 or a V12 screams because the pulses arrive evenly. An unequal-length boxer rumbles because the pulses arrive at the collector unevenly.

## Engines

| Engine | Layout |
| --- | --- |
| Berlinetta V12 | 6.5 L 65° V12, naturally aspirated |
| Toro V12 | 60° V12, tri-Y headers |
| Small-Block V8 | 6.2 L cross-plane pushrod V8 |
| Big-Block 427 | Cross-plane V8, race cam with 84° overlap |
| Blower V8 | Cross-plane V8 with a twin-screw supercharger |
| Flat-Plane V8 | High-revving flat-plane V8 |
| Angel V10 | 72° V10, equal-length 5-into-1 headers |
| F1 V10 | 19,000 rpm, pneumatic valves |
| Boxer Six | Flat six with individual throttle bodies |
| Tuner Six | Straight six, big single turbo |
| Rally Four | Turbo four with anti-lag |
| Screamer Four | NA four with a high-rpm cam switch |
| Rumble Boxer | Turbo flat four, unequal-length headers |
| Twin Rotor | Two-rotor Wankel, bridge-ported |
| Big Twin | 45° V-twin, 1.9 L |
| Hot-Vee V8 | 4.0 L cross-plane V8, twin turbos inside the vee |
| Turbo Five | 2.5 L inline-5 turbo, fires 1-2-4-5-3 |

The **Workshop** changes hardware and rebuilds the model live: silencer, headers (n-into-1, tri-Y, 4-2-1, cast log, or 180° "bundle of snakes" for cross-plane V8s), X/H-pipe or true duals, cats, resonators, rear or side exits, header lengths, air intake (airbox, ram air, open filter), individual throttle bodies, cams, valve springs, flywheel, turbo or supercharger swaps (twin-screw, Roots, centrifugal), boost, blower pulley, blow-off valve, screamer pipe, anti-lag, rev limit, limiter type, overrun pops, ignition timing, fuel octane, knock sensor, launch control, traction control and gearbox. It also holds the **mixer** (exhaust pipes, intake, mechanical, road; each can be soloed) and the **A/B compare** slot (factory spec, a stored setup or another engine; hold A/B or B to hear it).

## Engine builder

**Build** opens a workbench for designing an engine from scratch: inline, vee, flat or rotary (1 to 16 cylinders, 2 to 4 rotors), bank angle, bore, stroke, rod length, compression, crankshaft, valvetrain, cams, a second cam profile, induction, intake runners, headers, exhaust, ECU and the car it sits in.

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
| Rev, Drive | 1, 2 | mode switch |
| Fly-by, tunnel, quarter mile, mountain | 3, 4, 5, 6 | Scenes |
| A/B compare | hold B | A/B chip, Workshop |
| Dyno run | D | DYNO tab |
| Mic / place | C / V | Y (mic) |
| Garage / workshop | G / T | top bar |

## On phones

In portrait the tach and figures sit on top and one lab panel shows below: the tabs switch between the pipe schematic (Engine) and the instruments. The pedals sit at the thumbs with modes, START, shifting and the LAUNCH / TC / BLIP / A/B chips between them. Scenes get their own strip above the deck. In landscape the pedals take the sides and the controls float in a pill at the bottom. The workshop and the builder are full-screen with a Hold to rev button, and the builder's spec sheet is its own tab, summed up in one line above the steps.

## Performance

A V12 needs about 12–15% of one desktop core. On slower phones the simulator detects the load and runs the physics at half rate, upsampled. You can force this under Workshop → Physics rate.

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
