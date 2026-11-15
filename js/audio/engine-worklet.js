// FIRING ORDER — physically modelled engine sound.
//
// Everything audible here comes out of a small physics simulation that runs
// once per audio sample:
//
//   * each cylinder is a 0-D thermodynamic volume (mass + internal energy)
//     following the slider-crank volume curve, with Wiebe heat release,
//     cycle-to-cycle combustion variation and compressible valve flow;
//   * intake runners and every exhaust pipe are bidirectional digital
//     waveguides (travelling pressure waves) joined by lossless scattering
//     junctions, so headers, collectors, X-pipes, mufflers and tail pipes
//     shape the pulses the way real pipes do;
//   * the tail pipes radiate: far-field pressure = d/dt(mass outflow) / 4πr;
//   * crank speed is integrated from the gas torque, so idle lope, limiter
//     bounce and rev-matching all emerge from the model;
//   * a listener stage renders each source with distance delay (Doppler),
//     ground reflection, air absorption and head shadowing.
//
// This file is the worklet's entry point. The code is in worklet/:
//
//   constants.js   physical constants and shared enums
//   dsp.js         random stream, fast math, map lookups, resonator banks
//   net.js         Net, the waveguide pipe network
//   listener.js    Listener (per-source delay lines) and EngineSim.listen()
//   engine-sim.js  EngineSim: all of its state, and render(), the sample loop
//   sim/*.js       EngineSim's methods, one file per subsystem
//   camera.js      mic and body geometry -> listener taps
//   scenes.js      the scripted drives
//   processor.js   EngineProcessor: messages, hot swap, eco mode, telemetry
//   loudness.js    BS.1770 loudness and true peak, and the levels engines are trimmed to
//   master.js      MasterProcessor: the leveller and true-peak limiter after the reverbs

import { EngineProcessor } from './worklet/processor.js';
import { MasterProcessor } from './worklet/master.js';

registerProcessor('engine-processor', EngineProcessor);
registerProcessor('master-processor', MasterProcessor);
