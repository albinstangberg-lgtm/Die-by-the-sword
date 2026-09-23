# Die by the Sword — browser prototype

A physics-driven melee prototype in the spirit of Treyarch's 1998 *Die by the
Sword*: the sword arm is a simulated limb, not a set of attack animations. You
drag the mouse, the arm follows, and the blade's damage — and its bounce, its
lag, its refusal to go where you asked — comes out of the physics.

**This is stage 6.** Stage 2 asked whether swinging a sword at a wall feels
good. Stage 3 gave the swing consequences. Stage 4 put someone in the room who
swings back. Stage 5 gave you something to fight that is not a copy of you: an
orc with an axe and a goblin with a spear, both bound by the same physics, both
telling you what they are about to do before they do it. Stage 6 stops them
sharing a room — there are three now, with doors between them — and makes a cut
look like one. Since then the body has learned to get out of its own arm's way:
the chest turns ahead of a swing, the shoulder slides round the ribs, the head
watches the blade, the feet step under a turn, the arm no longer goes straight
through the chest to get across it, and the forearm twists to keep the edge
where you put it.

```
npm install
npm run dev      # http://localhost:5173
npm run smoke    # headless physics harness — 143 checks, no browser needed
npm run build    # production bundle
```

## Controls

| | |
|---|---|
| **mouse** | the sword arm |
| **right-drag** | hold the right button, move left/right to roll the cutting edge |
| **wheel** | reach — extend and retract |
| **W / S** | forward, back |
| **A / D** | turn (arrow keys also work) |
| **Q / E** | sidestep |
| **Space** | jump |
| **Tab** | tuning panel |
| **R** | reset the fight |
| **Esc** | release the mouse |

Turning is on the keyboard because the mouse is the *arm*, not the camera. That
was true of the original and it is the first thing to relearn.

Turning is also on **A/D**, where a shooter would put strafing, and the sidestep
is out on Q/E. That is deliberate and it is the second thing to relearn: with
the mouse spoken for, turning is the control you reach for constantly — to face
someone, to keep them in front of you, to carry a swing further round than your
shoulder allows — and it belongs under your fingers.

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
elbow, weapon in a grip that turns about the forearm's length. Dynamic bodies
with real mass, subject to gravity, inertia and collision.

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

### The body around the arm

The arm is simulated; the trunk it hangs from used to be a rigid block locked to
your facing. The arm cannot collide with its own body — it would snag on its own
shoulder every step — so nothing stopped a cross-body cut going straight through
the chest: measured against the body you can see, twenty centimetres in. [`posture.ts`](src/game/posture.ts) and
[`clearance.ts`](src/game/clearance.ts) are the layer that moves the body
instead.

- **The chest leads.** It turns toward the swing from the *intent* — the ghost's
  aim plus seventy milliseconds of its velocity — so it is most of the way round
  before the physical hand, which always lags the ghost, crosses in front of it.
- **The shoulder girdle makes room.** Reaching across, the shoulder slides
  forward and round the ribs; raised, it lifts; straining against a bind, it
  shrugs. Moving the shoulder is done by moving the joint's *anchor*, never the
  limb: the solver carries the arm after it like any other constraint.
- **Secondary motion.** The chest leans into a chop and a thrust, bends with a
  sweep, and bends *against* the hand's acceleration for a moment as a swing
  gets going and after it as the swing is stopped — the arm's reaction on the
  body, which is most of what separates a swung sword from a posed one. The head
  follows your blade; an opponent's follows you.
- **Clearance, in two layers that agree.** The ghost is solved clear of the
  trunk: the elbow is swivelled round the shoulder-to-hand line the least it has
  to be, only when it has to be, by a search that asks where the elbow can get
  *from where it is* without passing through the ribs. A soft repulsion on the
  real limb catches what the target cannot foresee — a lagging flick, a shove.
  It starts at the body's surface, the target keeps a buffer off it, so an arm
  that has arrived is touching nothing.
- **The forearm twists.** The weapon turns in the grip about the forearm's
  length — pronation and supination — toward the edge your aim and your roll
  asked for. So when the clearance has to move the elbow, the edge no longer
  goes with it, and a roll toward your own chest no longer stops dead at the
  ribs: the elbow stops there and the forearm turns the rest of the way, as a
  real one does. It turns where the edge faces, not where the blade points;
  that would take a wrist. The grip is the joint's own motor, pushed only as
  hard as `grip twist` allows.
- **Flicks travel the arc.** A flick used to teleport the ghost two radians round
  the shoulder, and the drive dragged the hand along the straight chord to it —
  which runs inside the arm's reach. The followed intent now passes anything a
  hand does at a human speed straight through, rounds off only what no arm could
  do, and waits for an arm that has fallen far behind rather than running away
  from it.
- **The hips take their time, the feet stay put.** The spine takes a turn fast,
  the hips take their share slowly underneath, and the feet stay planted while
  the hips turn over them — until they are wound up too far, and then the
  leading foot steps, then the other.

Three rules keep all of it from costing the arm anything. What makes room for
the arm — the chest's turn, the hips, the shoulder sliding round the ribs —
reads *intent*, never the physical arm, so the body leads a swing instead of
trailing it; only the lean, bend and shrug also react to the real hand's
acceleration and the drive's strain, and those are clamped small and sprung, so
they can nudge the shoulder but never steer your aim. Your aim stays in the
hull's frame, so turning the chest moves the shoulder and nothing else: the
hand still goes where you pointed. And a held aim settles into one posture, so
the probes an opponent aims with solve against the body it will actually have. Set `torso lead`, `secondary motion`
and `clearance` to 0 in the panel to get the old rigid block back and see what
it was doing.

### Damage

Hits are described by measurements, not by a hitbox test:

```
damage = (closing speed − threshold) × bite alignment² × sweet spot
         × heft × sharpness
```

- **closing speed** — a slow blade pushes, it does not cut. Below the threshold
  a hit is a shove no matter how well aimed.
- **bite alignment** — *squared*, so it is brutal. Forty-five degrees off keeps
  you 28% of your damage; ninety degrees and you have slapped someone with a
  steel plank. For a spear the axis measured is the point rather than an edge,
  so the same term asks how squarely the thrust went in.
- **sweet spot** — the weapon's own answer to where its leverage is. A sword's
  percussion point two thirds down, an axe's head, a spear's last fifteen
  centimetres.
- **heft** — the square root of the weapon's mass over the sword's. Not a stat:
  it is the same kilogram figure the solver uses to decide how hard the thing is
  to swing.
- **sharpness** — how concentrated the bite is. The one number here that is
  declared rather than derived, and it earns its place: an edge has to *shear*
  tissue and needs speed to do it, a point *parts* tissue and goes in at walking
  pace. Without it a spear thrust arriving at 4 m/s scored two points of damage
  and the goblin was decoration.

There is no light attack or heavy attack. The only way to raise the number is to
swing faster, with the edge leading, and connect on the right part of the weapon
— which is to say, to actually cut properly.

### A sword does not bounce off a person

Blades do not collide with anything soft. They collide with the world and with
each other — stone stops a sword, and a parry is still two swords meeting — but
against a body a blade passes through, and the hit is found by casting the
blade's own line from where it was last step to where it is now.

This is not a shortcut. It is the difference between the mechanic working and
not working. Modelling flesh as a rigid collider means a 1.4kg blade meeting a
20kg torso stops dead, and a stopped blade cannot cut: the swing that should
have arrived at 12 m/s instead registered two dozen grazing contacts at 3 m/s
while the sword wiped across the target like a windscreen wiper, braked from
first touch onward. Every cut in the game was worth about a tenth of a point of
damage.

Sweeping the blade's line reports the speed it was *actually* travelling when it
arrived, which is the number the whole damage model is built on. It also means
you can swing from inside your own reach, where the arc crosses a target's
centre rather than skidding off its near surface.

### What a cut looks like

Underneath, a fighter is what it always was: an invisible capsule that walks,
carrying a handful of capsule colliders that a blade can find and a set of
joints that can be cut. None of that changed here. What changed is the
drawing.

Each capsule is now a **tapered shell** — a profile swept round the limb's own
axis, so it has a shoulder end and a wrist end and a little muscle in between —
and the joints between them are filled with balls, so the silhouette runs
unbroken from shoulder to hand instead of reading as a bag of sausages. A neck,
a belt, hands and feet finish it. Every shell is built from the same two
numbers as the collider it stands in for, and every one of them is either a
mesh the Interpolator already places or a child of one, so the rule that
nothing else may move a body's mesh still holds.

There is exactly one deliberate mismatch between what you see and what a blade
finds: the **head is drawn about a centimetre and a half proud of its collider**,
because that collider is sized by mass and a head at that radius reads as sunk
into its own shoulders. The slop is the right way round — the head you can see
is the generous one, so a cut that looks like a miss is one.

A joint ball belongs to the *proximal* side — shoulders on the torso, elbows on
the upper arm, knees on the thigh — which is what makes a severed limb come
away with a flat cut face rather than a ball joint, and leaves the body with
something rounded where the arm used to be.

**And a cut bleeds.** A sever used to be a joint quietly leaving the world: the
piece dropped, a dark disc appeared, and the moment read as nothing. Now it
throws a burst of droplets along the blade's own travel, and the two faces it
left — the piece that fell and the stump on the body — go on emptying for a
second and a half afterwards. Both are local points on meshes that are already
placed every frame, so the arm bleeds all the way to the floor and the stump
bleeds from the shoulder rather than from where the shoulder used to be.

Lesser cuts spray in proportion to the damage they actually did, so a flat slap
produces nothing and the blood agrees with the number in the HUD.

Which hits bleed and which throw sparks is not a lookup. The two hit paths
already know: **a solver contact is stone or steel**, because a blade collides
with nothing else, and **a swept hit is flesh**, because that is the only thing
a sweep looks for. Sparks come off the wall, blood comes out of the body, and
neither has to be told what it hit.

## The testing area

Three rooms, and the point of them is that they are not one room.

```
        ┌───────────────────────────┐
        │          THE HALL         │           ┌───────────────┐
        │           an orc          │   door    │   THE CELL    │
        │  a low beam, a block and  ├───────────┤   a goblin,   │
        │        a thin post        │           │  and nothing  │
        │                           │           │     else      │
        └────────────┐   ┌──────────┘           └───────────────┘
                     │   │ door
        ┌────────────┘   └──────────┐
        │     THE TRAINING ROOM     │
        │   the practice dummy and  │
        │        four pillars       │
        │                           │
        └───────────────────────────┘
               you start here
```

You start in the training room with the practice dummy and four pillars, and
nothing else in it — a cut you land there is a cut you can read. North through
the door is the hall, which holds the orc and the scenery a big swing gets
caught on. East out of the hall is the cell, which holds the goblin and
nothing at all, because a spear's reach is the whole argument and a cluttered
room would answer it for you.

Walls change what an opponent can know, and that turns out to be the whole of
the layout:

**An animal that cannot see you does not come for you.** Every opponent casts
one ray, eye to eye, against the architecture and nothing else — bodies do not
block it, the hanging dummy does not block it, stone does. If the line is
broken it holds its post: it does not track you, it does not turn, and it
keeps its weapon where a waiting animal keeps it. The fight panel says
`waiting`, which is also how you can tell at a glance that the room you are in
is yours.

Sight alone is not enough to start a fight, and a door is why. A door is a hole
you can see a long way through, so a bare line-of-sight test had the orc set off
across its hall the moment you lined up with the doorway eighteen metres away
in another room. **Notice is close range** — nine metres — and once it has
noticed you, sight alone keeps it coming. So you can stand in the training room
and look through the door at an orc that has not seen you yet, and walk through
that door and find that it has.

Losing sight does not stop a fight dead either: it keeps coming for two and a
half seconds after the line breaks, which is about one pillar's worth. An
opponent that downed tools every time you stepped behind something would be
trivial to beat and absurd to watch.

## The bestiary

Three creatures, and not one of them has a stat block. A species is **a size, a
weapon, and a list of attacks it knows how to throw** — everything that makes an
orc feel like an orc falls out of the physics those three imply.

| | | | |
|---|---|---|---|
| **you / the swordsman** | 1.85m, 82kg | sword, 1.4kg | the reference. Every number in this project was tuned against this figure. |
| **the orc** | 2.11m, 147kg | axe, 3.65kg | slow, enormous, committed to everything it starts |
| **the goblin** | 1.37m, 32kg | spear, 1.05kg | outreaches you, and does nothing else well |

(Masses are the walking body — the hull that does the shoving. Arms and weapons
are separate bodies on top.)

Bodies are one set of human proportions multiplied by a length scale and a
thickness scale. Lengths go with the scale, thicknesses with scale × girth, and
mass with volume — so a goblin at 0.74 weighs a third of you and an orc at 1.14
nearly twice. That cube law is doing real work: it is why an orc shrugs off a
cut that fells a goblin, and it is geometry rather than a difficulty setting.

Two things are derived from that mass, at different rates, and the gap between
them is the whole strategy against a big enemy:

- **health** scales with mass. The orc carries 179 to your 100.
- **joint integrity** scales with mass<sup>2/3</sup> — cross-sectional area,
  which is literally what a cut has to get through. The orc's shoulder is only
  half again as hard to cut as yours.

So you do not out-damage an orc. You take its arm off.

The one number a species declares that its size does not explain is `grit`, a
strength multiplier, and exactly one creature needs it. A goblin's spear is a
metre of lever; at the strength its shoulders imply, the arm's torque budget
cannot hold the shaft on line while the hand accelerates, and every thrust
arrived rotating and landed flat. A wiry thing that is strong for its size is
both the obvious answer and the true one.

### The weapons

A weapon is a set of rigid parts with real masses at real distances from the
hand. Almost everything that distinguishes them falls out of that.

- **The sword** is an even bar. It is the weapon the tuning was measured
  against, and its leverage peaks about two thirds down, where a real blade's
  percussion point sits.
- **The axe** carries 2.7kg of iron a metre from the hand. Its moment of inertia
  is enormous, so it is slow to start, slow to stop, and once it is moving the
  arm's torque budget cannot change its mind. Given the same arm and the same
  mouse command, a sword comes through 94° in three tenths of a second and the
  axe manages 47°. Catch someone with the head and it goes through them; catch
  them with the haft and you have hit them with a stick.
- **The spear** weighs a kilo and is held **choked up**, a third of a metre from
  the butt, which is how a spear is actually held and the only reason a 32kg
  goblin can aim one. Gripped at the end its moment of inertia is higher than
  the axe's; the butt behind the hand balances the head in front of it and
  brings that down by a third. Swung side on it is still a broom handle. Driven
  down its own length it is the most dangerous thing in the room.

Four things a weapon declares rather than derives, because they describe the
shape of its business end and a mass never can: which axis bites (an edge, or a
point), where along itself its leverage is, how fast it has to be moving to do
anything, and how concentrated that bite is.

### Telegraphed attacks

An opponent's swings come from a short, fixed list. Each attack has a **windup
long enough to read**, and while one is winding the weapon lights up and the
panel on the right names it and says how to beat it.

| | | |
|---|---|---|
| **orc** | overhead cleave (0.72s) | sidestep — it only covers one line |
| | wide swing (0.54s) | give ground — it runs out of arc |
| | leg sweep (0.46s) | **jump** |
| **goblin** | jab (0.22s) | turn aside — it is only a poke |
| | lunge (0.45s) | sidestep and close |
| | shaft sweep (0.26s) | stay inside it and cut |
| **swordsman** | cross cut, descending cut, low sweep, backhand | step inside, give ground, jump, turn with it |

Preset because a telegraphed attack is one you can *learn*: the same windup
always becomes the same swing, so once you have seen a cleave you know what the
axe going up means and that you have three quarters of a second to not be there.
The windup runs its declared length every time — an earlier version committed
early the moment the arm reached the wound-up pose, which on a fast arm halved
the orc's cleave, and a tell whose length depends on how cleanly the last swing
finished is not a tell.

None of which makes an attack scripted. Once it commits, the arm is still a
physical limb being dragged toward a target pose under a clamped force. It
overswings, it catches the low beam, it plants the axe in the floor, and the
damage it does comes out of how fast the weapon happened to be travelling when
it arrived.

Attacks are also chosen for the distance. A goblin outside your reach thrusts;
get inside the point and the only thing it has left is the shaft, which is a
broom handle. That is the counter-play made legible.

**The opponent does not cheat.** It drives its weapon arm by emitting *mouse
deltas* through the same input surface your pointer feeds, so its weapon is
subject to the same force clamp, the same reach limits, the same saturating
controller. It cannot teleport its weapon, it cannot swing faster than an arm
can be moved, and if it buries its axe in a pillar it is stuck there exactly as
long as you would be.

### How one attack table fits three bodies

The attack tables are written in **offsets from level** — the arm pitch at which
that creature's own weapon would cross its target's chest — and level is solved
from its own kinematics every time it winds up. So one line reading "a hand's
width above level, swept across" describes the same swing whether a 1.37m goblin
or a 2.11m orc throws it.

The solver is bisection over the same pose maths the ghost hand uses. It touches
nothing physical and knows nothing the creature does not: it is an animal
knowing the length of its own arm. The physical limb still has to get to the
pose under a clamped force, and still frequently cannot.

Edges and points ask different questions of it. An **edge** wants to know where
its arc will cross, so it solves for pitch. A **point** wants to be aimed, which
takes both angles — and both ends of the thrust (see the findings below).

### The jump

Space. The take-off speed is derived from the jump height you ask for and the
world's gravity, so turning gravity down floats the same jump instead of firing
you into the ceiling.

In the air you close only about a twentieth of the gap to your intended velocity
each step, which over a jump comes out at well under half your ground
manoeuvring — enough to adjust, not enough to change your mind. That is the
price of
the one thing a jump buys you, which is being above the orc's leg sweep — the
only attack in the game that cannot be sidestepped, because it is already
travelling along the ground.

It also means a hard swing in mid-air visibly shoves you sideways. A 420N drive
against an 82kg body moves it, and in the air there is no friction to argue.

## Twenty-two things the physics taught us

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

**An invisible collider still blocks a raycast.** Once blades stopped colliding
with flesh and started finding hits by sweeping, every cut landed on the
locomotion hull — it encloses the whole figure, so it is the first thing any ray
meets. The hull is not a body part, so the hit was discarded and nobody could
wound anybody. Hulls have their own collision groups now, and a blade's sweep
does not look for them.

**A kinematic body is born at the origin.** The legs reach their real position
through `setNextKinematicTranslation`, which interpolates — so on the first step
they crossed the room at about 200 m/s, shoving everything they were allowed to
touch. Kinematic parts are placed outright before the first step now, and
they collide with the opposing blade only: a kinematic body is immovable by
anything it hits, so anything else it touches it bulldozes.

**Nothing must drive a corpse.** `Fighter.update` pins the torso upright and
overwrites its horizontal velocity every step. Kept running on a fighter at zero
health, it held the body standing to attention, perfectly dead. Collapsing is
not a force you apply; it is the driving you stop.

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

**A weapon caught on scenery anchors the whole animal.** The low beam sat at
2.05m, which is about the height a two-metre orc carries its axe head. Walking
under it hooked the axe, and a 660N arm against a hull whose velocity is merely
*set* each step is no contest: the orc was pinned to a piece of timber for the
rest of the fight, still dutifully pressing forward at zero metres per second.
Two fixes, and both were needed. The beam is higher and shorter, so it catches a
swing rather than a passer-by. And an opponent now notices when its feet are
turning and its body is not going anywhere, and does what you would do — pulls
the hand in low and gives ground, because a folded arm has leverage a straight
one does not.

**A thrust is reach and nothing else.** The goblin's first lunge swept a quarter
of a radian of pitch on the way in, which on a metre and a half of lever throws
the point sideways at 7 m/s. Closing speed said the blow was enormous and
alignment said the shaft went in flat, so it scored nothing at all — 105 impacts
in twenty-five seconds for one and a half points of damage. Take the sweep out
and the same 7 m/s runs down the shaft instead of across it.

**Aiming one end of a thrust is aiming none of it.** Even with the sweep gone,
extending the arm swings the elbow through a large angle and the weapon held along
the forearm swings with it — so a thrust that only aims its *end* pose arrives
rotating about the hand, and the point's whole velocity is again at right angles
to the shaft. Solving the aim at both the wound-up reach *and* the extended one
leaves the shaft pointing the same way in each, and the only thing left between
them is the hand travelling up its own line. That is a thrust, and it took the
goblin from grazing a standing target for 21 points in forty seconds to emptying
its health bar in the same time.

**A reset has to put the joints back, not just the flags.** Severing removes
the joint from the world outright — there is no disabled state to flip back —
so a reset that cleared `severed` and teleported the limb home produced a
fighter who believed it had a head while the head lay four metres away. The
sword arm was worse: clearing the flag without rebuilding the shoulder left the
limb reading as attached and being *flown* by its own PD controller, held
roughly in place only because the hand's target happens to be anchored to the
shoulder. It looked almost right, which is the dangerous kind of wrong. Joints
are built from one factory now, used both at birth and at reset, and the limb
is laid back out in its rest pose before the joint is made — a joint created
across a metre of gap is a metre of constraint violation, and the solver
answers that by firing the limb at its anchor.

**A mesh placed twice is a mesh that is not interpolated.** Render ran
`interp.apply(alpha)` and then walked the figures copying transforms straight
off the physics bodies — so for everything that did both, the second write
threw the first away. Only the sword arm survived it. Above 60Hz the torso,
the head, the off arm and every limb of the practice dummy stepped at the
physics rate while the sword in the hand ran smooth, which reads as the body
juddering against its own arm. The same copy also pinned the body mesh's
rotation to yaw, so a corpse tumbled in the physics world and stayed bolt
upright on screen. The rule now is that anything with a rigid body is placed by
the Interpolator and by nothing else. The one exception earns it: the posed
legs have no body to read, so they carry their own two poses and ease between
them, and the ghost hand is deliberately snapped because showing pure input a
step in the past would understate the very lag it exists to reveal.

**A hull moved on its own drags itself back.** Putting a fighter somewhere
else by setting its hull's position leaves its head, its off arm and its whole
sword arm where they were, hanging off joints that are now a room long. The
solver answers three violated constraints of that size the only way it can, and
the body it had just been handed ends up over a metre from where it was put —
which looks exactly like a physics bug and is in fact a teleport that only
moved a third of the animal. Everything that moves a fighter goes through the
one reset that puts the whole figure down together, harness included.

**A door is a hole you can see a long way through.** The line-of-sight rule
above is what makes each room its own fight, and on its own it very nearly
threw that away: an orc eighteen metres off in another room can see you
perfectly well the moment you line up with the doorway between you, and it set
off at once. Sight decides whether it can *keep* coming; a separate, short
notice range decides whether it starts. Two numbers, because they are two
questions.

**A symmetric blade is not a symmetric arm.** Either edge cuts, so the angular
drive used to take whichever of the target orientation and its half-turn was
nearer. For a hinged elbow the half-turn is a backwards-bent arm — with the hand
and the forearm's direction fixed, the elbow point is fixed too — so whenever a
swing left the swivel a quarter turn behind, the drive chose a pose the joint
limit forbids. At exactly a quarter turn the two tied and the torque reversed
every step, pinning the arm there, saturated, while the elbow drifted straight;
at straight the arm's inertia about its own length is almost nothing, the chain
flipped over, and the forearm spun at 150-170 rad/s. That was the snap on a
flick, and it was also why the orc's and the goblin's arms trailed even a slow
sweep by fifteen to forty centimetres. Without the fold the arm swivels round
the way a shoulder can, and arrives.

**A target that teleports is chased along the chord.** The drive pulls the hand
in a straight line to wherever the ghost is. Two radians round the shoulder,
that line runs inside the arm's own reach: the elbow folds shut on the way and
has to be hauled out straight at the far end. Moving the target along the arc
fixes the target; an orc hauling an axe still trailed it by three quarters of a
metre and caught up in a straight line through its own chest, which is why the
followed intent also waits for an arm that has fallen that far behind.

**The collider is not the body you can see.** Clearance was first measured
against the round torso collider plus a buffer. The chest is drawn 13cm deep
and the collider is 17cm all round, and near the shoulder the collider is
fatter still — so the guard itself, with the elbow resting against the side of
the ribs where elbows live, counted as buried. The search swivelled it out, and
since swivel is edge roll, a right-drag toward the body turned the edge by one
degree. The clearance is now measured against the drawn body, flattened front to
back — and since the forearm can twist, it no longer has to choose between the
ribs and the edge: the elbow goes where the body lets it, and the grip turns the
edge back to where it was asked.

**Nearest is not reachable.** The swivel search first answered "which clear
swivel is nearest the design" every step. When the clear arc on the elbow's side
of the chest closed up mid-swing it chose the one on the far side, and the
elbow's target swung straight through the ribs to get there. The live search
scores where the elbow could go by how much deeper than it already is it would
have to pass on the way, and by how far it is from the design and how long the
trip; probes, which ask about a held aim with no "on the way", still take the
nearest.

**Rapier adds up a body's inertia the wrong way round.** Combining several
colliders on one body, it moves each part's inertia to the shared centre of mass
with m(|d|² + d dᵀ) where the parallel-axis theorem says m(|d|² − d dᵀ). Two
parts offset *along* a weapon therefore gave it inertia *about* its own length
that no rod has: the spear came out at 0.265 kg·m² against a true 0.00016, as
hard to roll in the hand as to swing end over end, and the axe much the same. A
one-part sword was untouched, and with the weapon welded to the forearm nothing
could tell — the phantom mass just sat in the arm's roll and steadied it. It
surfaced only when the weapon could turn in the grip. The weapons now carry
mass properties worked out in `weapons.ts`, which agree with Rapier to the
fifth decimal wherever Rapier was right. Taking the phantom away exposed what it
had been hiding: an arm's roll about its own length is nearly weightless with
the elbow straight, and a freshly spawned goblin spun its spear at 900 rad/s.
The angular drives now let go of that roll near straight and keep it within what
its inertia can take everywhere else.

**Something light enough can only be held by an implicit drive.** A sword weighs
0.0002 kg·m² about its own length. An explicit servo on that is stable only if
it is soft, and soft, the grip could not hold against a spear shaft dragged
along the floor — friction at a 1.7cm radius rolled it up to 880 rad/s. Every
other drive here is an explicit, clamped torque; the grip is the joint's own
motor, which Rapier solves implicitly. Its motors take no force limit, but a
velocity servo is limited anyway: asked for no more than 20 rad/s, a weapon that
cannot turn at all — wedged in stone — gets `grip twist` of torque and no more.

And two about the harness rather than the game:

**A test can pass for years for the wrong reason.** `aimBladeAt` corrected its
aim by the whole measured error, on both axes, including the part of the error
that no aim can fix — a blade against a target inside its reach ends up a third
of a metre *past* it, which is not an error, it is a sweep going through
someone. Chasing it walked the aim point back toward the shoulder until the
bearing flipped and the sword ended up pointing behind its owner. It converged
anyway, for years, because the low beam happened to hold the blade down; raising
the beam for the orc exposed it. The same test then asserted that a swing takes
a limb off while aiming at the *chest* — the one part of the dummy with no joint
to cut it off at — and passed only because the drifting aim kept taking the head
off by accident.

**A test can lean on a bug.** "A spear held by the butt cannot be steered" asked
for a fifth less swing than one held choked up, measured as the weapon's whole
change of orientation — spin about its own shaft included. That spin was
Rapier's phantom inertia, and it grew with how far out the mass sat, so it did
much of the test's work. Measured on where the spear *points*, on the same
physics, the butt-held spear lagged by 0.81: never a fifth. The test now
measures the direction and asks for a tenth; the claim was true, just smaller
than the number that proved it.

## Tuning

Everything in the panel is live and saves to your browser. The four that matter:

| | |
|---|---|
| `max force` | The clamp. Drop it to 150N and the sword becomes too heavy to lift. |
| `arm strength` | How much of the limb's own weight the fighter holds up. At 0 the sword drags the arm down. |
| `max torque` | The angular budget. Keep it modest — a torque the swing can exhaust is what makes the blade trail. |
| `blade mass` | Inertia. Affects how hard the sword is to start and stop, not how hard it is to hold. It is a TOTAL: the weapon's own mass distribution is preserved and rescaled to it. |

The body adds four: `torso lead` (how far the chest turns ahead of a swing and
the shoulder slides to make room; 0 is the old rigid block), `secondary motion`
(lean, bend, shrug and head-tracking), `hips' share of a turn`, and `clearance
from body` (how far the target pose keeps off your own chest and hips; 0 turns
off both clearance layers). The angular drive adds `grip twist`: how hard the
forearm turns the weapon in the hand — weak, and a blow on the flat knocks the
edge off line. Input adds `flick speed cap` and `flick accel cap`: anything
slower reaches the arm untouched.

Movement adds `jump height` and `air control`. Presets: **heavy** (a sword that
fights you), **rigid** (a robot arm — useful as a control), **noodle** (too weak
to lift it). Try `rigid` for ten seconds to hear what the mechanic sounds like
when you take the clamp away.

The panel drives your arm only. An orc's force budget is its own, scaled from
its size.

## Deliberate behaviours

Some things look like bugs and are not:

- **You can plant the sword in the ground and get stuck.** Swing down hard, the
  tip grounds out, the arm props on it. Raise your hand and it frees. Emergent,
  correct, and very much in the spirit of the original.
- **The blade lags behind the ghost on a fast swing.** That's the torque budget
  running out. It's where the whip comes from.
- **Reach is capped short of full extension.** Near a straight arm the elbow has
  no leverage and the limb locks. A margin of 8cm, scaled to the body, keeps it
  always able to bend.
- **The torso cannot be severed.** It is what the dummy hangs from, so there is
  no joint to cut it off at. Damage still registers; it just has nowhere to go.
- **You can walk straight through the practice dummy.** A fighter is driven by
  setting its velocity each step, so it shoves lighter things aside rather than
  being stopped by them. Fighters do collide with each other.
- **The blade hangs angled up out of the hand.** The elbow sits below the
  shoulder-to-hand line, so the forearm — and the weapon held along it — points
  upward. From a 1.51m shoulder the tip rests around 2.1m. Rolling the edge over
  with a right-drag swings the arm's plane and brings it down; it is the single
  biggest thing to learn.
- **Swinging pushes you around.** A 420N drive against an 82kg body moves it, so
  a hard swing walks you half a metre off your mark. In mid-air, with nothing to
  brace against, it moves you considerably further.
- **The orc and the goblin never cut each other.** Their weapons pass through
  their own team. Friendly fire would be excellent and it is not here yet.
- **Backing into a wall fades you out.** The camera sits three metres behind
  you and a wall that close leaves it inside the stone, looking at the outside
  of the room. It is pulled in to the wall instead, and your own body — then,
  closer still, your arm — fades so that what you can see is the room rather
  than your own shoulder. Step forward and you come back.
- **An opponent in another room ignores you.** It has not seen you. Walk in.
- **At the far end of a cross-body cut the blade points back over your left
  shoulder.** The weapon continues the forearm, so with the elbow kept out of
  the ribs, that is where the forearm — and the blade — point. The forearm's
  twist keeps the *edge* where you asked, but where the blade *points* would
  take a wrist, and there is not one yet. The alternative was the elbow in the
  ribs.
- **The weapon turns in your hand when you have not rolled it.** That is the
  forearm keeping your edge while the body moves your elbow. Watch `grip twist`
  in the HUD: at the guard it reads zero.
- **Hold a big turn and you step.** The hips come round under the chest, and
  when they have turned far enough over planted feet, the feet follow — the
  leading one first.
- **The ghost hand can wait for your arm.** With *show ghost hand* on, a flick
  shows the ghost sweeping round rather than jumping, and slowing when a heavy
  blade falls far behind it. The mouse's aim itself is never touched.
- **Standing still gets you killed in well under a minute** by whichever of
  them you have walked in on, and much faster by both, if you manage to bring
  them together.

## Structure

```
src/
  main.ts            wiring, camera, who is in which room
  tuning.ts          every constant that shapes the feel
  core/
    loop.ts          fixed 60Hz accumulator
    physics.ts       Rapier world, and one collision slot per fighter
    renderer.ts      three.js scene
    interpolate.ts   render interpolation between physics states
  input/input.ts     pointer lock, accumulated deltas
  game/
    arm.ts           THE MECHANIC — read this one first
    weapons.ts       sword, axe, spear: masses, leverage, what bites, and inertia
    species.ts       the bestiary — a size, a weapon, a list of attacks
    anatomy.ts       one set of proportions, scaled to any body
    fighter.ts       torso, locomotion, the jump, and feet that stay planted
    posture.ts       how the trunk carries the arm: lead, girdle, lean, gaze
    clearance.ts     keeping the arm out of its own chest and hips
    motion.ts        the two filters: intent that must not lag, bodies that should
    arena.ts         three rooms built to be hit, and the doors between them
    combatant.ts     a fighter, their arm, and what a cut does to them
    ai.ts            the opponent's brain — mouse deltas, nothing more
    cutting.ts       swept-segment hit detection: how a weapon finds flesh
    dummy.ts         the practice dummy, and how it comes apart
    damage.ts        the damage curve
    skin.ts          the visible body: tapered shells over the capsules
    blood.ts         droplets, and the two faces a cut leaves behind
    impacts.ts       contact events -> impact quality
    targets.ts       collider -> name registry
    trail.ts         the swept arc
  ui/                HUD and tuning panel
tools/smoke.ts       headless harness driving the real modules
```

`npm run smoke` runs the real `Arm`, `Fighter`, `Arena`, `Dummy`, `Combatant`
and `Ai` against Rapier in Node — no WebGL, no browser, 143 checks in a few
minutes. It asserts the claim the design rests on: that the arm tracks the mouse
closely when free and *fails to* when blocked. If the second ever stops failing,
the mechanic is gone.

It also drives a real scripted swing all the way through to a severed limb,
takes a fighter apart and checks that a reset puts it back together — measuring
the joint anchor rather than the limb, because an arm attached to nothing still
hovers roughly where it belongs — jumps a fighter and measures where it lands, checks that an axe really does come
round slower than a sword on the same arm and the same command, shows that a
spear held by the butt swings markedly less far than a choked-up one, and runs
half a minute of live fight against each species to check it closes, swings,
lands cuts, and never exceeds the reach of its own arm.

It also holds the layout to its claims: that each subject is in its own room,
that a wall stops a line of sight and a doorway does not, that an opponent
which cannot see you neither moves nor swings — and that walking into its room
starts a fight. And it takes a joint apart to check that the cut reports two
faces to bleed from, that both are attached to something that is placed every
frame, and that the droplets fall, land and go.

And it holds the body to its claims: that the same cross-body sweep that went
twenty centimetres into the old rigid chest now stays out of it at three
heights, and a flick only grazes it; that nothing pushes on an arm at rest; that
the original flick no longer spins the forearm; that a drag reaches the ghost
with no lag at all and a flick arrives within a few frames; that the chest is
more than half turned before the hand crosses it while the hips lag behind;
that planted feet do not skate, step one at a time, and end up under the hips;
and that the shoulder a held aim settles to is exactly the one the opponent's
probes predicted.

And the grip: that each weapon's inertia is where its iron is — a one-part
sword exactly as Rapier had it, a spear that rolls like a shaft rather than a
pole; that the grip sits square when nothing needs it; that a roll toward the
chest turns the edge all the way without the body pushing or the hand moving;
that an elbow moved out of the ribs no longer takes the edge with it; and that
ten seconds of the worst input there is never spins a weapon in anyone's hand.

## Stack

TypeScript · Vite · three.js · [Rapier](https://rapier.rs) (Rust→WASM).

Physics is a fixed 60Hz accumulator with render interpolation — stiff PD drives
explode under a variable timestep. CCD is on for the weapon and forearm; without
it a fast tip tunnels straight through the thin post.

## What's next

Rounds and a reason to be in the rooms. Friendly fire. An off-hand that does
something — a shield, or the second hand a spear actually wants. Blood that
stays on the floor, and on the blade.
