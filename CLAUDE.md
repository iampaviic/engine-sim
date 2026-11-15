# Firing Order: guide for agents

A physically modelled engine sound simulator: vanilla ES modules, no framework, no web build step, with iOS and Android shells through Capacitor. It is a personal project that will not be published to the App Store or Google Play: store compliance, monetisation and release hardening are out of scope. Every feature is always available: there is no paywall or gating. Every sound comes from a per-sample physics simulation, with no samples or recordings. `README.md` explains the physics and every feature for users; read its section on a subsystem before changing that subsystem. This file maps where things live and lists the rules the code itself doesn't state.

## Map

| Path | What it is |
| --- | --- |
| `js/audio/engine-worklet.js` | **The sound's entry point**: registers the processor. The code is in `js/audio/worklet/`, below. |
| `js/audio/worklet/engine-sim.js` | `EngineSim`: the constructor declares all of an engine's state; `render()` is the per-sample loop. |
| `js/audio/worklet/sim/*.js` | `EngineSim`'s methods by subsystem: `cylinders`, `ecu`, `starter` (and the fuel pump), `induction`, `nitrous`, `drivetrain` (the automatic clutch and gearbox, tyres, dyno), `gearbox` (the manual gearbox: the driver's clutch, synchronisers, refused gears and their grind), `mechanical` (valve, slap, timing, injector, alternator and gear noise), `thermal` (engine temperature, its effects, exhaust ticking, radiator fan), `weather` (the day's air and road: ambient, charge oxygen, humidity's knock margin, grip, tyre spray, rain on the roof, the ground's reflection), `aero`, `sources`. |
| `js/audio/worklet/*.js` | `constants`, `dsp` (RNG, helpers, `Struck`, `Band4`, `Modes`), `net` (`Net`, the waveguide pipe network), `inlet` (`Inlet`: airbox and snorkel), `listener` (`Listener`, `EngineSim.listen()`), `camera` (mic and body geometry), `scenes` (scripted drives), `processor` (`EngineProcessor`), `mixin`. |
| `js/audio/worklet-bundle.js` | Joins the worklet's modules into one script for the blob fallback in `audio.js`. |
| `js/engine/presets.js` | The engine library: `PRESETS` array of human-readable specs. |
| `js/engine/compile.js` | `compileEngine(spec)` turns a spec into the pipe networks, valve/port tables and firing offsets, `mechSpec()` into the mechanical-noise parameters (structure modes, impact masses, tooth counts), `inletSpec()` into the airbox and snorkel sizes and `thermalSpec()` into the thermal masses and conductances. `workletConfig()` strips it for `postMessage`. |
| `js/engine/builder.js` | Engine builder designs ⇄ specs, firing-order enumeration, saved builds. |
| `js/engine/maps.js` | Tuning-map layout (ignition, fuel, boost tables). |
| `js/engine/analyze-worker.js` | Virtual dyno: imports the worklet in a Web Worker and runs it faster than real time. |
| `js/audio/audio.js` | Web Audio graph: worklet → dry + 2 convolution reverbs (procedural IRs) → compressor → limiter → master. |
| `js/main.js` | The app's entry point: frame loop, page wiring (`wire()`), boot sequence. |
| `js/app/*.js` | The app: `state` (`app`, `store`, `$`), `ui` (tach, schematic, scope, panels, toast, tabs), `engine` (load, `app.rebuild`, `app.setTune`, `defaultTune`, `describeMods`), `actions` (`action()`, `start()`), `telemetry` (`onMessage()`, `onTelemetry()`), `modes` (`setMode()`, scenes, dyno run), `thermal` (each engine's temperatures saved and cooled down between visits), `mixer`, `ab`, `follow`, `prefs`, `platform` (audio session, wake lock, native shells). |
| `js/ui/*` | `tach`, `schematic` (pressure waves), `scope` (spectrum, p–V, dyno), `view3d` (three.js), `garage`, `workshop`, `maps`, `builder`, `scenes`, `controls`, `carlink`, `settings`. |
| `js/car/*` | Follow my car: ELM327 over Web Bluetooth (`elm.js`, `obd.js`), GPS + motion fusion (`gps.js`), demo drive. |
| `js/platform/*` | Capacitor bridges: native plugins (`native.js`), storage, haptics (`haptics.js`: the Haptics plugin's impacts or the Vibration API, with priorities and rate limits). |
| `tools/` | Node harness that runs the real worklet offline, plus Python analysis. |
| `ios/`, `android/` | Native shells. Only touch these for native features (the `EngineAudio` plugin lives there). |

## Inside the worklet

Bottom-up through `js/audio/worklet/`: `constants.js` and `dsp.js` (helpers, `Struck`, `Band4`, `Modes`), `net.js` (`Net`, the waveguide pipe network), `inlet.js` (`Inlet`, the airbox and snorkel), `listener.js` (`Listener`: per-source delay lines), `engine-sim.js` and `sim/*.js` (`EngineSim`, one engine), `camera.js` (camera and body geometry), `scenes.js`, then `processor.js` (`EngineProcessor`: messages, hot swap, eco mode).

`EngineSim` and `EngineProcessor` are each one class written across several files. A part file exports a class used only as a bag of methods (`CylinderMethods`, `SceneMethods`, …), and `mixin()` copies those methods onto the real prototype once at load, so `this.stepTurbo()` is an ordinary method call wherever it is written. All of `EngineSim`'s state is declared in its constructor in `engine-sim.js`, whichever file uses it.

`EngineSim.render()` (`engine-sim.js`) is the per-sample loop, in this order (the file each step lives in is in brackets):

1. Every 32 samples: `control()` (ECU, idle, limiter, knock control, boost control, nitrous, vehicle, starter, fuel pump, engine temperature, tyre spray) [`sim/ecu.js`, calling into `nitrous.js`, `drivetrain.js` (and `gearbox.js` with the manual box), `starter.js`, `thermal.js`, `weather.js`].
2. Advance the crank.
3. `ex.read()` / `inn.read()` [`net.js`] → `stepCylinders()` (thermodynamics, combustion, valve flow coupled implicitly to the pipes; returns gas torque) [`sim/cylinders.js`] → `ex.scatter()` → `stepIntake()` [`sim/induction.js`] → `write()`.
4. `stepBoost()` (turbo, supercharger) [`sim/induction.js`] → `stepDrivetrain()` (returns the new crank speed; with the manual box and no gear engaged, `stepInputShaft()` couples the crank to the input shaft) [`sim/drivetrain.js`, `sim/gearbox.js`].
5. `stepSources()` mixes the 7 source channels [`sim/sources.js`], calling `stepMech()` and `gearSound()` [`sim/mechanical.js`] and, on a wet road, `spraySound()` [`sim/weather.js`] → `listen()` renders them for the mic position [`listener.js`], adding `roofRain()` in the cabin while it rains.

Sound sources (`N_SRC = 7`, the order the mixer's gains use): `0, 1, 2` exhaust L/R/centre, `3` intake (with turbo and nitrous sounds), `4` mechanical (valves, piston slap, combustion and knock through the block, timing drive, injectors, alternator, gear whine, starter, exhaust ticking as it cools, radiator fan), `5` chassis (road, wind, tyre squeal, bumps, tyre spray on a wet road, the fuel pump; always active, since the pump runs in rev mode too; its mixer gain also scales the wind and the rain on the roof heard in the cabin), `6` wastegate dump. Per-engine level knobs are `spec.sound` (`exhaust`, `trim`, …). The intake has none: `stepSources()` feeds the change in the flow the inlet tract supplies (the throttle's, the bell mouths', or a compressor's) to `Inlet`, whose sizes come from `inletSpec()` and `intake.airbox` (`stock`, `ram`, `open`); the throttle's jet noise, the turbo's voice and a blower's whine go out the same way. The mechanical channel has none either: its level comes from the engine's dimensions and hardware (`spec.block: 'iron'`, `sound.valvetrain`, `sound.lifters`, `sound.timing`, `sound.injection`, `sound.alternator`; see `mechSpec()`), and it is calibrated in pascals at 1 m against measured engine noise.

Engine temperature (`sim/thermal.js`): seven lumped masses (`this.th`: `w` chamber metal, `h` head coolant and sender, `b` block, `o` oil, `m` intake manifold, `r` fuel rail, `x` exhaust manifold; kelvin) stepped by `thermalStep()` at control rate. The same function cools a stored engine down on the main thread (`soakThermal()`, used by `js/app/thermal.js`), so the app imports that worklet module. `thermalEffects()` turns the temperatures into what the rest of the model reads: `visc` (friction), `fastIdle`, `idleAirK`, `chargeDT` (added to the intake temperature in `stepCylinders()`), `burnK`, `covCold`, the slap clearance, bled lifters (`cBleed`), rail `vapour`. Every one of them is exactly neutral at the warm reference (`T_WARM`, `T_OIL_WARM`), which is the state a new `EngineSim` starts in and the one every calibration (`batch`, `loudness`, `knockcal`, the dyno worker) runs at.

Weather (`sim/weather.js`): `setWeather('dry' | 'damp' | 'rain')` sets the shared ambient `ambT` (which the thermal model, the naturally aspirated charge in `nitrous.js` and the compressors and intercoolers in `induction.js` read), `airO2` (the oxygen a charge carries against the dry day's, applied in `onIVC()`), `humON` (octane numbers the damp air is worth, in `setOctane()`), `gripK` and `slideK` (the tyre, traction and launch control in `drivetrain.js` and `ecu.js`), `squealK`, the spray's level, the roof's rain and the ground reflection's `gndG` / `gndF` (read in `camera.js`). Dry is the calibration reference and every one of these is exactly neutral there (`ambT === T_AMB`, `airO2 === 1`, `humON === 0`, `gripK === 1`, `slideK === 0` keeping the old tyre code on its own branch), so dry renders are bit-identical to a build without weather; keep it that way. The pipe network's gas dynamics stay at `P_AMB` and `T_AMB` whatever the weather. Spray and rain draw from their own random stream (`wrnd()`), so the engine's cycle-to-cycle variation is the same in any weather. The processor keeps the weather (`this.weather`) and applies it to every engine it builds.

Cylinder events: `onIVC()` (charge trapped: combustion variation, knock setup), `onEVO()` (blowdown, afterfire). Two-strokes, rotaries, starters, kick start, nitrous, turbo flutter, aero/wind and scenes each have their own methods. `grep -n '^  [a-zA-Z]*(.*) {$' js/audio/worklet/*.js js/audio/worklet/sim/*.js` lists every method with its file.

Cameras (mic positions): `rear`, `exhaust`, `side`, `front`, `bay`, `cockpit` (cabin filtering), `flyby`.

## Message flow

Main → worklet (`app.audio.post`): `config` (compiled engine plus tune; `hot: true` swaps hardware while keeping the running state), `thermal` (`{ state }` a saved state already cooled to now, or `{ preset: 'cold' | 'warm' }`; sent after every non-hot `config`), `tune` (`autoShift` and `manual` follow the driver's gearbox choice, `app.gearbox`, kept across engines), `input` (`pedal`, `brake`, `clutch` (0 up, 1 floored; read only by the manual box), `launch`, `nos`), `ignition` (`on` without `crank` is key-on: the fuel pump primes; the app cranks 0.9 s later), `weather` (`dry`, `damp`, `rain`: the app's `app.weather`, sent before the first `config` and on every change), `shift`, `mode`, `camera`, `mix`, `dyno`, `flyby`, `scene*`, `follow`, `strobe`, `quality`. Handled in `EngineProcessor.onMessage()` (`worklet/processor.js`).

Worklet → main: `tel` (telemetry, built in `postTelemetry()`; `id`, `coolant`, `oil`, `fan` and the whole thermal state `th`, which the app saves every 5 s and on `pagehide`; and since the last message `stall` and `refused` (counts) and `grind` (the largest speed difference a gear ground at, rpm), for event-driven feedback; `weather`; for haptics `rip` (the crank torque's swing about its mean, N·m rms over the interval), `fire` (firing frequency, Hz) and `accel`), `interlock` (START refused in gear with the clutch up), `scope`, snapshots and scene events. Handled in `js/app/telemetry.js` `onMessage()` / `onTelemetry()`.

Two kinds of change reach the engine:

- **Hardware** (spec): `app.rebuild(mutate)` → recompile → `config` with `hot: true`. This rebuilds `EngineSim`.
- **Tune** (no rebuild): `app.setTune({...})` → `tune` message → `applyTune()`.

## Recipes

**Add a spec field (new hardware):** read it in `compile.js` (geometry or pipe network) or pass it through to the `EngineSim` constructor via the compiled config. If users can change it, add it to the workshop (`js/ui/workshop.js` `renderHardware`), `describeMods()` in `js/app/engine.js`, and `specToDesign`/`designToSpec` in `builder.js` if the builder should offer it.

**Add a tune parameter:** `defaultTune()` in `js/app/engine.js` → `applyTune()` in `worklet/processor.js` → the carry-over key list in `installSim()` there. Otherwise it resets on every hot rebuild.

**Add sim state that must survive a hardware change:** declare it in the `EngineSim` constructor (`worklet/engine-sim.js`) and add the key to the `hot` carry-over lists in `installSim()`.

**Add an engine:** a new spec const in `presets.js`, appended to `PRESETS`. Model it on the closest existing preset (units: mm and crank degrees; cam `[open, close, lift]`). Then calibrate:
- `node tools/knockcal.mjs <id>`, and copy the suggested value into `ecu.knockCal`.
- `node tools/loudness.mjs <id>`, and copy the suggested value into `sound.trim`.
- Check `node tools/batch.mjs <id>` (idle holds its target, power is plausible, `nan 0`).
- Add a row to the README engine table.

**Add a feature:** give it a keyboard shortcut and touch control (`js/ui/controls.js`, README Controls table), and check the phone portrait layout.

## Verify

You can't hear the output, so judge sound changes by measurement, and render WAVs for the user to listen to.

```bash
npm test                                        # batch on v8-ls and v12-65, then check-bundle, ~15 s: idle, torque, power, NaN, CPU
node tools/batch.mjs [--cold] [--weather rain]  # every preset, warm on a dry day (or cold through, or another day); run after any physics change
node tools/warmup.mjs <id> <idle|drive> [min] [min off] [out.csv]  # temperatures against time: cold start, run, switch off, soak
node tools/render.mjs <id> <scenario> out.wav [--camera cockpit] [--thermal cold] [--weather rain]   # rev idle dyno drive boost flyby autobahn
node tools/hold.mjs <id> <rpm> <pedal> '<jsonOverrides>' out.wav   # steady state, A/B a spec change
node tools/sources.mjs <id|all> <rpm|idle|limit> <pedal>           # each source alone, dB SPL at 1 m
python3 tools/psd.py psd.png out.wav:t0:t1:rpm:label [more.wav:...] # spectrum with engine-order markers
python3 tools/analyze.py out.wav out.png        # spectrogram and waveform
node tools/exhaust-ir.mjs <id>                  # exhaust network frequency response
node tools/debug-cycle.mjs <id> <rpm> <pedal>   # one cylinder's thermodynamic cycle
node tools/test-car.mjs                         # OBD parser, fake adapter session, GPS fusion
node tools/check-bundle.mjs                     # the single-script fallback renders the same as the modules
node tools/serve.mjs                            # http://localhost:8080 for the browser (Playwright + Chromium are preinstalled)
```

The Python tools need `pip install numpy scipy matplotlib`. Read the PNGs they produce with the Read tool.

Offline renders are deterministic (the random stream is seeded), so a change that should not alter the sound, such as a refactor, must leave every render **bit-identical**: hash the float output of `render()` for each preset before and after.

Compare a sound change **before and after on the same scenario**: the spectrum at the engine orders that matter (for example order 4 for a cross-plane V8 at 4,000 rpm), RMS level, and `batch` numbers for every preset. A change aimed at one engine must leave the others' `batch` output and loudness unchanged, unless that's intended.

## Rules the code doesn't state

- **The worklet is its own module graph.** Everything under `js/audio/worklet/` may import only from that folder: it runs in the audio thread, in the dyno's Web Worker and in Node, with no DOM and none of the app. It is loaded three ways: `audioWorklet.addModule()` in `audio.js`, `import()` in `analyze-worker.js`, and `import()` from `tools/render.mjs`.
- **Worklet modules keep a plain import style**, because the blob fallback in `audio.js` (for hosts that refuse the worklet's URL) joins them into one script by text (`worklet-bundle.js`): only `import { a, b } from './x.js';`, `export` only in front of a top-level `const`, `let`, `function` or `class`, no default exports or renames, and no two modules declaring the same top-level name. `node tools/check-bundle.mjs` (in `npm test`) fails if the joined script does not render identically.
- **Shared worklet state is a single instance.** The seeded random stream (`rnd()` in `dsp.js`) makes offline renders repeatable; never copy it or the constants into another module. `tools/render.mjs` calls `reseed()` before each render, because Node loads the modules once per process.
- **App modules (`js/app/`) import each other in cycles.** That is safe only while a module's top level just defines things and assigns to `app`. Code that calls into another app module at load time belongs in the boot sequence at the bottom of `main.js`.
- **The per-sample path is hot.** Inside `render()` and everything it calls, allocate no arrays, objects or closures, and precompute coefficients outside the loop (in `control()` or the constructor). Budget: a V12 at ~15% of a desktop core, the W16 ~20%. Watch `batch`'s `cpu` column. Slow phones fall back to eco (half-rate physics), so code that depends on the sample rate must work at both `fs` and `fs / 2`.
- **Physics first.** A sound feature should come from a physical mechanism (pressures, flows, structures, radiation) with real-world parameters. Comment the physics and its source in prose, the way the existing code does. Ad-hoc gains are a last resort, and they need a comment saying why.
- **Temperature effects are measured from the warm reference.** Anything that reads the engine's temperature must change nothing at `T_WARM` / `T_OIL_WARM` (write it as a deviation from them), so the warm engine stays the calibrated one and the tools, which start warm, keep their numbers.
- **Watch for NaN.** One NaN silences the engine for good. Clamp divisions, `sqrt` and `pow` near zero flow or pressure, and keep `batch`'s `nan` column at 0.
- **Names stay generic.** Engines, scenes and labels avoid trademarks (no brand, model or VTEC/F1 wording). Specs may be modelled on real engines; their names may not.
- **Keep `README.md` current.** It is the user manual: a new feature, engine, control or physics mechanism gets its sentence there.
- **Vanilla only.** No runtime dependencies or bundler for the web app. three.js is vendored (see README to rebuild it). Code style: 2 spaces, single quotes, semicolons, comments in full sentences.
- **Storage** goes through `js/platform/storage.js` (native Preferences or localStorage), never `localStorage` directly.
- **Haptics** go through `js/platform/haptics.js` (`tap`, `taps`, `shake`), never `navigator.vibrate` or the plugin directly, so the setting, reduced motion, the system's switch, priorities and rate limits apply. Natively use only the plugin's impact styles (they follow the system's haptics switches); its `vibrate` does not. The events and their strengths are in `feel()` in `js/app/telemetry.js`.
- CI (`.github/workflows/app.yml`) builds Android and iOS on every push to `main` and `claude/**`. `main.yml` deploys `main` to GitHub Pages.

## Known soft spots

Simpler than the rest of the model, so the likeliest wins:

- **Mechanical channel** (`sim/mechanical.js`): piston slap is evaluated only at the dead centres (the mid-stroke reversals are missing, which leaves two-strokes too quiet); the two-stroke's idle sets off the knock model; reeds, clutch and primary drive make no sound; tyre squeal is a wobbling sine.
- **Chassis and road noise:** the dry road's noise is low-passed noise scaled by speed, with a sample-rate dependent corner (153 Hz at full rate, 76 Hz in eco) and almost nothing above 1 kHz, far quieter than a real tyre's; the wet road's spray is calibrated in pascals against measured wet-road noise, so in the rain it stands out against the dry more than on a real road.
- **Intake:** the inlet tract is driven one way (its pressure does not act back on the engine's breathing, so there is no intake-tract tuning of the torque curve), and the throttle has no inertia, so a plenum engine's roar is a little bright. On a blower engine the throttle is modelled after the blower. The levels of the turbo's whoosh and flutter, and of the edge-tone whistle, are estimates.
- **Manual gearbox** (`sim/gearbox.js`): every box has synchronisers, including the motorcycles' and the race cars', which really have dog boxes that shift clutchless by design; there is no reverse; the synchroniser's torque, the driver's push, the blocker's holding time and the share of each grinding blow that reaches the casing are estimates.
- **Temperature** (`sim/thermal.js`): the cylinder model has no wall heat transfer, so a cold chamber acts only through the charge's temperature and a burn-rate factor; the ambient (`ambT`) is the weather's, but the gas dynamics still use `T_AMB`; there is no under-bonnet air temperature; every engine is liquid-cooled (the Big Twin would really be air-cooled); many conductances, the tick and fan levels and the rail-vapour threshold are estimates.
- **Weather** (`sim/weather.js`): the days' temperatures, pressures and humidities, the damp road's grip, the water films, the humidity's octane value, the roof's size and damping and the ground's wet reflection are estimates; every tyre (slicks too) loses the same share of its grip in the wet; the charge has no wall heat transfer, so cool air gains about its full density (SAE J1349 would credit the v8-ls's rain day with +0.8% power, the model gives +1.7%); traction control is the simple slip-threshold spark cut, which cannot pull enough torque off a big engine on a wet road, so wet launches spin longer than a modern system would allow; rain falls only on the roof, heard only in the cockpit (no windscreen, no wipers, nothing outside), and not on a motorcycle.
- **Haptics** (`js/app/telemetry.js` `feel()`): the strength scales (4 m/s^2 for a full shift jolt, 8 for a launch, 1,500 rpm for a grind), the engine mounts' 10 Hz roll mode and damping, the half-metre lever and the felt range of the idle shake (2 mm/s^2 to 0.5 m/s^2) are estimates; telemetry comes 40 times a second, so taps land up to 25 ms late and the torque swing of a slow-firing engine is measured over less than one firing; tested only with a mocked `navigator.vibrate` and a mocked plugin, never on a phone.
- **Post chain** (`audio.js`): fixed compressor and limiter settings plus makeup gain shape every engine the same way, and the reverbs are procedural IRs.
