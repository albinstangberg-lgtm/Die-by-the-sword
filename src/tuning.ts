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
  /**
   * How hard the forearm can turn the weapon in the hand, N·m -- the grip's
   * twist. It keeps the edge where it was asked while the elbow goes where
   * the body lets it. Weak, and a blow on the flat knocks the edge off line;
   * a heavy head off its haft's line takes more of it to turn.
   */
  twistTorque: number;
  /**
   * How hard the wrist can bend the weapon off the forearm's line, N·m. It
   * points the blade where the aim asked when the body has moved the elbow.
   * Far stronger than a real wrist, on purpose: the arm's drive only holds
   * steady with the weapon moving as one with the forearm across its length,
   * as it did when it was welded on, and below about 200 the resting arm
   * shakes. Its range starts above that.
   */
  wristTorque: number;

  // --- input mapping ---
  sensitivity: number; // radians of arm sweep per pixel of mouse travel
  invertY: boolean;
  rollSensitivity: number; // radians of edge roll per pixel, held right button
  reachRate: number;   // metres per wheel notch
  /**
   * The fastest the ghost hand may sweep round the shoulder, rad/s, and how
   * hard it may get going, rad/s^2.
   *
   * Anything slower than this reaches the arm untouched, with no lag at all;
   * only a flick is spread over the handful of steps an arm would need. That
   * matters because a ghost teleported two radians away is chased along the
   * straight chord, which runs inside the arm's reach and folds the elbow
   * shut. Well above what the AI's hand does, and above what a real arm can.
   */
  flickSpeed: number;
  flickAccel: number;

  // --- body: how the trunk is carried around the arm (see posture.ts) ---
  /**
   * How much the chest turns ahead of the swing and the shoulder girdle
   * slides to make room for it. 0 is the old rigid block, which the arm
   * crosses by going straight through; 1 is a body that gets out of its way.
   */
  torsoLead: number;
  /**
   * Lean, side bend, shrug and head-tracking, as a multiple of the default.
   * The part of the posture that is juice rather than clearance: 0 turns it
   * off without touching the lead.
   */
  secondaryMotion: number;
  /**
   * The hips' share of a turn, 0..1. The spine takes the rest, fast; the hips
   * take theirs slowly, and the feet stay planted until they cannot.
   */
  stanceShare: number;
  /**
   * How far off its own chest and hips the sword arm's target pose is kept,
   * metres at human scale. A soft repulsion on the real limb starts at the
   * body's surface, inside this. 0 turns both off: the arm has no collision
   * with its own body, and without these it goes straight through.
   */
  clearance: number;

  // --- masses (kg) ---
  bladeMass: number;
  armMass: number;

  // --- world ---
  gravity: number;     // m/s^2, negative

  // --- impact: what a blow does to a body that has to stay up (see balance.ts) ---
  /**
   * How much of the swinging arm's own mass lands with the weapon, 0..1.
   * A driven arm is stiffened to swing and arrives as one piece with what it
   * holds, the way a boxer's half-kilo fist lands like three. At 0 only the
   * weapon arrives, and nothing knocks anybody over -- which is the truth
   * about a sword on its own.
   */
  armBehindBlow: number;
  /**
   * How big a shove any body can step out of, as a Froude number: speed over
   * the square root of gravity times leg length. The same for every creature;
   * what differs is how much each one weighs.
   */
  balance: number;

  // --- locomotion ---
  moveSpeed: number;   // m/s
  /**
   * Seconds the feet take to get a body from standing to walking pace, and
   * from walking pace to a stop. At 0 a step is at full pace the moment the
   * key goes down and stops dead when it comes up, which reads as a figure
   * slid about rather than a body shifting its weight. Everyone's, yours and
   * theirs.
   */
  stepEase: number;
  turnSpeed: number;   // rad/s
  /**
   * How high a standing jump clears, metres. The take-off speed is derived
   * from this and gravity, so lowering gravity floats the jump rather than
   * making it higher -- which is what you want from a knob called "gravity".
   */
  jumpHeight: number;
  /**
   * Authority over your own horizontal velocity while airborne, 0..1 per step.
   * At 1 you steer in the air exactly as you do on the ground and a jump is
   * free; at 0 you are committed to the line you took off along. Low, because
   * a jump you cannot take back is a jump worth timing.
   */
  airControl: number;

  // --- debug view ---
  showGhost: boolean;   // draw the kinematic target the mouse actually controls (yours only)
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
  twistTorque: 6,
  wristTorque: 500,

  sensitivity: 0.0052,
  invertY: false,
  rollSensitivity: 0.0075,
  reachRate: 0.035,
  flickSpeed: 18,
  flickAccel: 320,

  torsoLead: 1,
  secondaryMotion: 1,
  stanceShare: 0.4,
  clearance: 0.015,

  bladeMass: 1.4,
  armMass: 4.2,

  gravity: -9.81,

  armBehindBlow: 1,
  balance: 0.4,

  moveSpeed: 3.1,
  stepEase: 0.1,
  turnSpeed: 2.5,
  jumpHeight: 0.62,
  airControl: 0.055,

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
  { group: "Arm — angular drive", key: "twistTorque", label: "grip twist  (N·m)", min: 0.5, max: 30, step: 0.5,
    hint: "How hard the forearm turns the weapon in the hand to keep the edge where you asked. Weak, and a blow on the flat knocks the edge off line." },
  { group: "Arm — angular drive", key: "wristTorque", label: "wrist  (N·m)", min: 250, max: 1000, step: 10,
    hint: "How hard the wrist bends the weapon back onto the line you aimed along when the body has had to move your elbow. It has to be this stiff: much below the bottom of this range the resting arm starts to shake." },

  { group: "Input", key: "sensitivity", label: "sensitivity", min: 0.0005, max: 0.02, step: 0.0001 },
  { group: "Input", key: "rollSensitivity", label: "roll sensitivity", min: 0.0005, max: 0.03, step: 0.0001,
    hint: "Radians of edge roll per pixel while the right button is held." },
  { group: "Input", key: "reachRate", label: "reach / notch  (m)", min: 0.005, max: 0.12, step: 0.005 },
  { group: "Input", key: "flickSpeed", label: "flick speed cap  (rad/s)", min: 4, max: 80, step: 1,
    hint: "The fastest the ghost may sweep round the shoulder. Slower input passes through untouched; a flick is spread over a few steps so the arm swings the arc instead of folding across the chord." },
  { group: "Input", key: "flickAccel", label: "flick accel cap  (rad/s²)", min: 40, max: 3000, step: 10 },
  { group: "Input", key: "invertY", label: "invert Y" },

  { group: "Body", key: "torsoLead", label: "torso lead", min: 0, max: 1.5, step: 0.05,
    hint: "How far the chest turns ahead of a swing and the shoulder slides round the ribs. At 0 the trunk is a rigid block and a cross-body cut goes through it." },
  { group: "Body", key: "secondaryMotion", label: "secondary motion", min: 0, max: 2, step: 0.05,
    hint: "Lean into chops, bend with sweeps, shrug under strain, head following the blade -- and the hips and chest walking with the legs, and breathing." },
  { group: "Body", key: "stanceShare", label: "hips' share of a turn", min: 0, max: 0.8, step: 0.05 },
  { group: "Body", key: "clearance", label: "clearance from body  (m)", min: 0, max: 0.08, step: 0.005,
    hint: "How far the arm keeps off its own chest and hips. The arm cannot collide with its own body, so at 0 a cross-body cut goes straight through it." },

  { group: "Mass & world", key: "bladeMass", label: "blade mass  (kg)", min: 0.2, max: 8, step: 0.1 },
  { group: "Mass & world", key: "armMass", label: "arm mass  (kg)", min: 0.5, max: 20, step: 0.1 },
  { group: "Mass & world", key: "gravity", label: "gravity  (m/s²)", min: -25, max: 0, step: 0.1 },

  { group: "Impact", key: "armBehindBlow", label: "arm behind the blow", min: 0, max: 1, step: 0.05,
    hint: "How much of the swinging arm's weight lands with the weapon. At 0 only the steel arrives, and a sword knocks nobody over. Applies to every blow, yours and theirs." },
  { group: "Impact", key: "balance", label: "balance  (Froude no.)", min: 0.15, max: 1, step: 0.01,
    hint: "How big a shove a body can step out of: speed over √(gravity × leg length). Lower, and everything goes over more easily — but the orc still takes five times the goblin, because it weighs five times as much." },

  { group: "Movement", key: "moveSpeed", label: "move speed  (m/s)", min: 0, max: 8, step: 0.1 },
  { group: "Movement", key: "stepEase", label: "step ease  (s)", min: 0, max: 0.4, step: 0.01,
    hint: "How long the feet take to get up to walking pace and to stop. At 0 every step starts and stops dead. Everyone's, the opponents' included." },
  { group: "Movement", key: "turnSpeed", label: "turn speed  (rad/s)", min: 0, max: 6, step: 0.1 },
  { group: "Movement", key: "jumpHeight", label: "jump height  (m)", min: 0, max: 2, step: 0.02 },
  { group: "Movement", key: "airControl", label: "air control", min: 0, max: 1, step: 0.005,
    hint: "How much of your ground steering you keep in the air. Near 0 a jump commits you to the line you left on." },

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
