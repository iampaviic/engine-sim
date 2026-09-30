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
5. **Everything else is also simulated**: an ECU (idle control, fuel cut on overrun, rev limiter, launch control, traction control, VTEC-style cam switching, anti-lag), turbochargers (compressor map with surge, wastegate, blow-off valve or compressor flutter), superchargers with lobe whine, afterfire in the exhaust, a drivetrain, tyres and a dyno.

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

The **Workshop** changes hardware and rebuilds the model live: silencer type, X/H-pipe or true duals, cats, header lengths, cams, flywheel, turbo/supercharger swaps, boost, blow-off valve, anti-lag, rev limit, fuel or spark-cut limiter, overrun pops, launch control, traction control and gearbox. It also sets the microphone position (behind, at the tail pipes, pit wall, in front, engine bay, cockpit), the place (open road, garage, tunnel, canyon, anechoic) and the physics rate.

## Controls

| | Keyboard | Touch / gamepad |
| --- | --- | --- |
| Start / stop | Enter | START button / A |
| Throttle | W or ↑ (A = part throttle), mouse wheel = hand throttle | right pedal / RT |
| Brake | S or ↓ | left pedal / LT |
| Blip | Space | BLIP / X |
| Shift | Q / E or ← / → | − / + / LB, RB |
| Launch control | hold L | LAUNCH / B |
| Rev, Drive, Fly-by | 1, 2, 3 | mode switch |
| Dyno run | D | DYNO tab |
| Mic / place | C / V | Y (mic) |
| Garage / workshop | G / T | top bar |

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
node tools/hold.mjs v12-65 6000 1 '' out.wav   # fixed rpm/throttle on an infinite-inertia dyno
```

Layout: `js/audio/engine-worklet.js` holds the physics, `js/engine/compile.js` turns an engine spec into a pipe network and valve tables, `js/engine/presets.js` holds the engine library, and `js/ui/*` holds the tach, pressure-wave schematic, scope, garage and workshop.
