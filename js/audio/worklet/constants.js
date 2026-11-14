// Physical constants and the enums shared by the pipe network, the engine
// simulation and the listener.

export const PI = Math.PI;
export const TAU = 2 * PI;
export const RAD2DEG = 180 / PI;
export const P_AMB = 101325;
export const T_AMB = 298;
export const R = 287;
export const GAM = 1.34;
export const GM1 = GAM - 1;
export const CV = R / GM1;
export const CP = GAM * CV;
export const LHV = 43.5e6;
export const AFR_ST = 14.7;
export const CHOKE = Math.sqrt(GAM / R) * Math.pow(2 / (GAM + 1), (GAM + 1) / (2 * GM1));
export const CHOKE_AIR = Math.sqrt(1.4 / R) * Math.pow(2 / 2.4, 2.4 / 0.8);
export const INV4PI = 1 / (4 * PI);
export const C_AIR = 343;
// Scales the Douaud-Eyzat ignition delay so factory calibrations sit just
// under the knock limit on their recommended fuel.
export const KNOCK_CAL = 0.35;
// Pa of chamber ringing -> Pa at 1 m radiated by the block.
export const KNOCK_RAD = 2.2e-5;
// Nitrous oxide: oxygen per kg relative to air (36.4% vs 23.1% by mass),
// heat released as it splits into nitrogen and oxygen (J/kg), heat it soaks
// up flashing from liquid to gas (J/kg), and flow per horsepower of shot.
export const NOS_O2 = 1.57;
export const NOS_DH = 1.86e6;
export const NOS_LAT = 2.5e5;
export const NOS_PER_HP = 3.5e-4;

export const NODE_JUNCTION = 0, NODE_PORT = 1, NODE_OPEN = 2, NODE_CLOSED = 3, NODE_RESISTOR = 4, NODE_PLENUM = 5;
export const DYN_TURBINE = 1, DYN_WASTEGATE = 2, DYN_VALVE = 3, DYN_STAGE = 4;

export const N_SRC = 7; // exL, exR, exC, intake, mech, chassis, wastegate dump
export const SRC_BUF = 1 << 17;
export const SRC_MASK = SRC_BUF - 1;
