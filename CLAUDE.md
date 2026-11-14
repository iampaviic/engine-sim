# Firing Order: guide for agents

A physically modelled engine sound simulator: vanilla ES modules, no framework, no web build step, shipped to iOS and Android through Capacitor. Every sound comes from a per-sample physics simulation, with no samples or recordings. `README.md` explains the physics and every feature for users; read its section on a subsystem before changing that subsystem. This file maps where things live and lists the rules the code itself doesn't state.

## Map

| Path | What it is |
| --- | --- |
| `js/audio/engine-worklet.js` | **The sound.** All physics plus the scene scripts, one self-contained file (~4,700 lines). |
| `js/engine/presets.js` | The engine library: `PRESETS` array of human-readable specs. |
| `js/engine/compile.js` | `compileEngine(spec)` turns a spec into the pipe networks, valve/port tables and firing offsets. `workletConfig()` strips it for `postMessage`. |
| `js/engine/builder.js` | Engine builder designs ⇄ specs, firing-order enumeration, saved builds. |
| `js/engine/maps.js` | Tuning-map layout (ignition, fuel, boost tables). |
| `js/engine/analyze-worker.js` | Virtual dyno: imports the worklet in a Web Worker and runs it faster than real time. |
| `js/audio/audio.js` | Web Audio graph: worklet → dry + 2 convolution reverbs (procedural IRs) → compressor → limiter → master. |
| `js/main.js` | App state (`app`), wiring, worklet messages, telemetry → UI. |
| `js/ui/*` | `tach`, `schematic` (pressure waves), `scope` (spectrum, p–V, dyno), `view3d` (three.js), `garage`, `workshop`, `maps`, `builder`, `scenes`, `controls`, `carlink`, `paywall`, `settings`. |
| `js/car/*` | Follow my car: ELM327 over Web Bluetooth (`elm.js`, `obd.js`), GPS + motion fusion (`gps.js`), demo drive. |
| `js/platform/*` | Capacitor bridges: native plugins, storage, RevenueCat purchases. |
| `js/config.js` | Free/Pro split (`FREE`), store keys. |
| `tools/` | Node harness that runs the real worklet offline, plus Python analysis. |
| `ios/`, `android/` | Native shells. Only touch these for native features (the `EngineAudio` plugin lives there). |

## Inside the worklet

Top-down in the file: constants and DSP helpers (`ResBank`, `Band4`, `Modes`), `Net` (the waveguide pipe network), `Listener` (per-source delay lines), `EngineSim` (one engine), the camera and body geometry, then `EngineProcessor` (messages, scenes, hot swap, eco mode).

`EngineSim.render()` is the per-sample loop, in this order:

1. Every 32 samples: `control()` (ECU, idle, limiter, knock control, boost control, nitrous, vehicle, starter).
2. Advance the crank.
3. `ex.read()` / `inn.read()` → `stepCylinders()` (thermodynamics, combustion, valve flow coupled implicitly to the pipes; returns gas torque) → `ex.scatter()` → `stepIntake()` → `write()`.
4. `stepBoost()` (turbo, supercharger) → `stepDrivetrain()` (returns the new crank speed).
5. `stepSources()` mixes the 7 source channels → `listen()` renders them for the mic position.

Sound sources (`N_SRC = 7`, the order the mixer's gains use): `0, 1, 2` exhaust L/R/centre, `3` intake (with turbo and nitrous sounds), `4` mechanical (valvetrain ticks, block, knock, gear whine, starter), `5` chassis (road, wind, tyre squeal, bumps), `6` wastegate dump. Per-engine level knobs are `spec.sound` (`exhaust`, `intake`, `mech`, `trim`, …).

Cylinder events: `onIVC()` (charge trapped: combustion variation, knock setup), `onEVO()` (blowdown, afterfire). Two-strokes, rotaries, starters, kick start, nitrous, turbo flutter, aero/wind and scenes each have their own methods. `grep -n '^  [a-zA-Z]*(.*) {$'` on the file lists them.

Cameras (mic positions): `rear`, `exhaust`, `side`, `front`, `bay`, `cockpit` (cabin filtering), `flyby`.

## Message flow

Main → worklet (`app.audio.post`): `config` (compiled engine plus tune; `hot: true` swaps hardware while keeping the running state), `tune`, `input`, `ignition`, `shift`, `mode`, `camera`, `mix`, `dyno`, `flyby`, `scene*`, `follow`, `strobe`, `quality`. Handled in `EngineProcessor.onMessage()`.

Worklet → main: `tel` (telemetry, built in `postTelemetry()`), `scope`, snapshots and scene events. Handled in `main.js` `onMessage()` / `onTelemetry()`.

Two kinds of change reach the engine:

- **Hardware** (spec): `app.rebuild(mutate)` → recompile → `config` with `hot: true`. This rebuilds `EngineSim`.
- **Tune** (no rebuild): `app.setTune({...})` → `tune` message → `applyTune()`.

## Recipes

**Add a spec field (new hardware):** read it in `compile.js` (geometry or pipe network) or pass it through to the `EngineSim` constructor via the compiled config. If users can change it, add it to the workshop (`js/ui/workshop.js` `renderHardware`), `describeMods()` in `main.js`, and `specToDesign`/`designToSpec` in `builder.js` if the builder should offer it.

**Add a tune parameter:** `defaultTune()` in `main.js` → `applyTune()` in the worklet → the carry-over key list in `installSim()`. Otherwise it resets on every hot rebuild.

**Add sim state that must survive a hardware change:** add the key to the `hot` carry-over lists in `installSim()`.

**Add an engine:** a new spec const in `presets.js`, appended to `PRESETS`. Model it on the closest existing preset (units: mm and crank degrees; cam `[open, close, lift]`). Then calibrate:
- `node tools/knockcal.mjs <id>`, and copy the suggested value into `ecu.knockCal`.
- `node tools/loudness.mjs <id>`, and copy the suggested value into `sound.trim`.
- Check `node tools/batch.mjs <id>` (idle holds its target, power is plausible, `nan 0`).
- Add a row to the README engine table, and decide whether it belongs in `FREE.engines`.

**Add a feature:** decide its Free/Pro side in `js/config.js` (`FREE`; UI gates call `app.isPro()`), give it a keyboard shortcut and touch control (`js/ui/controls.js`, README Controls table), and check the phone portrait layout.

## Verify

You can't hear the output, so judge sound changes by measurement, and render WAVs for the user to listen to.

```bash
npm test                                        # batch on v8-ls and v12-65, ~10 s: idle, torque, power, NaN, CPU
node tools/batch.mjs                            # every preset; run after any physics change
node tools/render.mjs <id> <scenario> out.wav [--camera cockpit]   # rev idle dyno drive boost flyby autobahn
node tools/hold.mjs <id> <rpm> <pedal> '<jsonOverrides>' out.wav   # steady state, A/B a spec change
python3 tools/psd.py psd.png out.wav:t0:t1:rpm:label [more.wav:...] # spectrum with engine-order markers
python3 tools/analyze.py out.wav out.png        # spectrogram and waveform
node tools/exhaust-ir.mjs <id>                  # exhaust network frequency response
node tools/debug-cycle.mjs <id> <rpm> <pedal>   # one cylinder's thermodynamic cycle
node tools/test-car.mjs                         # OBD parser, fake adapter session, GPS fusion
node tools/serve.mjs                            # http://localhost:8080 for the browser (Playwright + Chromium are preinstalled)
```

The Python tools need `pip install numpy scipy matplotlib`. Read the PNGs they produce with the Read tool.

Compare a sound change **before and after on the same scenario**: the spectrum at the engine orders that matter (for example order 4 for a cross-plane V8 at 4,000 rpm), RMS level, and `batch` numbers for every preset. A change aimed at one engine must leave the others' `batch` output and loudness unchanged, unless that's intended.

## Rules the code doesn't state

- **The worklet is self-contained.** No `import`s: `audio.js` falls back to loading it from a blob, and Node and the dyno worker import it directly. Keep constants and helpers inside the file.
- **The per-sample path is hot.** Inside `render()` and everything it calls, allocate no arrays, objects or closures, and precompute coefficients outside the loop (in `control()` or the constructor). Budget: a V12 at ~15% of a desktop core, the W16 ~20%. Watch `batch`'s `cpu` column. Slow phones fall back to eco (half-rate physics), so code that depends on the sample rate must work at both `fs` and `fs / 2`.
- **Physics first.** A sound feature should come from a physical mechanism (pressures, flows, structures, radiation) with real-world parameters. Comment the physics and its source in prose, the way the existing code does. Ad-hoc gains are a last resort, and they need a comment saying why.
- **Watch for NaN.** One NaN silences the engine for good. Clamp divisions, `sqrt` and `pow` near zero flow or pressure, and keep `batch`'s `nan` column at 0.
- **Names stay generic.** Engines, scenes and labels avoid trademarks (no brand, model or VTEC/F1 wording). Specs may be modelled on real engines; their names may not.
- **Keep `README.md` current.** It is the user manual: a new feature, engine, control or physics mechanism gets its sentence there.
- **Vanilla only.** No runtime dependencies or bundler for the web app. three.js is vendored (see README to rebuild it). Code style: 2 spaces, single quotes, semicolons, comments in full sentences.
- **Storage** goes through `js/platform/storage.js` (native Preferences or localStorage), never `localStorage` directly.
- CI (`.github/workflows/app.yml`) builds Android and iOS on every push to `main` and `claude/**`. `main.yml` deploys `main` to GitHub Pages.

## Known soft spots

Simpler than the rest of the model, so the likeliest wins:

- **Mechanical channel** (`stepSources`): valvetrain ticks and block ring are noise-excited fixed resonator banks (`ResBank`); gear whine is two sines at a fixed 29 teeth; tyre squeal is a wobbling sine.
- **Chassis and road noise:** filtered noise scaled by speed.
- **Intake radiation:** the airbox is a two-pole low-pass on throttle mass flow, and ITB runner radiation is a fixed blend.
- **Post chain** (`audio.js`): fixed compressor and limiter settings plus makeup gain shape every engine the same way, and the reverbs are procedural IRs.
