/**
 * Every number that shapes how the arm feels, in one place.
 *
 * The four that matter most are `armKp`, `armKd`, `maxForce` and `maxTorque`.
 * The gap between where the mouse asks the hand to be and where the hand can
 * actually get -- the "tracking error" in the HUD -- is the whole mechanic.
 * Free blade: the gap is near zero and the sword feels responsive. Blade buried
 * in a wall: the motor saturates, the gap opens, and you feel the weight.
 */

export interface Tuning {
  // --- linear drive: pulls the hand toward the ghost hand ---
  armKp: number;      // N per metre of error
  armKd: number;      // N per m/s of hand velocity (damping)
  maxForce: number;   // N. THE clamp. Low = weak arm that loses to walls.
  /**
   * How much of the limb's own weight the fighter can simply hold up, 0..1.
   * At 1 the arm never sags; at 0 it carries the full dead weight of the
   * sword and droops several centimetres below where you point. Inertia is
   * untouched either way, so a swing feels exactly as heavy regardless --
   * this only decides whether holding a guard costs you.
   */
  gravityComp: number;

  // --- angular drive: rolls the blade toward its target orientation ---
  armKpRot: number;   // N.m per radian of error
  armKdRot: number;   // N.m per rad/s
  maxTorque: number;  // N.m. Keep well under maxForce so the blade trails.

  // --- input mapping ---
  sensitivity: number; // radians of arm sweep per pixel of mouse travel
  invertY: boolean;
  rollRate: number;    // rad/s, Q/E
  reachRate: number;   // metres per wheel notch

  // --- masses (kg) ---
  bladeMass: number;
  armMass: number;

  // --- world ---
  gravity: number;     // m/s^2, negative

  // --- locomotion ---
  moveSpeed: number;   // m/s
  turnSpeed: number;   // rad/s

  // --- debug view ---
  showGhost: boolean;   // draw the kinematic target the mouse actually controls
  showTrail: boolean;   // draw the blade's swept arc
  showSkeleton: boolean;// draw joint anchors
}

export const DEFAULTS: Tuning = {
  armKp: 900,
  armKd: 55,
  maxForce: 420,
  gravityComp: 0.85,

  armKpRot: 48,
  armKdRot: 5.0,
  maxTorque: 46,

  sensitivity: 0.0052,
  invertY: false,
  rollRate: 3.2,
  reachRate: 0.035,

  bladeMass: 1.4,
  armMass: 4.2,

  gravity: -9.81,

  moveSpeed: 3.1,
  turnSpeed: 2.5,

  showGhost: true,
  showTrail: true,
  showSkeleton: false,
};

/** Slider ranges for the debug panel. Order here is the order on screen. */
export interface Control {
  key: keyof Tuning;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  group: string;
  hint?: string;
}

export const CONTROLS: Control[] = [
  { group: "Arm — linear drive", key: "armKp", label: "stiffness  kp", min: 0, max: 3000, step: 10 },
  { group: "Arm — linear drive", key: "armKd", label: "damping  kd", min: 0, max: 200, step: 1 },
  { group: "Arm — linear drive", key: "maxForce", label: "max force  (N)", min: 0, max: 1500, step: 10,
    hint: "The clamp that makes walls win. Drop it to 150 and the sword becomes too heavy to lift." },
  { group: "Arm — linear drive", key: "gravityComp", label: "arm strength", min: 0, max: 1, step: 0.01,
    hint: "How much of the limb's own weight the arm holds up. At 0 the sword drags the arm down; inertia is unchanged either way." },

  { group: "Arm — angular drive", key: "armKpRot", label: "stiffness  kp", min: 0, max: 250, step: 1 },
  { group: "Arm — angular drive", key: "armKdRot", label: "damping  kd", min: 0, max: 20, step: 0.1 },
  { group: "Arm — angular drive", key: "maxTorque", label: "max torque  (N·m)", min: 0, max: 250, step: 1,
    hint: "Keep this modest — a torque budget the swing can exhaust is what makes the blade trail behind the hand instead of snapping to it." },

  { group: "Input", key: "sensitivity", label: "sensitivity", min: 0.0005, max: 0.02, step: 0.0001 },
  { group: "Input", key: "rollRate", label: "roll rate  (rad/s)", min: 0, max: 10, step: 0.1 },
  { group: "Input", key: "reachRate", label: "reach / notch  (m)", min: 0.005, max: 0.12, step: 0.005 },
  { group: "Input", key: "invertY", label: "invert Y" },

  { group: "Mass & world", key: "bladeMass", label: "blade mass  (kg)", min: 0.2, max: 8, step: 0.1 },
  { group: "Mass & world", key: "armMass", label: "arm mass  (kg)", min: 0.5, max: 20, step: 0.1 },
  { group: "Mass & world", key: "gravity", label: "gravity  (m/s²)", min: -25, max: 0, step: 0.1 },

  { group: "Movement", key: "moveSpeed", label: "move speed  (m/s)", min: 0, max: 8, step: 0.1 },
  { group: "Movement", key: "turnSpeed", label: "turn speed  (rad/s)", min: 0, max: 6, step: 0.1 },

  { group: "Debug view", key: "showGhost", label: "show ghost hand" },
  { group: "Debug view", key: "showTrail", label: "show blade arc" },
  { group: "Debug view", key: "showSkeleton", label: "show joints" },
];

/** Presets worth having a key for — they demonstrate what the clamp does. */
export const PRESETS: Record<string, Partial<Tuning>> = {
  default: DEFAULTS,
  heavy: { armKp: 620, armKd: 70, maxForce: 230, gravityComp: 0.55, armKpRot: 18, maxTorque: 22, bladeMass: 3.2 },
  rigid: { armKp: 2600, armKd: 160, maxForce: 1400, gravityComp: 1, armKpRot: 120, armKdRot: 12, maxTorque: 180 },
  noodle: { armKp: 260, armKd: 22, maxForce: 110, gravityComp: 0.2, armKpRot: 8, maxTorque: 9 },
};
