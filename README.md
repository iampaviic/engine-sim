# Firing Order

A physically modelled engine sound simulator that runs in the browser, on desktop and mobile. None of the sound is sampled or synthesised from recordings: every cylinder, valve and exhaust pipe is simulated once per audio sample, and what you hear is the pressure wave that leaves the tail pipes.

## Play

Serve the folder over HTTP (the audio worklet needs it) and open it in a browser:

```sh
node tools/serve.mjs        # http://localhost:8080
```

Any static server works, and so does GitHub Pages: the workflow in `.github/workflows/main.yml` deploys `main` once Pages is set to "GitHub Actions" in the repository settings. Press **START** (or Enter) and use headphones or decent speakers. Most of an engine's character sits below 150 Hz.

## How the sound is made

Sound is pressure changing over time, so the simulator computes pressures:

1. **Cylinders** (0-D thermodynamics). Each cylinder integrates mass and internal energy through compression, a Wiebe-function burn, expansion and gas exchange, with cycle-to-cycle combustion variation, misfire from residual gas, and blow-by.
2. **Valves**. Compressible (choked or subsonic) orifice flow through the cam-driven lift curves, including ramps, overlap and reverse flow. The flow is solved implicitly against the pipe impedance so the valve and the pipe push on each other.
3. **Pipes**. Headers, collectors, X/H-pipes, cats, mufflers and tails are digital waveguides: pressure waves travel both ways at the local speed of sound (it follows exhaust gas temperature), scatter at junctions, lose high frequencies to friction and reflect at open ends. Strong blowdown pulses steepen toward shocks (finite-amplitude propagation), which gives high-load rasp.
4. **Radiation**. Each tail pipe (and the intake) radiates the time derivative of its mass outflow, like a monopole. Once a tail pipe's mouth is comparable to the wavelength it beams, so the highs are up to 6 dB stronger straight behind the pipe and far weaker in front of it. The gas leaving the pipe also roars where it tears into the still air (jet noise): broadband, centred near 0.2 U/D, growing with the cube of the exit velocity and chuffing with every pulse. The rest of the car shadows a front-mounted intake from a mic behind it (Maekawa's barrier diffraction over the roof line), taking the top off its roar but not its bass. A listener model adds distance delay (so fly-bys Doppler-shift on their own), a ground reflection, air absorption, head shadow and the cabin: inside, the sound comes through the body, whose panels and glass lose more the higher the pitch (the mass law) until the leaks round the seals level it off, so the exhaust's rasp still gets in; behind a mid or rear engine the silencer is right behind the bulkhead. A mic that rides on the car also hears the wind: air tearing off the pillars and mirrors sheds vortices at a frequency that climbs with speed and radiates as a dipole (pressure ~U³ in theory; the levels follow the 15 dB or so per doubling of speed measured in real cabins), over a lower buffeting from the separated flow. Gusts and crosswind move it and shift it between the ears, a door seal now and then locks into a whistle, and inside the car the glass takes the edge off. The road adds its own: concrete slab joints and viaduct expansion joints thump through tyres and suspension, front axle then rear.
5. **Knock and valve float**. The unburned end gas in every cylinder integrates its autoignition delay (Livengood-Wu with the Douaud-Eyzat correlation, so octane, compression, boost, intake temperature and spark timing all matter). When it autoignites, the rest of the charge burns at once and the chamber rings at its first acoustic modes (1.84·c/πB, about 5–7 kHz), which the block radiates as the ping. Past the spring limit the valves loft off the cams and bounce on their seats, letting gas back the wrong way: power collapses and the sound turns ragged.
6. **Starting**. The starter is a DC motor on the battery (permanent-magnet with planetary gears, series-wound direct drive, a motorcycle starter, or a race car's external starter), sized to the engine's compression and cold friction. It turns the flywheel through its pinion and a one-way clutch, and its armature inertia, current and speed come from the same crank dynamics: every compression stroke loads it and slows it, and past top centre the engine runs ahead until the next compression catches it up. What you hear follows from that: pinion teeth meeting the ring gear, the brushes and the planetary whine rising and falling with each stroke, the solenoid's clunk, the engine rocking on its mounts, then the catch and the armature running down after the pinion lets go. The ECU fires only once it has synced to the cam and crank. Before the crank, with the key at ON, the fuel pump primes the rail for a moment. Cold, the oil is thick and the starter turns the engine slower, the battery sags further, and below about 60 °C the first squirts of fuel wet the port walls instead of reaching the cylinders.
7. **Two-strokes**. A two-stroke cylinder fires every turn and has no valves: the piston uncovers ports in the cylinder wall. The sealed crankcase under it draws the charge in through a reed valve (petals that lift with the pressure across them and only let charge in) and squeezes it up the transfer ports; fuel evaporating off the carburettor cools it. Scavenging uses two zones: the fresh charge pushes the burned gas out ahead of it, so what leaves is hotter and more burned than the cylinder average, and some fresh charge always short-circuits into the pipe. The expansion chamber is a stepped waveguide (header, diffuser cone, belly, baffle cone, stinger, packed silencer): the diffuser sends a suction wave back that pulls charge through, and the baffle sends the blowdown pulse back as a plugging pulse that stuffs the escaped charge back in before the port closes. That only lines up over a band of revs, and the band moves with the exhaust gas temperature: the engine comes "on the pipe". A servo-driven power valve lowers the exhaust port roof below its rpm range, and you start it with a kick lever.
8. **Nitrous**. Hold NOS (or N) at full throttle: liquid nitrous oxide sprays into the intake through a solenoid gated by a throttle switch and an rpm window. In the charge it carries 1.57 times the oxygen of air by mass, so the kit adds fuel to match; it releases heat as it splits into nitrogen and oxygen; flashing from liquid to gas it chills the charge, which packs more of it into the cylinders; and the oxygen-rich mixture burns faster, so the controller pulls timing. Push it too far and the knock model hears it. With the throttle shut the same button opens the purge valve and vents the line in a white plume. The bottle drains as you use it; the workshop sets the shot and refills it.
9. **Mechanical noise**. The engine's own parts hitting each other, radiated by its structure, each worked out from the engine's dimensions rather than a recording or a fixed tone. Valves land on their seats at a velocity set by the cam's closing ramp (about 0.4 m/s at the rev limit, so the tick grows with rpm), with the mass of that engine's valves; solid lifters and bucket shims add a tick as they take up their lash on opening, and a hydraulic lifter left on an open valve bleeds down at rest and ticks after a start until the oil pressure refills it. Pistons slap across their clearance each time the connecting rod swings through vertical, as hard as the gas pressure and inertia at that instant throw them (Ungar and Ross), softened by the oil film, so slap follows load and vanishes at a warm idle; cold, an aluminium piston has shrunk more than its iron bore and the clearance is wider, so it slaps harder. The combustion pressure itself rings the block. Each blow excites the modes of the head and the block, whose pitch follows the engine's size and material (a long V12 block rings lower than a four, grey iron lower and duller than aluminium), and leaves through the thin covers and sump. On top come the timing drive (a chain meeting its sprocket one link at a time, a quieter belt, or a race engine's whining gears), injectors ticking the same at any speed, and the alternator's whine at its 36th shaft order, loudest just after a start while it recharges the battery. In gear, the gearbox whines at the tooth frequency of the gear that is carrying the load, from tooth counts worked out from each ratio: louder under torque, with sidebands from each shaft's runout, about four times the transmission error with straight-cut race gears, and silent in a direct top gear. Listen at the engine bay mic, or solo "mechanical" in the mixer.
10. **Induction**. The intake's sound is the pulsing of the air it draws, and it leaves by the way the air comes in. A production airbox is modelled as two pipes: an expansion chamber of four times the engine's displacement with the filter element's resistance across its middle, and a snorkel sized for 40 m/s at the rev limit. Together they are the Helmholtz resonator an intake designer tunes (50 to 60 Hz on a car): the lowest orders pass, everything above loses 10 to 15 dB, and bands come back where the chamber and the snorkel resonate. Ram air is the same box with a short, wide duct, which silences much less; an open filter is a pipe that honks at its quarter-wave modes. With individual throttles each runner ends at its own butterfly, so every bell mouth pulses with its own cylinder even at idle, and wide open the trumpets radiate the runners' resonances directly. On a boosted engine the throttle is behind the compressor, so the inlet hears the compressor's flow instead: the engine's own roar is nearly gone and the turbo's whistle, whoosh and flutter take its place. The throttle's jet hisses (jet noise at a Strouhal number of 0.2 on its width, with the power the control-valve noise standard gives it), least when the plate is choked at idle and the sound cannot get back upstream; the thin gaps of individual throttles add a faint edge-tone sizzle at light load. A turbo's blade-pass whistle has sidebands one and two shaft orders either side, from blades that are never quite alike. A Roots or twin-screw blower whines with the gas that leaks back through its rotor clearances, once per pocket: a Roots falls quiet off boost, a twin-screw (which compresses inside) whines at idle too, with a strong second harmonic. A centrifugal blower adds the whine of its straight-cut step-up gears.
11. **Temperature**. The engine has a temperature, and it is remembered. Seven lumped masses (the metal round the chambers, the head's coolant where the temperature sender sits, the rest of the coolant and block, the oil, the intake manifold, the fuel rail and the exhaust manifold) are heated by the fuel's heat (a third of it into the coolant at light load, a quarter at full load, after Heywood) and by friction, and cooled through a wax thermostat that opens between 88 and 92 °C, a radiator whose air comes from the road speed and an electric fan that cuts in at 100 °C, and the air round them. Their sizes come from the engine's displacement and block material, so a small engine warms up in about five minutes of driving, or twenty-odd at idle, and takes a couple of hours to cool most of the way back. What the temperature changes: oil viscosity (a 5W-30 oil's) and with it the friction, so a cold engine cranks slower, needs more air and fuel to idle and makes less power; the ECU's fast idle; piston clearance and so the slap; a charge that warms less on cold ports, burning slower; fuel reaching a cold cylinder partly as liquid, so the burn varies more from cycle to cycle; and, after a hot stop, a heat soak: the exhaust manifold keeps heating the head while the pump stands still, and the fuel rail, no longer washed by fuel, heats until its light ends boil, so a hot restart cranks a little longer and idles unevenly until the pump's pressure collapses the vapour. When the engine stops, the simulation carries on: the exhaust ticks and pings as it cools (stick-slip at its joints and heat shields, slower as the pipe cools) and the fan may run on to clear the heat. Each engine's temperatures are saved with the time; when it comes back they have cooled by the time it was away, towards the day's air (see Weather). The coolant gauge sits in the bottom of the tachometer (blue while cold, FAN while the fan runs), and the workshop or H makes the engine cold through or fully warm.
12. **Gearbox and clutch**. The gearbox is automatic (it shifts and works its own clutch), paddles (you shift, it works the clutch) or manual (Workshop → Gearbox; it stays the same from engine to engine). With the manual box the clutch is yours: hold Shift, press the left pedal, or pull the left stick back. Its grip follows the pedal through free play at the top, a steep rise as the cushion springs between the facings load, and a bite point near the middle of the travel; nothing slips it for you. Let it out at idle and the car's weight drags the engine down through the same torque balance that drives it: it stalls, and START (with the clutch down, as a car's clutch switch requires in gear) brings it back. Each gear is locked to its shaft by a sleeve sliding over the gear's dog teeth, after a synchroniser's cone has matched their speeds. Under load the dogs hold the sleeve (their faces are cut back so torque pulls them together), so without the clutch a gear comes out only as the load passes through zero. The synchroniser is sized to swing the clutch disc and input shaft from one gear's speed to the next in about a quarter of a second; held against the whole engine it cannot, its blocker gives way, and the sleeve hammers over the dog teeth: a grind, one blow per tooth passing, at a pitch set by the speed difference, ringing the gearbox casing's modes. Match the revs (ease off for an upshift, blip for a downshift) and a gear goes in without the clutch. With the clutch down the input shaft spins on its own, so a downshift at speed can still throw the engine past its limit when the clutch comes back up.
13. **Weather**. Dry, damp or rain (Settings, the top of the Scenes menu, or R; it stays the same from engine to engine). Each day has its air: dry is 25 °C at 1013 hPa, the standard day power is quoted at; damp is 15 °C and nearly saturated; rain 12 °C, near saturation, with the lower pressure that brings it. The cylinders draw the day's air (the compressors and intercoolers work with it too), so cool air packs in more charge, while the water vapour and the lower pressure take a little oxygen away (in proportion to the dry air's pressure, as the standard power correction does): a naturally aspirated V8 makes about 2% more power in the rain. Damp air also knocks less: the cooler charge and the water in it each delay the end gas's autoignition (the water is worth about 0.28 octane numbers per gram per kilogram of air), so the knock-limited spark moves about three degrees earlier. The engine warms up and cools down in the same air. A wet road grips less: the tyres' peak friction falls to about 0.7 of the dry road's, the grip is used up at a smaller slip, and once the tyres slide their friction falls away faster as the water has less time to be squeezed out (the PIARC friction index); traction control lets the wheels slip less, and launch control holds the engine lower. The tyres throw the water off as spray, a hiss above 1 kHz that grows steeply with speed (and with a spinning wheel), at the level measured for wet roads, and a wet tyre hardly squeals. In the cockpit, rain drums on the roof: drops of every size (more large ones the harder it rains) land as a random stream, each hitting with the force of its momentum, heard both from the panel's near field round each drop and from the roof ringing in its modes. Outside, the wet road reflects the sound back more strongly and keeps its highs.
14. **Places and the final mix**. Each place is a box of real surfaces round the car: a 10 by 15 m workshop garage with block walls and a plasterboard ceiling, a two-lane road tunnel, a canyon between rock faces 40 m apart, a concrete noise wall one lane over, the underside of a bridge deck, and the open road with a building's facade 30 m away (Anechoic has no reflections but the road's). The early reflections are image sources: every path off the walls, floor and ceiling, with its delay, its spreading and each surface's absorption per octave band, and the air's absorption over the extra distance (ISO 9613-1). After the mixing time a reverberant tail decays at the place's reverberation time by Eyring's formula (the garage rings for 1 to 1.9 s, the tunnel for up to 7 s in the bass), and its level against the direct sound follows how far the mic is from the tail pipe against the room's critical distance: in the garage the rear mic (4.4 m away, where the critical distance is about 1.3 m) hears mostly the room, the exhaust mic mostly the car. Every engine is trimmed to the same loudness (ITU-R BS.1770, the loudness meters use) at full load near its rev limit, and the master stage after the reverb brings full load to -16 LUFS, the level recommended for streamed audio. It leaves the contrast between idle and full load as the physics makes it down to 18 LU, lifts deeper idles by up to 10 dB so a quiet engine is still heard on a phone, eases a free rev into the limiter's bangs by half of what it overshoots full load, and a look-ahead limiter holds the true peaks (between the samples, measured oversampled) at -1 dBTP.
15. **Everything else is also simulated**: an ECU (idle control, fuel cut on overrun, rev limiter, spark map with knock control, launch control, traction control, two-stage cam switching, anti-lag), turbochargers (a compressor map with surge, a turbine housing size that sets where each turbo wakes up, a wastegate under closed-loop boost control, a vacuum-referenced blow-off valve or compressor flutter: with no valve the trapped boost blows back out through the spinning wheel in pulses, each reversal ringing the inlet duct like a tube closed at the wheel and open at the filter, so every pulse gets the hollow "tu" of real flutter, fading as the slowing wheel stalls only mildly; a blade whistle for each turbo that wavers with each exhaust pulse (a twin's pair beats slightly against itself) and a whoosh loudest near surge; screamer pipe; sequential stages with their own shafts and valves), twin-screw, Roots and centrifugal superchargers, afterfire in the exhaust, a drivetrain, tyres and a dyno.

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
| Two-Stroke V12 | 1.5 L concept: twelve 125 cc race cylinders firing every 30°, a reed valve, power valve and expansion chamber each |
| Sequential Six | 3.0 L inline-6 as it left the factory: one turbo low down, both above 4,000 rpm |
| Group A Six | 2.6 L short-stroke inline-6, parallel twin turbos, six throttles, 8,000 rpm, all-wheel drive |
| Takumi V6 | 3.8 L 60° V6, a turbo per bank, dual-clutch all-wheel-drive coupe |
| Touge Four | 1.6 L 20-valve inline-4 with four throttles in a 950 kg rear-drive coupe |
| Twin-Turbo Rotor | Side-ported two-rotor Wankel with sequential twin turbos |

The **Workshop** changes hardware and rebuilds the model live: silencer, headers (n-into-1, tri-Y, 4-2-1, cast log, or 180° "bundle of snakes" for cross-plane V8s), X/H-pipe or true duals, cats, resonators, rear or side exits, header lengths, air intake (airbox, ram air, open filter), individual throttle bodies, cams, valve springs, flywheel, turbo or supercharger swaps (twin-screw, Roots, centrifugal), boost, blower pulley, blow-off valve, screamer pipe, anti-lag, nitrous shot and refills, the engine's temperature (cold through or fully warm), rev limit, limiter type, overrun pops, (on the two-stroke) the rpm its expansion chamber is tuned for and the power valve, ignition timing, fuel octane, knock sensor, launch control, traction control and gearbox. It also holds the **mixer** (exhaust pipes, intake, mechanical, road; each can be soloed) and the **A/B compare** slot (factory spec, a stored setup or another engine; hold A/B or B to hear it).

## Tuning maps

**Tuning maps** (in the workshop, or M) opens the ECU's tables, each change heard at once:

- **Ignition**: degrees of advance added to the factory spark map, as a grid of rpm against manifold pressure (kPa, up to the boost the engine can make). Drag across cells to select a block and nudge it. More advance makes more torque until the end gas knocks; cells where the engine knocked get an orange mark.
- **Fuel**: the full-load air-fuel ratio over rpm (light load still leans out to 14.7), drawn with a finger or the mouse. The mixture is judged against the factory's: richer burns a little faster up to about lambda 0.9 and makes a little more torque there, and keeps the end gas and the exhaust cooler so it knocks later; toward 14.7 the flame runs hotter and pings sooner, and leaner the power falls away.
- **Boost** (turbo engines): the boost target over rpm for the wastegate controller, and the share of it each gear may use. The workshop's boost slider moves the whole curve.

A live cursor shows which cells the engine is reading, next to its spark advance, mixture, knock retard, exhaust temperature and torque. **Dyno hold** puts the engine on the dyno at the selected column's rpm at a throttle you set, so you can sit in any cell and tune it, as on a real load-bearing dyno. Maps are kept per engine until the workshop's Factory button; a map left as it was opened changes nothing at all.

## Engine builder

**Build** opens a workbench for designing a four-stroke or rotary engine from scratch: inline, vee, flat or rotary (1 to 16 cylinders, 2 to 4 rotors), bank angle, bore, stroke, rod length, compression, crankshaft, valvetrain, cams, a second cam profile, induction, intake runners, headers, exhaust, ECU and the car it sits in.

Firing orders are derived, not looked up: every cylinder's top dead centre comes from the crank-pin angles and the bank angle, and the builder enumerates every order that crank can produce and offers the most distinctive ones, from perfectly even to twin-pulse and big-bang. It finds the split-pin offset that makes an odd vee fire evenly. A 65° V12 comes out at 65/55°, a 90° V6 with shared pins at 90/150°, a 45° twin at 405/315°.

Every change is heard immediately (the build hot-swaps into the running engine), and a virtual dyno in a Web Worker runs the same physics faster than real time to draw the torque and power curves, report knock and valve float, and calibrate loudness. Builds are saved to **My garage** in the browser.

## 3D engine

The **3D** tab shows the engine itself: crankshaft, rods, pistons and valves (ports on the two-stroke, rotors orbiting their housings on the Wankel), moving with the simulation and lit by the burn in each cylinder. Every piston follows its own crank angle in the simulation, so the crank throws, split pins and bank angles come from the same firing data as the sound; Slow-mo works here too. Drag to turn it, pinch or scroll to zoom, double-click to reset.

three.js (MIT, `js/vendor/three-LICENSE.txt`) is vendored as a tree-shaken bundle, `js/vendor/three.min.js`, loaded only when the tab first opens. `tools/three-entry.js` lists what it exports; to rebuild it, install `three` and `esbuild` and run `npx esbuild tools/three-entry.js --bundle --format=esm --minify --target=es2019 --legal-comments=eof --outfile=js/vendor/three.min.js`.

## Scenes

The weather (dry, damp, rain) sits on top of the Scenes menu: every scene runs in it, and so does free driving.

- **Fly-by**: roadside mic, full throttle past it, with Doppler.
- **Tunnel run**: cruise to a 320 m tunnel, drop a gear and floor it through; the reverb crossfades at the portals.
- **Quarter mile**: staged on the launch limiter, a sportsman Christmas tree, GO on green (reaction time counts), and a time slip with 60', 330', 1/8, 1000' and 1/4 mile times and trap speeds.
- **Mountain road**: two kilometres of canyon road with seven corners and a tunnel; the car brakes, blips down the gears and powers out.
- **Autobahn**: down the slip road at a cruise, past the end of the speed limit, then flat out until the car will go no faster; then it lifts and coasts. Overpasses slap the sound back down, noise walls throw it back from one side, there is a tunnel, concrete stretches and viaducts thump under the tyres, and lorries in the right-hand lane go by in a gust of their own wake. A slip gives the top speed, the gear and rpm it came in, whether the air or the rev limiter held it, the 100–200, 200–250 km/h (and so on) times and the distance it took, with the best for each engine.

## Follow my car

**Follow my car** (Scenes, or 8) lets your own car drive the engine you picked, with the sound coming through the car like music (wired CarPlay has the least delay; Bluetooth audio adds about a quarter of a second). Choose where the car's data comes from:

- **OBD adapter**: a Bluetooth LE OBD-II adapter in the diagnostic port (an OBDLink CX, or a BLE ELM327 clone). The page speaks ELM327 over Web Bluetooth: it finds the car's protocol, learns which readings it reports, and asks for revs plus the pedal (or engine load) about a dozen times a second, two readings per request where the adapter allows, with road speed and boost in between. The simulated engine is held at the car's revs by a motoring dyno, so it follows on overrun too, and the car's rev range is stretched onto the engine's (a diesel's 800–4,800 rpm becomes a V12's idle to red line; or one to one). It starts and stops with the car. Web Bluetooth is in Chrome on Android and computers; on iPhone, open the page in the Bluefy browser, since Safari has no Bluetooth.
- **GPS**: no adapter, plain Safari. GPS gives road speed about once a second; the motion sensors fill in between. The phone can sit in its holder at any angle: it learns which way is forward by matching what it senses to the GPS speed changes over a few pulls away and stops, and corrects its offset as it goes. The pedal is read from the acceleration the car needs beyond its drag, and the simulated car's own gearbox picks the revs.
- **Demo drive**: a 2.0 TDI hatchback's drive, played as an adapter would report it.

The page keeps the screen on while following. Everything runs on the phone; nothing is sent anywhere. The site needs HTTPS (GitHub Pages is fine): browsers only give location, motion and Bluetooth to secure pages. `node tools/test-car.mjs` checks the ELM327 parser, a whole session against a pretend adapter (`tools/fake-obd.js`, which also stands in for `navigator.bluetooth` in browser tests) and the GPS fusion.

## Controls

| | Keyboard | Touch / gamepad |
| --- | --- | --- |
| Start / stop | Enter | START button / A |
| Throttle | W or ↑ (A = part throttle), mouse wheel = hand throttle | right pedal / RT |
| Brake | S or ↓ | left pedal (right of the clutch with the manual gearbox) / LT |
| Clutch (manual gearbox) | hold Shift | CLUTCH pedal / left stick back |
| Blip | Space | BLIP / X |
| Shift | Q / E or ← / → | − / + / LB, RB |
| Launch control | hold L | LAUNCH / B |
| Nitrous (purges with the throttle shut) | hold N | NOS / R3 |
| Rev, Drive | 1, 2 | mode switch |
| Fly-by, tunnel, quarter mile, mountain, autobahn | 3, 4, 5, 6, 7 | Scenes |
| Follow my car | 8 | Scenes |
| A/B compare | hold B | A/B chip, Workshop |
| Dyno run | D | DYNO tab |
| Mic / place | C / V | Y (mic) |
| Engine cold through / fully warm | H | Workshop |
| Weather: dry, damp, rain | R | Settings, Scenes menu |
| Garage / workshop / tuning maps | G / T / M | top bar, Workshop |

## iOS and Android apps

The same code builds as native apps through [Capacitor](https://capacitorjs.com) 8, for installing on your own devices (they are not published to the stores). The native projects live in `ios/` and `android/`; the app id is `com.iampaviic.firingorder`.

```sh
npm install
npm run sync        # copy the web app into www/ and both native projects
npm run android     # open Android Studio (or: cd android && ./gradlew assembleDebug)
npm run ios         # open Xcode (macOS only)
```

The app needs no network: fonts are bundled and everything is computed on the phone. A small native plugin, `EngineAudio` (Swift and Java, in each app target), sets up the audio session so the engine plays with the iPhone's silent switch on (or alongside other apps' music, as a setting), pauses for calls and when headphones are unplugged, and keeps the screen on while the engine runs. Settings, builds and best times are kept in native storage (Capacitor Preferences) instead of web view storage.

Every push to `main` or a `claude/**` branch runs `.github/workflows/app.yml`: it builds an Android debug APK (downloadable from the run) and compiles the iOS app for the simulator. Icon and launch-screen sources are in `assets/`; regenerate the native sizes with `npx capacitor-assets generate --ios --android`.

## On phones

In portrait the tach and figures sit on top and one lab panel shows below: the tabs switch between the pipe schematic (Engine) and the instruments. The pedals sit at the thumbs with modes, START, shifting and the LAUNCH / TC / BLIP / A/B chips between them. Scenes get their own strip above the deck. In landscape the pedals take the sides and the controls float in a pill at the bottom. With the manual gearbox a clutch pedal takes the left thumb and the brake moves over beside the throttle, as a right foot moves between them; the throttle pedal does the blipping, so the BLIP chip steps aside. The workshop and the builder are full-screen with a Hold to rev button, and the builder's spec sheet is its own tab, summed up in one line above the steps.

The phone also lets you feel the car (Settings → Haptics: off, low or full). A shift jolts in proportion to the change in drive force, so a lazy change is a click and a full-throttle one a kick; the starter's pinion engages, the engine catches with a kick, a stall lurches, a grinding gear buzzes as long as it grinds and a refused one knocks through the lever; leaving the line kicks as hard as the launch; afterfire bangs in proportion to their pressure in the pipe; knock ticks; the limiter stutters and the launch limiter bounces the car. Standing still, the engine shakes at its firing frequency as much as its mounts let through: a car rocks as it cranks and barely trembles at idle, a single or a twin shakes the whole bike. The apps use the system's haptics (on iOS they follow the System Haptics switch, on Android the touch feedback setting); in a browser it is the Vibration API, which Chrome on Android has and iPhone browsers do not. Until you choose, haptics are off if the system asks for reduced motion, and with reduced motion the idle shake stays still.

## Performance

A V12 needs about 12–15% of one desktop core, the W16 about 20%. On slower phones the simulator detects the load and runs the physics at half rate, upsampled. You can force this under Workshop → Physics rate.

## Development tools

Node 18+ runs the real worklet code offline:

```sh
node tools/render.mjs v8-ls rev out.wav        # scenarios: rev idle dyno drive boost flyby autobahn (--weather rain)
python3 tools/analyze.py out.wav out.png       # spectrogram, waveform
python3 tools/psd.py psd.png out.wav:6:7:6500:label   # spectrum with engine-order markers
node tools/batch.mjs                           # every preset: idle, torque, power, stability (--weather rain)
node tools/loudness.mjs                        # loudness trims (BS.1770, the top of a full-load sweep)
node tools/mix.mjs v8-ls --env garage          # through the app's real Web Audio graph in Chromium: loudness, true peak
node tools/knockcal.mjs                        # per-engine knock calibration
node tools/hold.mjs v12-65 6000 1 '' out.wav   # fixed rpm/throttle on an infinite-inertia dyno
node tools/check-bundle.mjs                    # the worklet's single-script fallback matches its modules
```

Layout: `js/audio/engine-worklet.js` is the worklet's entry point and `js/audio/worklet/` holds the physics, one module per part: the pipe network (`net.js`), the engine and its sample loop (`engine-sim.js`, with its subsystems in `sim/`), the listener and camera geometry, the scene scripts and the processor. `js/engine/compile.js` turns an engine spec into a pipe network and valve tables, `js/engine/presets.js` holds the engine library, `js/engine/builder.js` turns builder designs into specs, `js/engine/maps.js` lays out the tuning maps, `js/car/*` reads a real car (ELM327 over Web Bluetooth, GPS and motion, the demo drive), `js/engine/analyze-worker.js` is the virtual dyno, `js/main.js` and `js/app/*` are the app itself (state, engine loading, modes, telemetry, wiring), and `js/ui/*` holds the tach, pressure-wave schematic, scope, garage, workshop, map editor, builder and scenes. The modules load straight from source with no build step; a browser that refuses the worklet's URL gets the same modules joined into one script (`js/audio/worklet-bundle.js`).
