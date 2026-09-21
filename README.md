# Die by the Sword — browser prototype

A physics-driven melee prototype in the spirit of Treyarch's 1998 *Die by the
Sword*: the sword arm is a simulated limb, not a set of attack animations. You
drag the mouse, the arm follows, and the blade's damage — and its bounce, its
lag, its refusal to go where you asked — comes out of the physics.

**This is stage 2 of 5.** There is nothing to fight yet, and that is deliberate.
Stage 2 answers one question: *does swinging a sword at a wall feel good?* If it
doesn't, nothing built on top of it will.

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

### Impact quality

Hits are described by three numbers, not a hitbox test:

```
closing speed  — how fast the blade was going INTO the surface
edge alignment — |dot(edge direction, contact normal)|; 1 = edge-on, 0 = flat
contact point  — where along the blade; the hilt is a bad place to catch things
```

Swing hard with the edge leading and you get *clean cut*. Swing hard with the
blade turned ninety degrees and you get *flat of the blade* and a shower of
nothing. Stage 3 multiplies these together into damage; for now they print in the
bottom-left so you can feel the difference.

## Three things the physics taught us

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
    impacts.ts       contact events -> impact quality
    trail.ts         the swept arc
  ui/                HUD and tuning panel
tools/smoke.ts       headless harness driving the real modules
```

`npm run smoke` runs the real `Arm`, `Fighter` and `Arena` against Rapier in
Node — no WebGL, no browser. It asserts the claim the design rests on: that the
arm tracks the mouse closely when free and *fails to* when blocked. If the
second ever stops failing, the mechanic is gone.

## Stack

TypeScript · Vite · three.js · [Rapier](https://rapier.rs) (Rust→WASM).

Physics is a fixed 60Hz accumulator with render interpolation — stiff PD drives
explode under a variable timestep. CCD is on for the blade and forearm; without
it a fast tip tunnels straight through the thin post.

## What's next

3. Contact damage and a training dummy with severable limbs.
4. An opponent that swings back.
5. Arena, rounds, UI.
