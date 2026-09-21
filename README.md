# Die by the Sword — browser prototype

A physics-driven melee prototype in the spirit of Treyarch's 1998 *Die by the
Sword*: the sword arm is a simulated limb, not a set of attack animations. You
drag the mouse, the arm follows, and the blade's damage — and its bounce, its
lag, its refusal to go where you asked — comes out of the physics.

**This is stage 3 of 5.** Stage 2 answered one question — *does swinging a sword
at a wall feel good?* — and stage 3 gives that swing consequences: a practice
dummy that comes apart when you cut it properly, and refuses to when you don't.
There is still no opponent; nothing here hits back.

```
npm install
npm run dev      # http://localhost:5173
npm run smoke    # headless physics harness — 14 checks, no browser needed
npm run build    # production bundle
```

## Controls

| | |
|---|---|
| **mouse** | the sword arm |
| **right-drag** | hold the right button, move left/right to roll the cutting edge |
| **wheel** | reach — extend and retract |
| **W A S D** | move |
| **Q / E** | turn (arrow keys also work) |
| **Tab** | tuning panel |
| **R** | reset |
| **Esc** | release the mouse |

Turning is on the keyboard because the mouse is the *arm*, not the camera. That
was true of the original and it is the first thing to relearn.

Right-drag is modal: while the button is down, horizontal mouse travel rolls the
edge instead of sweeping the arm sideways. Vertical travel still aims, so you
never lose height control while setting your edge. The HUD says `ROLLING` while
it's live.

## How the mechanic works

Three pieces, in order of importance.

**1. A kinematic ghost hand.** Mouse deltas accumulate into a target point on a
sphere in front of the shoulder. It is pure intent: no collision, no mass, it
goes exactly where you point. Turn on *show ghost hand* in the panel and it is
the cyan wireframe.

**2. A physical arm.** Upper arm on a spherical shoulder, forearm on a hinged
elbow, blade welded to the hand. Dynamic bodies with real mass, subject to
gravity, inertia and collision.

**3. A force-limited PD controller** dragging the real hand toward the ghost:

```
F = kp·(ghost − hand) − kd·(hand velocity),   clamped to maxForce
```

**The clamp is the entire game.** With the blade free the motor easily wins and
the arm tracks the mouse to within about 5mm — responsive. With the blade buried
in a pillar the motor saturates, the real hand falls behind the ghost, and you
feel the sword's weight and the wall's refusal. The `tracking error` readout is
that gap, and watching it over a swing tells you more about the feel than any
other number.

Nothing is animated. The bounce, the trailing tip, the bad swings that skid off
stone are all consequences of one saturating controller.

### Why not inverse kinematics?

IK is used here, but only to compute the *target pose* — never to place the arm.
The physical limb still has to get there under a clamped force and frequently
cannot. That failure is the mechanic. An IK-driven arm would put the hand on
target every frame and the blade would pass through the wall.

### Damage

Hits are described by three numbers, not a hitbox test:

```
damage = (closing speed − 2 m/s) × edge alignment² × sweet spot
```

- **closing speed** — a slow blade pushes, it does not cut. Below the threshold
  a hit is a shove no matter how well aimed.
- **edge alignment** — *squared*, so it is brutal. Forty-five degrees off keeps
  you 28% of your damage; ninety degrees and you have slapped someone with a
  steel plank.
- **sweet spot** — the hilt does nothing and the tip has speed but no mass
  behind it. The percussion point, about two thirds down, does everything.

There is no light attack or heavy attack. The only way to raise the number is to
swing faster, with the edge leading, and connect on the right part of the blade
— which is to say, to actually cut properly.

### The dummy

A canvas figure hangs from a gallows, pinned at the chest so it swings and spins
when struck but cannot be knocked out of reach. Every limb is a rigid body
jointed to its parent, and every joint holds an integrity value that good cuts
deplete. At zero the joint is removed from the world and the limb — with
everything hanging off it — becomes debris, carrying the blade's momentum with
it.

Severing happens at joints rather than through geometry. Real mesh cutting is an
order of magnitude more work and reads the same at speed, and the player-facing
rule stays learnable: **hit a forearm and you take the hand; hit the upper arm
and you take the whole arm.** Limbs darken toward the cut colour as their joint
gives way, and the panel on the right tracks every joint still holding.

Joints are tuned against the damage curve, so a wrist goes in one or two good
strikes and cutting a body in half at the waist takes real commitment.

## Four things the physics taught us

Findings from building this, kept because each one cost real debugging time and
each is a trap anyone rebuilding this would fall into.

**The two drives must be kinematically consistent.** The first version commanded
the hand to a position *and* the blade to lie along the shoulder→hand line.
Those agree only when the elbow is straight; at any bent reach they deadlocked
and left a permanent ~9cm error that no amount of tuning could remove. The fix
is to solve the elbow first and take the blade's target direction from
elbow→hand, so both drives describe the same pose.

**Elbow swivel and edge roll are the same degree of freedom.** With a hinge
elbow and no forearm twist, rotating the cutting edge *is* swinging the elbow
around the shoulder→hand line. Treating them as two controls had them fighting
over one joint, worth 45° of standing orientation error. A right-drag rotates
the arm's plane, and the edge comes with it.

**Contact events arrive too late to measure a hit.** Rapier reports contacts
after `world.step()`, by which point the solver has already stopped the blade
dead against whatever it hit. Reading the blade's velocity there gave the speed
it *ended* at — a 24 m/s cut scored as a 0.1 m/s nudge and did no damage at all.
The blade's motion is now snapshotted before the step, and damage is computed
from how fast it was travelling as it arrived. A related trap: a blade resting
against a target emits contact events every frame at a fraction of a metre per
second, and a single global cooldown let that noise swallow the real strike a
few frames later. The cooldown is per-collider now, and resting contacts are
discarded rather than reported.

**A proportional controller cannot hold a weight without error.** Holding the
sword up costs a standing ~45N, and a P term only makes force from error, so the
blade sagged 5cm below wherever you pointed. Gravity is now fed forward per
body at its centre of mass, scaled by the *arm strength* knob. Inertia is
untouched, so the swing is exactly as heavy — it just no longer droops at rest.

## Tuning

Everything in the panel is live and saves to your browser. The four that matter:

| | |
|---|---|
| `max force` | The clamp. Drop it to 150N and the sword becomes too heavy to lift. |
| `arm strength` | How much of the limb's own weight the fighter holds up. At 0 the sword drags the arm down. |
| `max torque` | The angular budget. Keep it modest — a torque the swing can exhaust is what makes the blade trail. |
| `blade mass` | Inertia. Affects how hard the sword is to start and stop, not how hard it is to hold. |

Presets: **heavy** (a sword that fights you), **rigid** (a robot arm — useful as
a control), **noodle** (too weak to lift it). Try `rigid` for ten seconds to hear
what the mechanic sounds like when you take the clamp away.

## Deliberate behaviours

Some things look like bugs and are not:

- **You can plant the sword in the ground and get stuck.** Swing down hard, the
  tip grounds out, the arm props on it. Raise your hand and it frees. Emergent,
  correct, and very much in the spirit of the original.
- **The blade lags behind the ghost on a fast swing.** That's the torque budget
  running out. It's where the whip comes from.
- **Reach is capped short of full extension.** Near a straight arm the elbow has
  no leverage and the limb locks. An 8cm margin keeps it always able to bend.
- **The torso cannot be severed.** It is what the dummy hangs from, so there is
  no joint to cut it off at. Damage still registers; it just has nowhere to go.

## Structure

```
src/
  main.ts            wiring, camera
  tuning.ts          every constant that shapes the feel
  core/
    loop.ts          fixed 60Hz accumulator
    physics.ts       Rapier world
    renderer.ts      three.js scene
    interpolate.ts   render interpolation between physics states
  input/input.ts     pointer lock, accumulated deltas
  game/
    arm.ts           THE MECHANIC — read this one first
    fighter.ts       torso and locomotion
    arena.ts         a room built to be hit
    dummy.ts         the practice dummy, and how it comes apart
    damage.ts        the damage curve
    impacts.ts       contact events -> impact quality
    targets.ts       collider -> name registry
    trail.ts         the swept arc
  ui/                HUD and tuning panel
tools/smoke.ts       headless harness driving the real modules
```

`npm run smoke` runs the real `Arm`, `Fighter`, `Arena` and `Dummy` against
Rapier in Node — no WebGL, no browser, 25 checks in about two seconds. It
asserts the claim the design rests on: that the arm tracks the mouse closely
when free and *fails to* when blocked. If the second ever stops failing, the
mechanic is gone. It also drives a real scripted swing all the way through to a
severed limb, which is the only test that exercises the whole chain at once.

## Stack

TypeScript · Vite · three.js · [Rapier](https://rapier.rs) (Rust→WASM).

Physics is a fixed 60Hz accumulator with render interpolation — stiff PD drives
explode under a variable timestep. CCD is on for the blade and forearm; without
it a fast tip tunnels straight through the thin post.

## What's next

4. An opponent that swings back.
5. Arena, rounds, UI.
