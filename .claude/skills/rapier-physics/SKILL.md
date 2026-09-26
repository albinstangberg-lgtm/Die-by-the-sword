---
name: rapier-physics
description: How Die by the Sword's physics works and how to change it without breaking the game. The game uses Rapier through @dimforge/rapier3d-compat 0.14.0 (not the Rust crate, not @react-three/rapier), stepped at a fixed 60 Hz, with a sword arm dragged by a force-limited PD controller. Use this skill for any task in this repo that touches rigid bodies, colliders, joints or motors, forces and torques, collision groups, contact events, raycasts, CCD, the arm's drive, cutting and severing, knockdowns and corpses, resets and teleports, thrown items, or physics tuning. Also use it when something in the game jitters, spins, explodes, tunnels, drifts, sticks or scores the wrong damage, before copying Rapier code from the web, and before upgrading Rapier.
---

# Rapier physics in Die by the Sword

The game rests on one idea: the sword arm is a simulated limb, dragged toward
the mouse by a PD controller whose force is clamped. A free blade tracks the
mouse; a blade against stone falls behind it, and that gap is the whole feel of
the game. Nothing is animated. Most physics changes either protect that or
quietly break it, so read README.md, "How the mechanic works", before changing
anything in `src/game/arm.ts`.

## Check every Rapier call against 0.14

The project is locked to `@dimforge/rapier3d-compat` 0.14.0. Most examples on
the web are for newer versions (the newest was 0.21 in September 2026), and
some well-known calls are missing or named differently in 0.14. Confirm a call
in the installed type definitions before using it:

```bash
grep -rn "configureMotorVelocity" node_modules/@dimforge/rapier3d-compat --include=*.d.ts
```

`npm run typecheck` takes a few seconds and catches a wrong name. It cannot
catch a wrong idea of what a call does, so read the doc comment in the `.d.ts`
as well.

Missing from 0.14, though newer docs use them: typed motors on ball
(spherical) joints, `setMotorMaxForce`, the `JointAxis` enum, `PidController`,
`RigidBody.velocityAtPoint`, `JointData.revoluteWithAxes`,
`ImpulseJoint.setLocalFrame1/2`, `setAdditionalPgsIterations`, soft bodies,
voxels and compound shapes. The game drives a ball joint's limits and motors
through Rapier's raw joint set (no version gives a ball joint typed limits),
uses the raw axis numbers in place of `JointAxis`, and, with no force limit on
a motor, bounds its torque by capping the speed it asks for.
[references/rapier-0.14-api.md](references/rapier-0.14-api.md) shows how, lists
the 0.14 calls the game relies on, and names the ones that examples often get
wrong.

## Where the physics lives

| File | What it owns |
|---|---|
| `src/core/physics.ts` | `createPhysics`: the world (gravity from tuning, `timestep = STEP`, 16 solver iterations for the stiff arm), the one `EventQueue`, and the collision groups (`GROUP`, `groups()`, `makeSides()`) |
| `src/core/loop.ts` | the fixed 60 Hz accumulator: `STEP`, at most 5 steps per frame |
| `src/core/interpolate.ts` | `Interpolator`, which places the mesh of every rigid body but the exceptions in rule 10 |
| `src/main.ts` | the order of one step (`fixed`), `registerBodies`, and the reset (`input.onReset`) |
| `src/game/arm.ts` | the sword arm: upper arm, forearm and weapon bodies; shoulder, elbow and wrist joints and their factories; the linear and angular drives; the grip's raw motors; the blade snapshot; stowing, severing and reset |
| `src/game/drive.ts` | `stablePD`, an angular PD capped by each axis's inertia |
| `src/game/weapons.ts` | weapon shapes, and `weaponMassProperties` |
| `src/game/fighter.ts` | the hull (one dynamic body per fighter, turning about Y only, walked by setting its velocity, and carried over a wall or up a ledge the same way), the trunk colliders on it, head and off arm on joints (`jointFor`), posed kinematic legs, ground, step and sight rays, knockdown, reset. `traverse.ts` only poses the body for a vault or a climb |
| `src/game/ragdoll.ts` | a dead or floored body: the hull's capsule switched off, hips and legs made jointed dynamic bodies, braced and gathered by motors |
| `src/game/offarm.ts`, `shield.ts` | the other arm, and the shield on it or on the back |
| `src/game/impacts.ts` | drains the contact-force events once per step and turns them into hits |
| `src/game/cutting.ts` | a swept-ray backstop for a blade already inside someone. Its header still describes the old design, in which blades passed through bodies; they collide with enemy bodies now (see `Side.bladeFilter`) |
| `src/game/gate.ts` | the lever, a dynamic bar with no collider on a revolute pin, sprung by a force-based position motor and pulled through a joint to the hand; and the gate, a kinematic body in the `WORLD` group winched up with `setNextKinematicTranslation` |
| `src/game/dummy.ts`, `arena.ts`, `items.ts`, `remains.ts` | the practice dummy, the rooms, things picked up and thrown, what comes off a body |
| `src/tuning.ts` | every number that shapes the feel (`DEFAULTS`) |
| `tools/smoke.ts` | the headless harness |

## One step, in order

`fixed()` in `src/main.ts` runs every 1/60 s:

1. Queued one-shot actions run (`perform`), and `pickup.step` walks the body
   toward whatever it is going to pick up. Anything input asks for that adds
   or removes a joint, such as sheathing, taking hold or letting go, is queued
   and done here, between two steps, never in an event handler.
2. Everyone acts: `player.act(...)`, then each foe's `ai.think(...)` and
   `combatant.act(...)`. The drives run here. The arm clears last step's
   forces, moves the shoulder joint's anchor to where the posture put the
   shoulder, and adds this step's forces and torques; the hull gets its
   velocity; the kinematic legs get their next pose. Mouse movement is read
   here, once per step, not once per frame.
3. `arena.gate.step(dt)` gives the gate its next kinematic position.
4. `interp.capture()`, `phys.step()`, `interp.commit()`.
5. `arena.lever.update()` (a lever pulled far enough catches and opens the
   gate), `items.update()`, each arm's `updateDerived()`, then
   `impacts.update(now)`, which drains the contact events.

Each frame, `render` then calls `interp.apply(alpha)` and draws.

So anything that pushes (forces, torques, velocities, kinematic targets, joint
anchors) is set before the step, and anything that reports (contacts, sweeps)
is read after it. The event queue auto-drains, so events not drained right
after a step are gone at the next one; and draining empties it, which is why a
single `Impacts` serves every blade and routes events by collider handle.

## Rules the game depends on

Each of these cost real debugging time. The full story is in README.md, in the
section "... things the physics taught us"; search it for the bold title in
brackets.

1. **The clamp is the game.** Don't make the sword arm kinematic, place it by
   IK, or raise the force clamp to make it track better: a blocked blade has
   to fall behind the mouse. IK only computes the target pose. The harness's
   "blocked blade defeats the arm" checks guard this, and README.md, "Deliberate
   behaviours", lists the lag, the planted sword and being pushed by your own
   swing as intended.
2. **Forces stay until cleared.** Rapier keeps `addForce` and `addTorque` from
   step to step. A drive clears its bodies at the start of every step
   (`resetForces(false)`, `resetTorques(false)`), and so must anything that has
   stopped driving (a limp, severed or dead limb), or its last push goes on for
   ever: a dead goblin's arm once dragged its corpse six metres. [Stopping a
   drive does not remove its force; Nothing must drive a corpse]
3. **An explicit drive has to fit the inertia it pushes.** A torque worked out
   from this step's state is stable only while its stiffness stays under
   0.7·I/dt² and its damping under 1.5·I/dt, per principal axis. Past that the
   body flips back and forth every step and sits at the clamp. Use `stablePD`
   from `drive.ts` for any new angular drive; a weak drive is not a safe one.
   [An arm nobody drives is still being driven; An empty hand is a different
   arm]
4. **Give a multi-part body its mass yourself.** Rapier 0.14 moves each
   collider's inertia to the shared centre of mass with the wrong sign, so a
   weapon built from parts gets inertia about its own length that no rod has:
   as hard to roll in the hand as to swing end over end. Weapon colliders have
   density 0 and the weapon body gets `setAdditionalMassProperties` from
   `weaponMassProperties`. Do the same for any new multi-collider body whose
   rotation matters. [Rapier adds up a body's inertia the wrong way round]
5. **Something very light needs the joint's own motor.** A sword has about
   0.0002 kg·m² about its length, and no explicit torque on that is both stable
   and strong. The grip is the wrist joint's motor instead: a force-based
   velocity servo, which Rapier solves implicitly. Its torque is about
   `factor` × (the speed it asks for − the speed it has), so with the asked
   speed capped, a weapon wedged in stone gets at most `factor` × the cap.
   [Something light enough can only be held by an implicit drive]
6. **Kinematic bodies.** They are created at the origin, so put them in place
   with `setTranslation` and `setRotation` before their first step, then move
   them with `setNextKinematicTranslation` and `setNextKinematicRotation`
   (`pushKinematic` in `fighter.ts`). Nothing can push one back, so the posed
   body parts meet only other fighters' blades (`hitOnlyFilter`), and a weapon nobody
   is swinging switches to `inertBladeFilter` so they don't meet that either:
   a posed foot once fired a dropped spear across the room at 17 m/s. The gate
   is the one kinematic body that meets everything, as architecture does, and
   it only ever moves up out of the doorway. [A kinematic body is born at the
   origin; Nothing pushes back on a kinematic leg]
7. **Move a fighter only through its reset.** Setting the hull's position
   leaves the head, off arm and sword arm behind on joints a room long, and
   the solver drags the hull back. Use `Combatant.reset(tuning, at)`, then
   `impacts.resetSweeps()` so no blade sweeps the room from where it was, as
   the harness's `rig.place` does. The game's reset (`input.onReset` in
   `main.ts`) also re-registers every body with the Interpolator and calls
   `interp.snap()`, so nothing streaks. [A hull moved on its own drags itself
   back]
8. **A severed joint is gone.** `removeImpulseJoint` deletes it; there is no
   disabled state to flip back. Rebuild joints only through their factories
   (`makeShoulderJoint`, `makeElbowJoint` and `makeWristJoint` in `arm.ts`,
   `jointFor` in `fighter.ts`), and lay the limb out in its rest pose first: a
   joint made across a gap fires the limb at its anchor. [A reset has to put
   the joints back, not just the flags]
9. **Measure a hit from before the step.** By the time contact events are read
   the solver has already stopped the blade, so damage uses the blade's motion
   from `Arm.snapshotBlade()`, taken before the step. Resting contacts are
   dropped (`RESTING_SPEED`) and cooldowns are per collider. [Contact events
   arrive too late to measure a hit]
10. **Only the Interpolator draws rigid bodies.** Add a new body and its mesh to
    `registerBodies` in `main.ts`. A mesh written anywhere else loses its
    interpolation and judders above 60 Hz. The deliberate exceptions are the
    posed legs, the ghost hand, and a downed body's hips and legs, which
    `Ragdoll.pose` places with its own easing; registering those would place
    them twice. [A mesh placed twice is a mesh that is not interpolated]
11. **Fixed step only.** Stiff PD drives explode under a variable timestep.
    Don't change `world.timestep` or step with a frame's `dt`.
12. **CCD on anything fast and thin.** The weapon, the sword forearm and,
    once a shield is on it, the other forearm have `enableCcd(true)`; without
    it a fast tip passes straight through the thin post.
13. **Rays see the world as it was at the last step.** Rapier updates what a
    ray can hit as it steps, so a ray cast before the first step finds no
    walls, and after anything is moved outright (a reset, the gate shut
    again) rays still find it where it was. `main.ts` calls
    `world.updateSceneQueries()` before the first step, and after a reset
    `world.propagateModifiedBodyPositionsToColliders()` and then
    `updateSceneQueries()`; do the same wherever you move things and cast
    before the next step. [The world's rays see nothing before it has
    stepped]
14. **A point's velocity is the centre of mass's plus the spin about it.**
    `linvel()` is the velocity of a body's centre of mass, not of its origin,
    so a point's velocity is `linvel() + angvel() × (point − worldCom())`. A
    weapon's origin is its grip and its centre of mass is 0.54 m up a sword,
    0.79 m up an axe, so measuring from the origin once added about 11 m/s at
    20 rad/s to every blow. Every speed threshold in the game (cut thresholds,
    `DAMAGE_PER_MS`, clash knocks, how the AI reads a swing) is tuned against
    the honest speeds, and the balance model judges a blow at `REACTION`
    times its speed (`balance.ts`), the units its footing, balance and the
    ogre's `heave` were set in; don't reintroduce the old measurement.
    [A body's velocity is its centre of mass's]

## Collision groups

Rapier keeps a collider's membership in the top 16 bits and its filter in the
bottom 16, and two colliders touch only if each one's membership is in the
other's filter. `physics.ts` spends the bits on `WORLD` (0x1), `PROP` (0x2)
and one bit that every walking hull shares (0x4), then six body bits and six
blade bits. Each fighter's body is a different three of the six body bits and
its weapon a different three of the six blade bits, and a filter of the three
it has not got meets every other fighter and never itself. There are twenty
threes of six, so twenty fighters, and `makeSides` throws past that. A new kind
of part that needs telling apart costs bits, so reuse a role below if one
fits. Build every value with `groups(membership, filter)` or take it from a
`Side`; never write one as a bare number. [The fifth fighter was one bit too
many; The ninth fighter needed fewer bits each, not more]

`makeSides(teams)` builds everyone's filters at once. Friendly fire is on: a
blade cuts every body but its owner's, whoever's side it is on, and
`Side.team` is allegiance only, which the AI reads (`Ai.company`) and the
filters do not. [Friendly fire took bits away] Use the filter for the part's
role:

| `Side` filter | Used for |
|---|---|
| `bodyFilter` | hittable body parts: trunk, head, arms |
| `bladeFilter` | a weapon being swung: meets stone, props, every other blade and every other body, but not its owner |
| `cuttableFilter` | the sweep's rays: what counts as flesh |
| `shieldFilter`, `backShieldFilter` | a shield on the arm, and one slung on the back |
| `inertBladeFilter` | a weapon nobody is swinging: floor, walls, props and other blades only |
| `hullFilter` | the invisible walking capsule: meets the world, props and every other hull; blades pass through it |
| `hitOnlyFilter` | kinematic parts that exist only to be cut, and the trunk's colliders while a vault, a climb or getting up carries the hull through stone |
| `groundFilter` | the downward probe that decides whether the feet are on something |
| `sightFilter` | rays that should find stone only: line of sight, the step and ledge probes, and where a throw can go |

Scenery, the gate included, is `groups(GROUP.WORLD, GROUP.WORLD | GROUP.PROP |
ALL_COMBATANTS)` (`arena.ts`, `gate.ts`). Something that should meet nothing
at all can go without a collider, as the lever does: its body has only mass.
Weapons collide with each other on purpose: a parry is two blades in the same
place. An invisible collider still blocks a ray, so give every ray a filter.
[An invisible collider still blocks a raycast]

## Making a change

1. Find the subsystem in the table above, read its code, and search the
   README's "... things the physics taught us" for it.
2. Check each Rapier call against 0.14.
3. Put a feel knob in `src/tuning.ts`. Give any other number a name and a
   comment saying why it is that number, as the surrounding code does.
4. Add a check to `tools/smoke.ts`: an `async function` that builds a rig with
   `buildRig(overrides?, foeSpecies?, foeAt?)` (the player is always the
   swordsman at `SPAWN`), drives it with `rig.step(n, keys)`, `rig.fight(n)`,
   `rig.hold(n)`, `rig.pin(at)` or `rig.place(at)`, and reports with
   `check(name, ok, detail)`, putting the measured numbers in `detail`. A
   rate, count or order of something the AI chooses at random is a
   `tendency(name, ok, detail)` instead: give it enough samples that luck
   alone sinks it on well under one seed in a hundred. Then add the function
   to `GROUPS`, just above `run()`. Measure the thing itself: the
   README's five lessons "about the harness rather than the game" are about
   checks that passed because nothing happened, or because they leaned on a
   bug.
5. Run `npm run typecheck` yourself. Run the harness (`npm run smoke`) the
   way CLAUDE.md says: through the `smoke-tester` agent, in the background.
   It runs the real modules against Rapier in Node for a few minutes, prints
   `passed/total checks passed`, and exits 1 when a rule fails and 2 when
   only tendencies miss. `SMOKE_ONLY=<group> npm run smoke` runs just that
   group, to iterate on it: each group rolls its own dice, so on its own it
   gives exactly what it gives in the full run.
6. The harness's dice are loaded: `tools/dice.ts` replaces `Math.random` with
   a seeded generator, so the same code gives the same result on every run,
   and running it again tells you nothing new. The seed is printed at the top
   of the log and on its last line, and `SMOKE_SEED=<n> npm run smoke` repeats
   a run exactly, or rolls other dice. The AI, the way a body falls when it
   dies and the spin of a severed dummy limb all roll them, and a physics
   check that follows a fight starts from wherever the fight left things, so a
   change that rolls differently, or moves anything a fight touches, deals the
   rest of that group different dice, and a check that fails on some dice can
   turn over without being broken. A rule that fails (`FAIL`) is a bug on any
   seed. A tendency that misses (`MISS`) may be the dice: `npm run
   smoke:seeds -- --groups <group> --against HEAD` runs its group on ten
   seeds with your change and without it, and says whether it misses more
   often with it. Don't loosen a threshold to get a pass; a tendency luck
   sinks too often needs more samples.
7. If the feel changed, say what to try in the browser (`npm run dev`). The
   harness measures; it can't feel.

## When something looks wrong

| Symptom | Usual cause |
|---|---|
| A part flips direction every step, or buzzes at its torque clamp | explicit gains above the inertia bound; use `stablePD` |
| A body accelerates for ever; a corpse crawls or flies | forces not cleared (rule 2) |
| A weapon or forearm spins at hundreds of rad/s | a drive on the arm's roll about its own length near a straight elbow, where that roll weighs almost nothing; or an explicit torque on something as light as a weapon's roll (rule 5) |
| A weapon is as hard to roll in the hand as to swing | Rapier left to add up a multi-part body's inertia (rule 4) |
| A blade passes through a thin post | no CCD on that body |
| A fast cut scores almost no damage | velocity read after the step instead of the snapshot |
| A turning weapon's speeds come out too high | a point's velocity measured from the body's origin, not its centre of mass (rule 14) |
| A limb shoots toward its anchor on a reset or a draw | a joint created across a gap |
| A fighter ends up a metre from where it was put | the hull was moved on its own |
| Something posed shoves the room or launches props | a kinematic body meeting more than other fighters' blades, or not placed before its first step |
| A mesh judders on a fast monitor | the mesh is written outside the Interpolator |
| A joint motor can't lift what it joins | Rapier's acceleration-based motors scale by the two joined bodies only; `ragdoll.ts` uses force-based motors with torques worked out from the anatomy |
| Two springs on a ball joint circle each other | Rapier reads a ball joint's angles off its quaternion; use a velocity servo on a proper error, as `Arm.applyGrip` does |
| A ray finds nothing useful | an invisible collider such as the hull in the way; filter the ray |
| A ray misses a wall on the first step, or finds something where it was before a reset | scene queries not brought up to date (rule 13) |

## Upgrading Rapier

Don't change the version as a side effect of another task. Newer releases
change joint motors, where scene queries live, and the solver. If the upgrade
is the task, read the end of
[references/rapier-0.14-api.md](references/rapier-0.14-api.md), replace the raw
joint calls only where a typed call now exists, and expect to re-tune: run the
whole harness, and play it.
