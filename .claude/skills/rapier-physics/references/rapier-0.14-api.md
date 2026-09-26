# Rapier 0.14 as this game uses it

`@dimforge/rapier3d-compat` 0.14.0, checked against its own type definitions.
Every code block here type-checks against that version.

Contents:

1. [Where to look](#where-to-look)
2. [World and stepping](#world-and-stepping)
3. [Bodies and forces](#bodies-and-forces)
4. [Mass](#mass)
5. [Colliders](#colliders)
6. [Joints and motors](#joints-and-motors)
7. [Per-axis limits and motors on a ball joint](#per-axis-limits-and-motors-on-a-ball-joint)
8. [Contact events and manifolds](#contact-events-and-manifolds)
9. [Rays](#rays)
10. [Names examples get wrong](#names-examples-get-wrong)
11. [After 0.14](#after-014)

## Where to look

The types are in `node_modules/@dimforge/rapier3d-compat/`:

| File | What's in it |
|---|---|
| `pipeline/world.d.ts` | `World`: creating and removing things, stepping, rays, `contactPair` |
| `dynamics/rigid_body.d.ts` | `RigidBody`, `RigidBodyDesc`, `RigidBodyType` |
| `dynamics/impulse_joint.d.ts` | `JointData`, the joint classes, `MotorModel` |
| `geometry/collider.d.ts` | `Collider`, `ColliderDesc`, `ActiveCollisionTypes` |
| `geometry/narrow_phase.d.ts` | `TempContactManifold` |
| `geometry/ray.d.ts` | `Ray`, and the hit types |
| `pipeline/event_queue.d.ts` | `EventQueue`, `ActiveEvents`, `TempContactForceEvent` |
| `rapier_wasm3d.d.ts` | the raw WASM layer, including `RawImpulseJointSet` and `RawJointAxis` |

Every call takes an object with `x`, `y` and `z` (and `w` for a rotation), so
a three.js `Vector3` or `Quaternion` can be passed as it is. What comes back is
a plain object, not a three.js one.

## World and stepping

```ts
import RAPIER from "@dimforge/rapier3d-compat";

await RAPIER.init(); // the WASM has to load before anything else
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
world.numSolverIterations = 16; // the default 4 lets the arm stretch at the shoulder
const events = new RAPIER.EventQueue(true); // auto-drain: cleared at the start of each step

world.step(events);
```

That is `createPhysics` in `src/core/physics.ts`, and `PhysicsWorld.step()`
passes the queue every time. `world.step()` always advances `world.timestep`;
the fixed-step loop in `src/core/loop.ts` is what keeps real time.

## Bodies and forces

```ts
const hull = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 1, 0)
    .setLinearDamping(0.2)
    .setAngularDamping(6)
    .setCanSleep(false),
);
hull.setEnabledRotations(false, true, false, true); // turn about Y only

// Forces and torques are kept until cleared. Clear at the top of every step
// that drives the body, then add this step's:
hull.resetForces(false);
hull.resetTorques(false);
hull.addForce({ x: 0, y: hull.mass() * 9.81, z: 0 }, false);
hull.addForceAtPoint({ x: 10, y: 0, z: 0 }, { x: 0, y: 1.5, z: 0 }, true);
hull.addTorque({ x: 0, y: 2, z: 0 }, true);

// Or set the motion outright, as the hull's walking does:
hull.setLinvel({ x: 1, y: hull.linvel().y, z: 0 }, true);
```

- The last argument of most setters is `wakeUp`. The game's moving bodies are
  made with `setCanSleep(false)`, so it rarely matters.
- `enableCcd(true)` is on the weapon and forearm bodies.
- `setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)` and back to
  `Dynamic` is how a stowed weapon and a ragdoll's legs change role.
- Kinematic bodies: `setTranslation`/`setRotation` to place one outright
  (needed before its first step, since it is created at the origin), and
  `setNextKinematicTranslation`/`setNextKinematicRotation` to move it, which
  gives it the velocity that pushes dynamic bodies.
- There is no `velocityAtPoint` in 0.14. A point's velocity is
  `linvel() + angvel() × (point − worldCom())`: `linvel()` is the velocity of
  the centre of mass, not of the body's origin (`translation()`). `Arm.drive`
  gets the hand right because the forearm's centre of mass is its origin.
  `Arm.velocityAt` and `Arm.sampleTip` measure from `blade.translation()`, the
  grip, while a weapon's centre of mass is out along it (0.54 m on the sword,
  0.79 m on the axe), so while the weapon turns the speeds they report are off
  by its spin times that distance. Every hit speed and damage number the game
  has been tuned on came from them, so correcting that is a change of its own,
  with re-tuning.
- `world.removeRigidBody(body)` also removes its colliders and every joint
  attached to it. A handle to anything removed is dead: drop it, and drop any
  Interpolator entry that reads it (`registerBodies` rebuilds the list).

## Mass

Rapier 0.14 moves each collider's inertia to the body's centre of mass with
the wrong sign, which is only harmless for a one-collider body. The weapon's
colliders therefore have `setDensity(0)`, and its body is given its mass
properties whole:

```ts
declare const blade: RAPIER.RigidBody;
blade.setAdditionalMassProperties(
  1.4,                            // kg
  { x: 0, y: 0.35, z: 0 },        // centre of mass, body-local
  { x: 0.06, y: 0.0002, z: 0.06 }, // principal moments, kg·m²
  { x: 0, y: 0, z: 0, w: 1 },     // rotation from body axes to principal axes
  true,
);
```

The numbers come from `weaponMassProperties` in `src/game/weapons.ts`; those
above are only placeholders. `RigidBodyDesc` has the same
`setAdditionalMassProperties` (without `wakeUp`), which is how the lever in
`gate.ts` gets a weight with no collider at all. `principalInertia()` and
`principalInertiaLocalFrame()` read them back, which is what `stablePD` in
`src/game/drive.ts` uses to cap its gains per axis.

## Colliders

```ts
declare const body: RAPIER.RigidBody;
const collider = world.createCollider(
  RAPIER.ColliderDesc.capsule(0.12, 0.05) // half the straight length, then the radius; along local Y
    .setTranslation(0, 0.2, 0)
    .setMass(2.1)
    .setFriction(0.5)
    // Membership high, filter low: fighter 0's body bit, meeting the world.
    // Real code takes this from groups() or a Side, never a bare number.
    .setCollisionGroups((0x0008 << 16) | 0x0001)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(1.0),
  body,
);
collider.setEnabled(false); // out of the world, still attached
collider.setCollisionGroups((0x0008 << 16) | 0x0010); // a new role at runtime
```

- `ColliderDesc.cuboid(hx, hy, hz)` takes half-extents; `ball(radius)`.
- `setMass` gives a collider a mass directly; `setDensity(0)` gives it none.
- The game asks for `CONTACT_FORCE_EVENTS` only, never `COLLISION_EVENTS`: a
  hit needs a force, and the threshold filters out the lightest touches.
- `collider.parent()` is the body it is attached to; `world.getCollider(handle)`
  turns an event's handle back into a collider.

## Joints and motors

```ts
declare const torso: RAPIER.RigidBody;
declare const upper: RAPIER.RigidBody;
declare const fore: RAPIER.RigidBody;

// A ball joint: anchors in each body's own frame.
const shoulder = world.createImpulseJoint(
  RAPIER.JointData.spherical({ x: 0.2, y: 0.5, z: 0 }, { x: 0, y: -0.15, z: 0 }),
  torso, upper, true,
);
shoulder.setAnchor1({ x: 0.21, y: 0.5, z: 0 }); // move it; the solver carries the limb after it

// A hinge about the bodies' local X, with limits and a motor.
const elbow = world.createImpulseJoint(
  RAPIER.JointData.revolute({ x: 0, y: 0.15, z: 0 }, { x: 0, y: -0.13, z: 0 }, { x: 1, y: 0, z: 0 }),
  upper, fore, true,
) as RAPIER.RevoluteImpulseJoint;
elbow.setLimits(-2.45, -0.06);
elbow.configureMotorModel(RAPIER.MotorModel.ForceBased);
elbow.configureMotorPosition(-1.2, 40, 4); // target, stiffness, damping
elbow.configureMotorVelocity(0, 0.5);      // target speed, factor

world.removeImpulseJoint(elbow, true); // gone for good: rebuild it from its factory
```

- `createImpulseJoint` returns the base `ImpulseJoint`; cast to
  `RevoluteImpulseJoint` for limits and motors. In 0.14 only the unit joints
  (revolute, prismatic) have typed limits and motors.
- A joint's motors act in its first body's frame. That is why the wrist joint
  is built from the weapon's side (`world.createImpulseJoint(..., blade, fore,
  true)`): its twist has to be about the weapon's own length.
- The default `MotorModel.AccelerationBased` scales the gains by the effective
  mass of the two joined bodies only, and nothing hung off them. The ragdoll
  uses `ForceBased` with gains worked out from the anatomy, so they mean a
  torque per radian and per rad/s, as given.
- Motors in 0.14 take no force limit (`setMotorMaxForce` came later), and
  neither does the raw joint set. A velocity servo can be bounded anyway: with
  the force-based model its torque is about `factor` × (target speed − actual
  speed), so with the target capped, a joint held still gets at most
  `factor` × the cap, and more only if something drives it backwards.
- `world.getImpulseJoint(handle)` tells you whether a joint still exists before
  you remove it again (`ragdoll.ts` does this).

## Per-axis limits and motors on a ball joint

A spherical joint has a limit and a motor per rotational axis underneath, but
0.14's typed `SphericalImpulseJoint` exposes neither, and there is no
`JointAxis` enum. The arm's grip and the ragdoll reach the raw joint set:

```ts
/** The slice of Rapier's raw joint set the game uses (see `GripRaw` in arm.ts). */
interface JointRaw {
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
  jointConfigureMotorModel(handle: number, axis: number, model: number): void;
  jointConfigureMotorVelocity(handle: number, axis: number, vel: number, factor: number): void;
  jointConfigureMotorPosition(handle: number, axis: number, target: number, stiffness: number, damping: number): void;
}
const ANG_X = 3, ANG_Y = 4, ANG_Z = 5; // RawJointAxis.AngX/AngY/AngZ

declare const wrist: RAPIER.ImpulseJoint;
const raw = (wrist as unknown as { rawSet: JointRaw }).rawSet; // `rawSet` is protected in the types
raw.jointSetLimits(wrist.handle, ANG_Y, -1.2, 1.2);
raw.jointConfigureMotorModel(wrist.handle, ANG_Y, RAPIER.MotorModel.ForceBased);
raw.jointConfigureMotorVelocity(wrist.handle, ANG_Y, 3, 0.3);
```

Rapier measures a ball joint's per-axis angles from its quaternion, so once
the joint is turned about one axis, the other two readings move with it. Two
position springs on those axes push each other sideways and circulate; the
grip drives velocity servos on an error it works out itself instead
(`Arm.applyGrip`).

## Contact events and manifolds

```ts
declare const blades: Map<number, unknown>;

world.step(events);
events.drainContactForceEvents((e) => {
  const h1 = e.collider1(), h2 = e.collider2(); // handles, either order
  if (!blades.has(h1) && !blades.has(h2)) return;
  const force = e.totalForceMagnitude();
  const a = world.getCollider(h1), b = world.getCollider(h2);
  if (!a || !b || force <= 0) return;
  world.contactPair(a, b, (manifold, flipped) => {
    if (manifold.numSolverContacts() === 0) return;
    const n = manifold.normal();              // flip it if `flipped`
    const p = manifold.solverContactPoint(0); // world space
    void n; void p;
  });
});
```

- Drain once per step, right after it, in one place: draining empties the
  queue, and auto-drain throws away anything left at the next step.
- By then the solver has already stopped whatever collided. Speeds at impact
  come from a snapshot taken before the step (`Arm.snapshotBlade`), never from
  `linvel()` here.
- A blade resting on something reports small forces every step. `Impacts`
  ignores contacts under `RESTING_SPEED` and keeps its cooldown per collider.
- Manifold accessors in 0.14: `normal()`, `localNormal1()`, `localNormal2()`,
  `numContacts()`, `localContactPoint1(i)`, `localContactPoint2(i)`,
  `contactDist(i)`, `contactImpulse(i)`, `numSolverContacts()`,
  `solverContactPoint(i)`.

## Rays

```ts
const groundFilter = (0x0004 << 16) | 0x0003; // the hulls' bit, against WORLD | PROP: a Side's groundFilter
const ray = new RAPIER.Ray({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }); // keep it and reuse it
ray.origin = { x: 2, y: 1, z: 0 };

const hit = world.castRay(ray, 1.2, true, undefined, groundFilter);
if (hit) {
  const distance = hit.timeOfImpact; // along `dir`; the hit collider is hit.collider
  void distance;
}
const withNormal = world.castRayAndGetNormal(ray, 1.2, true, undefined, groundFilter);
if (withNormal) void withNormal.normal;
```

- Arguments after `solid`: query flags, collision groups, a collider to
  exclude, a body to exclude, and a predicate. The game filters by groups:
  an invisible collider still blocks a ray, and the hull encloses the whole
  figure.
- Queries see collider positions as of the last step, and before the first
  step they see nothing at all. To cast against something moved since, call
  `world.propagateModifiedBodyPositionsToColliders()` and then
  `world.updateSceneQueries()` first; neither steps the simulation. `main.ts`
  calls `updateSceneQueries()` before the first step and both after a reset,
  and the harness's `buildRoster` calls `updateSceneQueries()` before its
  first step.

## Names examples get wrong

| Seen in examples | In 0.14 |
|---|---|
| `world.contactsWith(c, f)` | `world.contactPairsWith(c, f)` |
| `world.intersectionsWith(c, f)` | `world.intersectionPairsWith(c, f)` |
| `manifold.localNormalA()`, `localNormalB()` | `localNormal1()`, `localNormal2()` |
| `manifold.localContactPoint(i, 1)` | `localContactPoint1(i)`, `localContactPoint2(i)` |
| `hit.toi` | `hit.timeOfImpact` |
| `RAPIER.SolverFlags.COMPUTE_IMPULSES` | `RAPIER.SolverFlags.COMPUTE_IMPULSE` |
| `RAPIER.ActiveHooks.MODIFY_SOLVER_CONTACTS` | doesn't exist; only `FILTER_CONTACT_PAIRS` and `FILTER_INTERSECTION_PAIRS` |
| `RAPIER.JointAxis.AngX` | not exported; the raw axis numbers are 3, 4 and 5 |
| `spherical.configureMotorVelocity(...)` | not on ball joints in 0.14; use the raw joint set |
| `body.velocityAtPoint(p)` | not in 0.14; `linvel() + angvel() × (p − worldCom())` |
| `@dimforge/rapier3d` imports | this project uses `@dimforge/rapier3d-compat` (the WASM is inlined, and `RAPIER.init()` is required) |
| `<RigidBody>`, `useRapier()` | React Three Fiber's wrapper; this game has no React |

## After 0.14

Compared with 0.21, the newest release at the time of writing:

- Added later: typed motors on ball joints (`SphericalImpulseJoint.configureMotor*`,
  `configureMotorModel`), `setMotorMaxForce` on joints, the `JointAxis` enum,
  `PidController` and `world.createPidController`, `RigidBody.velocityAtPoint`,
  `JointData.revoluteWithAxes`, `ImpulseJoint.setLocalFrame1/2`,
  `setAdditionalPgsIterations`, `world.maxCcdSubsteps` (0.14 has it as
  `world.integrationParameters.maxCcdSubsteps`), soft bodies, voxels and
  compound shapes. A ball joint still has no typed limits in 0.21, so those
  stay on the raw joint set.
- Removed later: `world.queryPipeline` and `world.updateSceneQueries()` (scene
  queries moved to the broad phase), `world.numAdditionalFrictionIterations`
  and the PGS solver switches, `IntegrationParameters.minIslandSize`,
  `TempContactManifold.solverContactFriction/Restitution`, and
  `RigidBody.effectiveWorldInvInertiaSqrt`/`invPrincipalInertiaSqrt`.

Upgrading would let the ball joints' motor calls become typed ones, and could
change how the solver and the motors feel. Check `weaponMassProperties` against
what the new Rapier adds up for a body built from the same parts with real
densities; nothing here says the inertia sign has been fixed. The harness's
`theWeaponsWeighWhatTheyShould` can't tell: the weapon's colliders have
density 0, so it only sees the numbers the game set.
