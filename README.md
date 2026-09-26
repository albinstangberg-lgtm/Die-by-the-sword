# Die by the Sword — browser prototype

A physics-driven melee prototype in the spirit of Treyarch's 1998 *Die by the
Sword*: the sword arm is a simulated limb, not a set of attack animations. You
drag the mouse, the arm follows, and the blade's damage — and its bounce, its
lag, its refusal to go where you asked — comes out of the physics.

**This is stage 6.** Stage 2 asked whether swinging a sword at a wall feels
good. Stage 3 gave the swing consequences. Stage 4 put someone in the room who
swings back. Stage 5 gave you something to fight that is not a copy of you: an
orc with an axe and a goblin with a spear, both bound by the same physics.
Stage 6 stops them sharing a room — there are six rooms now, and gates
between them — and makes a cut look like one. Since then the body has learned to get
out of its own arm's way: the chest turns ahead of a swing, the shoulder slides
round the ribs, the head watches the blade, the feet step under a turn, the arm
no longer goes straight through the chest to get across it, the forearm twists
to keep the edge where you put it, the wrist bends to keep the blade pointing
where you aimed, and a hand raised overhead keeps its elbow under it instead of
turning the arm over. And a blow now lands with its weight: the swing that
puts a goblin on the floor does not move an orc. And nothing tells you what is
coming any more: an opponent makes each swing up as it throws it, aimed at
whatever of you is there, and the only warning is its weapon going back.
And now there is a second arm worth having: it holds still, it can carry a
shield you steer with the other mouse button, and the sword can go on your
back — the hand takes it there, over the shoulder — to leave a hand free for
a potion, which you walk over, get down to and take. The shield can go on
your back too, by the other hand over its own shoulder, to free that hand
instead. What you cut off an opponent — a head, an arm — and the weapon its
dead or severed hand was holding are yours to take the same way: you hold
them in your hand, F again puts them in your bag with your potions, and G
lets go of them. You can crouch under a
cut, climb a ledge, and vault what is waist high. And a body is a body to the
end: it walks at the hips and chest and breathes standing still, its feet step
round after it as it turns on the spot and shuffle out and in as it steps
aside, a fighter who loses a sword arm curls over the stump and holds it, and
one that dies goes limp where it stands and comes down in a heap.

And a fight flows now. A swing that meets nothing runs into the next, and one
that goes round can carry the whole body round after it on its heel — Shift
and a turn, which you have too. An opponent keeps its weapon where its last
swing left it and never quite still, draws back on its way in or while it
gives ground, meets a swing it sees drawn back with its own weapon, hops
clear, lets go of a swing when a cut hurts, limps on a cut leg — as you do —
fights differently once it is badly hurt, and shows you its weapon from out of
its reach.

And nothing just walks up to you. A double tap of W, S, Q or E is a quick step
that way — twice walking pace for under a fifth of a second, then a moment's
rest — and everyone has it: an opponent closes the last of the gap with one as
its weapon goes back, straight in or on a slant round your side, goes straight
back out after swinging, and gets out of the way of your swing with one. The
goblin is never still; the orc hardly ever bothers.

And everything that wants to kill you is behind a gate now. The rooms open off
one hall, and each has a gate in the wall between, with a lever on the hall's
side of it. F goes to a lever as it goes to anything, and the hand takes hold
of the handle and pulls it down — jointed to the bar, the arm's own clamped
drive against the lever's spring — until it catches. The gate grinds up into
the gatehouse over it, and whatever is behind it hears it go and comes out to
see why: two orcs from the pen, two kobolds from the warren, three goblins
from the cell, or the ogre from the den. Which, and when, is up to you (see
[The testing area](#the-testing-area)). The hall between them has the dummy
in it, and things to jump, vault and climb.

The kobold is a little over a metre of scaly, skittish thing with a hatchet,
and the ogre is two and a half metres of it with an iron-bound oak club that
cuts nothing at all. It hits you and you go flying (see
[The bestiary](#the-bestiary)). Everyone has a face now, too, and something
on: your tunic, bracers and boots, the orc's harness and tusks, the goblin's
rags, the kobold's horns and tail, the ogre's hide — none of it ever hit by
anything, and all of it fading with the body when the camera is backed into a
wall. And going over a wall or up onto a ledge is a body doing it: the vault
springs off the near side, plants a hand on the top and swings the legs round
over it, and the climb hangs off the edge, heaves the chest over and brings a
knee up onto it.

```
npm install
npm run dev      # http://localhost:5173
npm run smoke    # headless physics harness — 444 checks, no browser needed
npm run build    # production bundle
```

## Controls

| | |
|---|---|
| **mouse** | the sword arm |
| **right-drag** | hold the right button, move left/right to roll the cutting edge |
| **left-drag** | hold the left button: the mouse moves the other arm — and the shield on it — instead |
| **wheel** | reach — extend and retract, for whichever arm the mouse is on |
| **W / S** | forward, back |
| **A / D** | turn (arrow keys also work) |
| **Shift** | with A / D: turn on your heel — three and a half times as fast, enough to carry a swing on round with you |
| **Q / E** | sidestep |
| **W W, S S, Q Q, E E** | double tap: a quick step that way — a metre or so in under a fifth of a second, then a moment's rest before the next |
| **Space** | jump — or, with **W** held at a ledge, climb it |
| **V** | vault whatever is in front of you, if it is waist high |
| **C** | hold to crouch |
| **X** | sword on your back, and back in your hand — or, holding an opponent's weapon, take it up and fight with it, and put it up again |
| **Z** | shield on your back, and back on your arm |
| **F** | go and pick up what is nearby — a potion, a shield, a piece of an opponent, their weapon — or pull the lever beside a gate; sword on your back first; F again, or any key, calls it off. With something in your hand: put it in your bag |
| **G** | let go of what is in your hand — in the middle of a swing, throw it |
| **H** | drink a potion — takes a free hand |
| **B** | open and close the inventory |
| **1–9** | with the inventory open: use what is on that line — drink a potion, take a piece or a weapon out into your hand |
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
it's live. It is also how you guard over your head: raised, the blade stands up
over your hand, and rolled to the left it lies across your head.

Left-drag is the same kind of switch for the other hand: while it is down, the
mouse and the wheel move the off arm, and the sword holds where you left it.
The HUD says `SHIELD` while it's live.

## How the mechanic works

Three pieces, in order of importance.

**1. A kinematic ghost hand.** Mouse deltas accumulate into a target point on a
sphere in front of the shoulder. It is pure intent: no collision, no mass, it
goes exactly where you point. Turn on *show ghost hand* in the panel and it is
the cyan wireframe — on your own arm only. Every opponent has one too, driven
by the AI's mouse, and none of them is ever drawn.

**2. A physical arm.** Upper arm on a spherical shoulder, forearm on a hinged
elbow, weapon in a hand that turns about its length and bends at the wrist.
Dynamic bodies with real mass, subject to gravity, inertia and collision.

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
  real one does. The grip is the joint's own motor, pushed only as hard as
  `grip twist` allows.
- **The wrist bends.** The twist keeps where the edge *faces*; where the blade
  *points* is the forearm's, and with the elbow moved out of the ribs the
  forearm points somewhere else — at the far end of a cross-body cut, up to
  sixty degrees off, back over the other shoulder. The wrist bends the weapon
  back onto the line you aimed along, up to about fifty degrees, so the blade
  stays within a degree of it through most of a cross-body cut and within
  about eight at the very end. Where the body is not in the way it does
  nothing: the weapon continues the forearm exactly, as it always did.
- **Flicks travel the arc.** A flick used to teleport the ghost two radians round
  the shoulder, and the drive dragged the hand along the straight chord to it —
  which runs inside the arm's reach. The followed intent now passes anything a
  hand does at a human speed straight through, rounds off only what no arm could
  do, and waits for an arm that has fallen far behind rather than running away
  from it.
- **The hips take their time, the feet stay put.** The spine takes a turn fast,
  the hips take their share slowly underneath, and the feet stay planted while
  the hips turn over them — until they are wound up too far, and then the
  leading foot steps, then the other. Turning on the spot, with A and D or on
  your heel, is that kept up: the feet step round after the hips one at a
  time, the leading foot first, quicker the faster the turn — five or six
  steps a second at walking turn — each lifted clear of the floor and put down
  as far ahead of the hips as they will have gone past it before it lifts
  again, so a leg twists no more one way than the other. And a planted foot
  stays where it was put, not only the way it pointed: the hip goes round
  over it and the leg leans out to it. A foot the hip has simply moved off —
  a body pushed about by its own swing — steps back under it.
- **The trunk walks with the legs, and breathes.** Walking, the hips turn about
  six degrees with each stride and the chest turns back against them, the way
  arms swing against legs; the hip over the swinging leg drops while the chest
  stays level; the body dips three centimetres as the feet spread and rises as
  they pass; and it leans into walking forward and out of backing up. Standing,
  the chest and shoulders rise and fall with a slow breath. None of it is
  simulated — it is the stride's own phase, shaped — and it is placed through
  the same pose as the chest's collider, the neck and the sword shoulder, so
  the arm walks with the chest you can see rather than beside it. The legs
  take the hips' turn and tilt back out at the hip, so the feet stay where
  they were going.
- **The legs go the way the body does.** The stride swings the legs along the
  way the body is actually going, relative to the hips — a stagger included.
  Backing off, the foot in the air goes back. Sideways a stride is a shuffle:
  the leading leg steps out, the trailing one closes up to it, and the feet go
  wide and narrow on their own sides and never cross, in shorter, quicker
  steps than a walk. The hips stay square over it, and the body comes down a
  few centimetres between the feet, onto knees that straighten as they go
  wide, so both feet are on the floor at the widest. Going from one way to
  another, the stride comes round over a tenth of a second.

Three rules keep all of it from costing the arm anything. What makes room for
the arm — the chest's turn, the hips, the shoulder sliding round the ribs —
reads *intent*, never the physical arm, so the body leads a swing instead of
trailing it; only the lean, bend and shrug also react to the real hand's
acceleration and the drive's strain, and those are clamped small and sprung, so
they can nudge the shoulder but never steer your aim. Your aim stays in the
hull's frame, so turning the chest moves the shoulder and nothing else: the
hand still goes where you pointed. And a held aim settles into one posture, so
the probes an opponent aims with solve against the body it will actually have;
walking and breathing are motion, and are left out of it. Set `torso lead`, `secondary motion`
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

All of it comes to 1.47 points of damage per metre a second past the threshold,
for a sword's edge square on at its percussion point — the number that put the
damage back where it was once a weapon's speed was measured about its centre of
mass (see *A body's velocity is its centre of mass's*, below).

There is no light attack or heavy attack. The only way to raise the number is to
swing faster, with the edge leading, and connect on the right part of the weapon
— which is to say, to actually cut properly.

### A sword stops where it lands

A blade collides with a body the way it collides with stone and with another
blade: the other team's bodies, and the practice dummy. A cut lands on the first
thing it meets and stops there. An arm held across a chest takes the blow the
chest would have taken, a shield takes it before either, and a blade that meets
a hip does not carry on into the ribs. An ally's body it still passes through,
and so does a weapon nobody is swinging — in the hand of someone lying on the
floor, or on an arm that has come off: it lies on the stone and meets other
blades, and bodies step over it.

For a long time it was the other way round, and for a good reason. Modelling
flesh as something a blade collides with means the solver brakes the blade the
moment it touches, and a braked blade cannot cut: the swing that should have
arrived at 12 m/s registered two dozen grazing contacts at 3 m/s while the sword
wiped across the target like a windscreen wiper. So blades passed through
flesh, and a hit was found by casting the blade's own line from where it was
last step to where it is now.

What made that necessary is gone. Every hit is measured from the blade's motion
as it was *before* the step it landed in (see *Contact events arrive too late to
measure a hit*, below), so a blade the solver stops dead still scores the speed
it arrived at. In the harness a forehand into the dummy arrives at 9.6 m/s at
the tip, is scored at 9.1 m/s where it touched, and is down to 1 m/s a step
later. The sweep is still there, as a backstop for a blade that ends up inside
someone anyway — a body stepping onto it — but nearly every blow is the
solver's now.

What it costs is reach and multiplicity. You cannot swing from inside your own
reach any more: close in, the blade meets the near surface with the strong of
the blade by the hand, where there is no leverage, so a sword does its work
from a little over a metre. And a swing cuts one thing where it used to cut
everything along its arc — yours and theirs alike. An opponent's blow that went
through your arm and on into your body used to land twice; it lands once. Stood
still in front of the swordsman you used to be dead in forty seconds; you are
on about half. Much of what this document says about how hard the opponents
hit was measured while blades passed through bodies, and is an upper bound
now.

### Weight

Damage asks how well a blow was thrown. [`balance.ts`](src/game/balance.ts)
asks how *hard* it was, and the answer depends as much on what it lands on as on
what threw it. There is no poise bar and no stagger resistance: it is momentum
going into a body of a given weight, and whether that body can step out of what
it was given.

```
body's change of speed = closing speed × m_blow / (m_blow + M)
```

- **the blow** — the weapon, and the arm swinging it. A driven arm is stiffened
  to swing and arrives as one piece with what it holds, the way a boxer's
  half-kilo fist lands like three. Your sword lands with 5.6kg behind it, the
  orc's axe with 11.2, the goblin's spear with 2.7. A limp or severed arm puts
  nothing behind its weapon.
- **the body** — everything still attached to it: 38kg of goblin, 96 of you,
  173 of orc. The blow meets it the way two masses meet when they stick, so no
  body is ever sent faster than the blow that hit it.
- **footing** — planted feet soak up the first of it. Friction holds μ·M·g for
  the thirty-odd milliseconds a blade takes to cross a body, which comes out as
  a speed, about a quarter of a metre per second, the same for anything that
  stands — and more than most blows leave an orc with.
- **leverage** — a blow off the middle of a body turns it as well as pushing it.
  High, it goes over its feet; low, the feet go out from under it.
- **balance** — what is left is set against the speed that body can step out of,
  which goes as √(g × leg length): the Froude number every walking animal
  shares. A goblin cannot simply be sturdier for its size.

Past two fifths of its balance a body **staggers**: its feet scramble, it
steps back while they catch it, and whatever it was winding up is gone. Past
all of it, it **goes down**: limp, a ragdoll (see *Knocked down*, below), and
it falls the way the blow sent it — over its feet if it was hit high, onto its
back if its legs were taken. It lies there most of a second, pulls itself
together, is driven back up round its feet the way it is walked — by its
velocity, never placed — and takes its weapon back up to the guard. Only the
sideways part of a blade's blow counts: one straight down drives a body into
the floor, and the floor pushes back. A club is another matter (see
[Sent flying](#sent-flying)).

The same swing — your sword, 8 m/s into the upper chest:

| | | |
|---|---|---|
| **the goblin** | 1.03 m/s into 38kg | goes over |
| **a swordsman** | 0.44 m/s into 96kg | shoved a centimetre |
| **the orc** | 0.25 m/s into 173kg | doesn't budge: its feet take nearly all of it |

The orc does not have a stagger resistance. It has 173 kilos. It is also why
*committed to everything it starts* is literal: a stagger is the only way to
take a swing off something once it has begun, nothing you can swing moves an
orc that far, and a goblin's thrust you can knock clean out of it. The other way
round, the orc's axe staggers you about one blow in ten and now and then puts
you on the floor, and the goblin's spear, with under three kilos behind it, has
never moved anyone.

A blow that fails to cut still arrives with all its weight. The flat of your
sword will not open a goblin, but it will put one on the floor. And a blow that
moves nothing is still felt: the chest is thrown away from it and the
posture's lean and bend springs bring it back — the goblin is jerked round, the
orc barely flinches. The impact readout says what each blow did, and how many
kilos it went into.

The practice dummy takes a blow like a punching bag, through its middle
wherever it lands, and its mount drags, so it rocks and settles inside half a
second.

### Sent flying

A blade goes in and stops, and what a body takes from it is what a blow that
sticks can give. The ogre's club does not stick. Three things set it apart
from a blade of the same weight and speed, all in
[`balance.ts`](src/game/balance.ts):

- **it comes back off you.** Oak bound in iron rebounds, and a blow that
  bounces gives the body more than one that stays: along the line it drove in
  on, the body is sent (1 + rebound) times as fast as a sticking blow would
  send it, and the club's `rebound` is 0.4. Square on, at the same weight and
  speed, a club throws a body at 3.84 m/s where a blade throws it at 2.74.
- **it takes you where it was going.** Its speed across the body goes with the
  body too, as far as rough wood and iron studs can grip — never faster than
  six tenths of what it presses in with — so a club that glances off drags a
  body at 0.28 m/s where a square one throws it at 3.84.
- **coming up, it lifts you.** A blade's blow counts only along the floor,
  since one straight down drives a body into the floor and the floor pushes
  back. A club's upward part is lift, and a body lifted has nothing under it to
  step out of the rest with, so lift counts against balance as a shove does.

And the ogre puts itself behind it: a quarter of its 317 kilos, on top of its
arm and the club, makes 102 kilos of blow, against 11 behind the orc's axe and
5.6 behind your sword. When that puts you down, all of you goes together — the
chest, the hips, the legs, the arm and the sword in it are all given the same
kick — so you go up and over as one body, rather than having your chest
snatched out from under your legs. Swung up through you in the harness's cell,
it puts you on the floor half a dozen times in under a minute, throwing you as
far as three to six metres, and you get up again with everything still on. In
half a minute of an ordinary fight it floors you five to eight times and takes
more than half your health. A kobold's hatchet has yet to put anybody down.

### Weapons meeting

A blade that met another used to be a parry and nothing more: the solver
stopped both, and a driven arm had its weapon back where it was sent inside two
centimetres. Now the two blows are weighed the way a blow on a body is — each
weapon and the arm behind it, meeting and sticking — and the speed they share
afterwards says which one carried on and which was sent back:

```
shared speed = (m₁ × a₁ + m₂ × a₂) / (m₁ + m₂)      along the line they met on
```

The side with more weight times speed behind it carries on its way. The other
is **knocked aside**: its arm loses some of its strength for a moment — more,
and for longer, the harder the knock, up to `weapon knocked aside` (0.85) of it
and back in full within 0.6 seconds — so the weapon is carried off, and comes
back to where it was being aimed. It comes back under control, not as a swing:
until the hand is back where it was sent, its drive is damped four times
harder. Brought back at full strength, a guard the orc's axe had beaten aside
came back through the orc's forearm at cutting speed, and standing still behind
one took its arm off in four minutes out of ten. The aim itself is never moved;
your mouse is still where you left it. That moment is an opening, and it works
both ways:

| | knocked | |
|---|---|---|
| a goblin's thrust, 2.7kg at 8 m/s, into your sword held still (5.6kg) | your sword, at 2.6 m/s | it still stops the spear |
| your sword swung at 9 m/s into the goblin's spear held still | the spear, at 6.1 m/s | a clean opening |
| the orc's axe, 11.2kg at 8 m/s, into your sword | your sword, at 5.3 m/s | a guard against an orc goes where the axe sends it |
| your sword at 9 m/s into the orc's axe held still | the axe, at 3.0 m/s | even an orc's guard can be beaten aside |
| two equal swings meeting | neither | they stop each other |

An opponent reads it off the arm, as you do. Its own weapon knocked aside, it
loses the swing it was drawing back for or throwing, and starts nothing new
until its arm is its own again; the time its guard takes to come back up behind
a weak arm is yours. Yours knocked aside, it steps in on it — every time. The
readout says when it was your weapon, or theirs by you.

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

**And a hit says how hard it was.** A blade that meets stone throws gold
sparks. One that meets flesh and does damage throws the same streaks in red,
flung along the cut, and blood with them — both as many, and as far, as the
damage is worth. A scratch is a few streaks and a spatter; a clean sword cut,
6 to 12 points, a burst; the orc's full chop, around 25, a fistful thrown
across the room. A flat slap does nothing and throws nothing, so the burst
agrees with the number in the HUD, and you can read a hit without looking
away from the fight. It is everyone's: an opponent's blow on you bursts too.

Which hits bleed and which throw sparks is not a lookup of names. Flesh is what
the blade is allowed to cut — the other team's bodies and the practice dummy,
the same collision groups its sweep looks for — and anything else it meets is
stone or steel.

### Losing the sword arm

Cut through the shoulder or the elbow and the arm is gone for the rest of the
fight. The body curls round the wound: it leans over it, bends toward that
side, turns that shoulder forward and in, hunches it, and gives a little at the
knees. The other hand goes to it and holds it — the socket, or what is left of
the upper arm, held in against the ribs rather than left to swing — and stays
there while an opponent backs away from you. It is steered the way a climb
steers a hand onto a ledge, at a point on the body rather than on the stump,
which swings: a hand sent after the stump itself flailed. A short arm grips
the stump higher up; a goblin's shoulders are wide for its reach.

A hand on a ledge, a shield on that arm, or a player steering it with the left
button keeps it; everything else, the wound gets.

### Knocked down

A body knocked over is a ragdoll for as long as it is down — the same one a
dead body becomes, below: the walking capsule switched off, the hips come away
on a waist that bends, the legs simulated, the neck hanging on a range. But it
is not a dead one. It goes over **braced**: soft motors in the waist, hips and
knees hold it more or less straight, so it goes over as a body rather than
folding up where it stood, and they let go a quarter of a second after it lands.
Then it lies limp. Before it gets up it **pulls itself together** on the same
motors — the waist straightens under the chest and a knee draws up — and then
the ragdoll is taken apart, and what gets up is the hull: the chest, which
never stopped being it, with the hips and legs drawn out of how they lay into
the living pose over the first quarter of a second, so nothing jumps. The
walking capsule stays off until it is on its feet, since lying along the chest
it would come back on half in the floor.

Down, it is still a body. The hips on the floor can be cut, a blow to it moves
the piece it lands on and drags the rest after it, and knocked flat again on
its way up it goes limp again from wherever it had got to. Killed where it
lies, it simply stays down.

### Dying

A body with nobody in it goes limp — all of it. The walking capsule that held
it up is switched off, the hips come away from the chest on a waist that bends,
and the legs stop being posed and are simulated, on hips and knees that only go
the way a person's do. The head, both arms and the weapon hang from the joints
they always had, the neck given a range so a dead head cannot turn right round.
Nothing is placed and nothing is driven: it goes on the way the killing blow
sent it, over the way a blow high or low puts a body over, a little way off
true whatever hit it, and the floor does the rest. The meshes are the living
figure's, turned each frame to lie as the bodies do, so the belt, the hip and
knee balls and the feet come down with it. A reset stands it back up whole,
with nothing left over in the world.

## The other arm, and what you carry

### The other arm holds still

The off arm used to be held in a pose by a weak spring on each bone, and it
flopped: stood perfectly still, both bones spun about their own length at a
steady 37 radians a second, and the first shove of a sidestep threw the limb
over to the wrong side of the body. It was the sword arm's roll singularity
(see the findings) on the arm nobody had gone back to. The head, held the same
way, buzzed about its own vertical at 15.

It is the sword arm's mechanic now, on a smaller budget: a ghost hand solved
from the off shoulder, the same two-bone elbow, a clamped PD drive pulling the
real hand after it, the limb's weight fed forward. It is damped against the
ghost's own motion, so a body that walks does not leave its hand behind. And
every gain is held inside what an explicit step on that bone's inertia can take
about each of its principal axes ([`drive.ts`](src/game/drive.ts)) — the one
rule the old spring broke. Empty, the hand rests in front of the belly on a
third of the sword arm's budget, loose enough to swing a little when you turn
and settle back. Standing still it now reads 0.00 rad/s.

### The shield

A round shield of wood and iron, 3.2 kilos, strapped to the off forearm as a
collider on the forearm's own body — so it goes wherever the forearm goes,
including onto the floor if the forearm is cut off. It has a blade's collision
membership but not a blade's filter: it meets the world and other blades, and
nothing that bleeds. So an enemy's cut that finds it is stopped by the solver
exactly as a parry is, and is never taken for flesh. It does no damage and
takes none.

What it cannot do is make a blow weigh less. A blocked blow is weighed like any
other (see [Weight](#weight)): an axe caught on a shield still staggers you, it
just leaves you whole.

With a shield on, the off arm takes the sword arm's whole budget and holds a
guard across the chest, the elbow out and forward so the forearm — and the
shield on it — runs across the body and faces ahead. Hold the left button and
move the mouse to put it somewhere else; let go and it stays there, as the
sword does. Held still at its guard, against opponents that do not know it is
there, it takes six to nine blows a bout; in the harness a dozen level
forehands at a chest behind it do a fiftieth of the damage they do without it.
Where it goes is up to you.

There are two. One hangs on a rack against the entrance's east wall: take it
down to practise with and hang it back to fight without, as often as you like.
The other lies in the far corner of the pen, past its two orcs.

### The shield on your back

**Z** slings the shield on your back and takes it down again, and the other
hand does it, the way the sword hand does the sword. Slinging it, the hand
takes the shield up over its own shoulder, still strapped to the arm and
under the arm's own clamped drive; there it lets go, and the shield swings
round onto your back as the hand comes back down to hang in front of you.
Taking it down, the hand goes up over the shoulder for its rim and brings it
round onto the forearm, into the guard. A little under a second each way. The
elbow goes up and forward for it and the hand may fold in nearer the shoulder
than an aim ever lets it, as the sword hand's does going for its grip; only
the shield between the hand and the back is placed, eased from where the hand
let go of it to where it is going.

On your back it lies across the shoulder blades, face out, low enough that
the sword's hilt stands clear over its rim and far enough out to lie over the
scabbard rather than through it — and it still stops blades, the ones that
come from behind. There it is a collider on the hull that carries the chest,
placed each step where the posture has the chest, as the torso's own collider
is, so it covers your back through every lean, turn and crouch. It meets other
blades and nothing else: a cut across your back stops on it as a parry does,
and it never catches on a door frame. A blow stopped there is weighed like
any other — it can still stagger you — and the weight is the shield's too:
3.2 kilos more for a blow to move, counted where the blow is weighed rather
than put on the hull, which was tuned without it. In the harness a dozen
level cuts across the shoulder blades do a ninth of the damage with it there.

It guards the back and nothing else. The point of a cut to the front can
reach round the hips and clip the inside of its rim; the solver stops the
blade there as anywhere, but that is a blade tangled behind you, not a blow
the shield caught, and it spares your front nothing: which side of the boards
the blade touched decides it. What the shield on your back buys, besides, is
the hand: with the shield there and the sword in your hand you can drink
without putting the sword away.

It is still the one shield. You cannot take another while it is on your back,
and the rack takes it back from there as readily as from your arm. A ledge
under your hands, a fall or a cut finishes a sling where it had got to: a
shield still on the arm stays there, one on the back stays there, and one
between the hand and either is where it was going. With no arm to take it
down with, it stays on your back.

### The scabbard

**X** puts the sword on your back, hilt over the sword shoulder and point toward
the other hip, and takes it out again — and the hand does it. Putting it up,
the hand takes the sword up over the shoulder, still in its grip and under the
arm's own clamped drive, so a sword on its way to your back is a sword until
its point is in the mouth of the scabbard. Then the point goes back over the
shoulder and down, the blade slides home, and the empty hand comes back to
wherever the mouse has it: about a second. Drawing is the same backwards: the
hand goes over the shoulder to the grip, draws the blade up out of the
scabbard, and brings it forward over the shoulder into its own line, where it
is jointed back on across no gap.

Only the part between the mouth and the hand is placed. The grip in this game
runs along the forearm, and no wrist turns a blade point-down behind its own
head, so from the moment the hand lets go of the joint until the blade is home
it is carried along the chest — and the hand is guided onto its grip all the
way, within a few centimetres. Anything that takes the arm away halfway — a
cut, a fall — finishes it: a sword still in the hand stays there, one still on
the back stays there, and one between the two goes home.

On your back it is out of the world: the joint that held it in the hand is
taken out, and it rides the chest as a body nothing can touch, so it cannot
cut, parry, or snag a door frame. It used to ride a step behind a body on the
move — five centimetres out of the scabbard at a walk — and now stays within a
few millimetres of it (see the findings). The hand is empty and the arm still
goes where the mouse sends it.

An empty hand is a different arm. The drives were tuned on a hand with a sword
in it; empty, the same gains shook it back and forth every step at the clamp.
It gets half the linear drive and the same inertia-bounded turning as the off
arm, and holds still.

### Picking things up, and potions

**F** goes and gets the nearest thing in sight within a few paces. The body
walks over — through the same keys you walk it with, so the same feet and the
same walls apply — and turns so the thing is under the sword hand. On the floor
it gets down to it: a squat as deep as the legs go, bowed well over, which on
these proportions is what it takes to get a hand to the floor at all. Then the
hand reaches for it, guided there under the arm's own drive, so it gets as
close as the arm does; what it has hold of comes up with it, and only once the
body has straightened is it yours. A key of your own — any you were not
already holding — calls it off, and so does F again, X, or a blow.

The hand that takes things is the sword hand, so the sword has to be on your
back first, and picking something up in a fight costs you your sword and a
couple of seconds with your head down. The prompt at the bottom of the screen
says what F would do.

Potions go in your inventory. **H** drinks one, and that takes a free hand:
the sword hand with the sword away, or the other hand with no shield on it —
on your back will do. A potion gives back two fifths of your health over two
seconds rather than at once, so drinking in the middle of a fight is a bet on
those two seconds. There is one by the rack, and one at the back of the
warren, the cell and the den.

### What you cut off, and their weapons

Whatever you cut off an opponent can be taken like anything else lying about:
a head, an off arm — whole, or an upper arm and a forearm if the elbow went
first — and a sword arm or forearm. So can the weapon a hand was holding once
that hand is cut off or the body it belongs to is dead: the orc's axe. A hand
like that keeps hold of its weapon as it falls, and lets go of it as you take
one or the other — the joint that held it goes, and the fist stays with the
arm — so the forearm and the axe are two things to take. Where they lie
together F goes for the weapon first. The prompt names what it would take —
*F — take the orc's axe* — and F goes and gets it, down to the floor for it,
the hand on it.

And you keep it in your hand. A potion goes straight into your bag, being for
using; a head or an axe is held, with the sword on your back, until **F**
again puts it in the bag or **G** lets go of it — or throws it, if your arm
is swinging. Held, it takes the hand: F
picks up nothing else — it offers to bag what you hold instead — and it is
not a hand to drink with. **X** lets go of it to draw your sword, and so does
anything else that takes the hand away: a blow that puts you down, a cut.
Held is not wielded: what is in your hand is out of the world, and the orc's
axe in it cuts nothing — until you take it up.

### Wielding what you took

Holding an opponent's weapon — the orc's axe, the goblin's spear, the
swordsman's sword, and whatever anything carries that comes after them —
**X** takes it up, and you fight with it. It is
not a skin on your sword: the body in your hand is given the axe's colliders,
the axe's 3.65 kilos and the axe's shape, as they were made for the orc —
an axe is an axe, whoever's hand it is in — and jointed into your hand the way
your sword is drawn into it. So it swings with the axe's inertia on your arm's
strength, which is a man's, not an orc's: it comes round slower than your
sword and commits you to every swing, and it cuts with the axe's edge and
heft. The goblin's spear takes up the same way and bites with its point, and
is thrust from a spear's distance: from a sword's, its point is past the
target before the thrust begins, and what goes into it is the shaft, side on.
Nothing here is written for the axe or the spear; it is written for what a
weapon declares — its parts, its mass, its edge or its point — so a weapon
added to the game can be taken up the day it is added. Your sword stays
in its scabbard, drawn there, and the orc's axe itself stays out of the world
while the arm has it.

**X** again puts it up — held in your hand again, your sword on your back as
it was, with the weight the panel gives it. **G** lets go of it where it is in
the hand, turned as it is and moving as it is — in the middle of a swing, that
is a throw; **F** puts it straight in the bag. Put down, it is a weapon nobody
is swinging again, and cuts nobody. A knockdown keeps it in your hand, as it
would your sword; a cut
takes it with the arm. A reset puts your sword back in your hand and the axe
back in the orc's.

These are physical, unlike the potions. They fell where the cut threw them
and lie where they came to rest, so where one is is asked of its bodies every
step. Taken, a piece is the very bodies the fighter was made of taken out of
the world — disabled and hidden, joints and all — and what you hold is a copy
of it, so the body bowed over it does not kick it about. A reset finds every
piece where it expects it, on the floor, in your hand or in your bag, puts it
back on whoever lost it, and the weapon back in the fist.

A weapon nobody is swinging cuts nobody — one in a hand that has been cut
off, one let go of, one falling — so the axe you drop does not take your foot
off. Only an opponent's parts: nobody goes back for their own arm.

### Throwing what you hold

Let go of, a piece leaves your hand as it is in your hand: where the copy in
the hand is, turned as it is, and moving as the hand is. So **G** from a still
hand drops it at your feet, and **G** in the middle of a swing throws it — the
way your hand was going, as fast, and turning as your forearm was. Swing
overhand and let go as the arm comes over, and a head goes four or five metres;
sweep across and let go, and it goes across; an underhand swing lobs it. Your
arm at full pelt puts five to seven metres a second into the hand, and that is
all a throw gets: nothing is added, so a throw is exactly as good as the swing
behind it. The HUD says *threw* when it left
your hand at more than two and a half metres a second, *let go of* when it
only dropped.

The whole piece takes the palm's speed, and spins about its own middle with
the forearm's spin. A rigid thing on the end of the forearm would really have
the speed the forearm has where its middle is, which is not the palm's — but
what is in your hand is held however it lay on the floor, and a sword lying
back along your arm would fly backwards off a swing forwards. So it goes where
the hand goes. A whole arm goes as one, its elbow holding in the air.

It starts inside your hand, so for the moment it takes to leave it passes
through you — your arm, your body, your shield — and once it is clear of you
it meets you like anything else. It meets everything else from the start, and
a wall stops it: thrown at the stone a pace off, it bounces back into the
room. A head or a limb knocks into whoever it hits, as the weight it is; a
weapon, being one nobody is swinging, meets only the floor, the walls and
other blades, and goes through a body as if it were not there.

The copy in your hand is not in the world, though, and goes through walls and
the floor with your hand; the bodies cannot. Where letting go of it where it
is would put any of it in the stone, it is put down in front of you instead:
from your hand's height, as far out as a pace, lying away from you and short
of any wall — or, with no room ahead for the length of it, a spear facing a
wall, across your front toward whichever side has more floor — to fall to the
floor.

### The inventory

**B** opens it and closes it: what you have on — where the sword is, where the
shield is, what is in your hand — and what is in your bag, numbered. Potions
are one line, however many; each piece of somebody, and each weapon, is a line
of its own. With it open, the number beside a line uses it: a potion is drunk,
by the same rules as **H**, and a piece or a weapon comes out of the bag into
your hand, if the hand is free to take it. The fight does not stop while it
is open, and the mouse is still your arm: looking in your bag in the middle
of a fight costs what it costs.

### Pulling the lever

The lever beside a gate is taken hold of rather than taken. **F** goes
to it as it goes to anything — the body walks over and turns square to the
wall, and the hand goes up for the handle under the arm's own drive — and once
the hand is within three centimetres of it, it takes hold: a joint between the
hand and the bar, made where the hand has got to, so that it has nothing to
pull together. Then the hand's ghost is taken down the arc the handle goes
round, and on past the bottom, and the arm follows it as it follows anything.
The lever is two kilos of iron on a pin, sprung up against its stop, and it
takes about thirty newtons at the handle to bring it down to the catch. The arm
pays that in lag — the hand trails its ghost by five to seven centimetres all
the way down — and the body leans into it. Just over half a second after the
hand takes hold, the lever is past the catch and stays down, the hand lets go
of it, and the gate beside it starts to go up.

Nothing throws it but a hand. A blade goes through it, as it goes through the
door frames — a lever an axe could hook, or knock over in the middle of a
fight, is one more thing to go wrong at the height a weapon is carried — and
it is the sword hand that pulls it, so the sword has to be on your back first,
as for anything F does. Let go of short of the catch — a key of your own, a
blow — and it springs back up to its stop, and nothing opens. Once it is down
it stays down, and the gate stays up, until a reset.

### Crouching

Hold **C** and the hips sink 38 centimetres, the chest tips forward over them,
and everything above them goes down with them: the chest and its collider,
the shoulders the arms hang from, the neck, the head. The legs bend under it by
a two-bone solve that keeps the feet on the floor. The hull that walks does
not change; it is invisible and no blade finds it, so what a crouch takes out
of the way of a swing is the body you can see and cut. Crouched you walk at
under half speed. An opponent aims at wherever your head and chest are, while
it draws back — so a crouch after the swing has gone is a crouch under it.

### Climbing

Moving at a ledge, **Space** climbs it rather than jumping: anything with a top
between a knee and as high as hands that have jumped for it can reach —
two metres and a bit — and room on top to stand. The body is driven up the face
and over the edge by its velocity, the way it is walked and got up off the
floor, never placed, so anything in the way still has its say. The hands go on
the edge on the way up: the other hand always, the sword hand too if the sword
is on your back. A hand with a sword in it lifts the sword up and out of the
way instead, because held at the guard, a body driven up a face swung the blade
into the edge. A wall is no ledge, and a pillar is no ledge: there is nothing
on top of either to stand on. The hall has a ledge in its south-west corner,
a metre and a half up, and a crate against it to go up by in two.

And it goes up the way a body does. It takes hold of the edge and hangs off
it with its feet still on the face, pulls itself up until its hips are at the
top, throws its chest out over the edge, and brings one knee up onto it, then
the other foot, and stands. The knee stays down and the foot tucked under the
hips until the hips have come up past the top, so the legs stay out of the
face on the way: the harness lets neither go more than two centimetres into
the stone. The poses are keyed to landmarks along the way up — the hands on
the edge, the hips level with the top, the body clear of it, standing — the
same landmarks the body is driven through, so it is where its pose says it is
at every one of them.

### Vaulting

**V** goes over something between knee and chest high, rather than up onto it.
It asks the stone first, the same stone footwork asks: something at knee height
within a stride, a top between a knee and a chest when looked down on, a far
side within a pace and a half, and floor to land on with nothing overhead. A
wall fails the top, a pillar fails it too, and with nothing to vault the key
does nothing. The body is driven up, over and down by its velocity, a hand
planted on the top on the way. The hall has a low wall and a block in a row
across its east half to practise on — **Space** with **W** at either climbs
onto it instead — and a rail at the end of the row, lower than a knee, that
only a jump gets you over.

### Jumping from stone to stone

Along the hall's south wall, behind the low wall, four stones stand in a row a
stride apart, 45 centimetres high: over a knee, so a step does not get you
onto one, and under a knee, so **Space** jumps rather than climbing. Walk off
one and you are on the floor between it and the next. A running jump carries
you from each to the next — the harness does it, from the floor to the first
and from the first to the second, and walks into both and the rail as well to
see that walking does not.

The body runs in level and springs from just short of the near side, rather
than rising off its first step. The other hand goes down flat on the top as it
comes over the edge, and the body turns on it: hips skimming the top, knees
tucked, the legs swung round over it to the side, then unwinding on the far
side to come down on both feet, still leaning into the way it was going. A
hand with a sword in it lifts the sword clear, as it does on a climb. The
harness holds it to what it looks like: the legs never more than two
centimetres into the stone all the way over, the hips within half a metre of
the top and turned, and the planted hand on it.

## The testing area

A hall, and four rooms off it behind gates.

```
                   ┌───────────────────┬───────────────────┐
                   │    THE WARREN     │     THE CELL      │
                   │    two kobolds    │   three goblins   │
                   │                   │                   │
┌──────────────────┼───────┤gate├──────┴──────┤gate├───────┼──────────────────┐
│     THE PEN      │               THE HALL                │     THE DEN      │
│     two orcs     ┃ gate                             gate ┃     the ogre     │
│                  ┃  the dummy and four pillars, a ledge  ┃                  │
│                  │  and a crate; a rail, a low wall, a   │                  │
│                  │    block, and stones to jump along    │                  │
│                  │                                       │                  │
└──────────────────┴────────────┐              ┌───────────┴──────────────────┘
                                │              │
                                │ THE ENTRANCE │
                                │              │
                                │you start here│
                                └──────────────┘
```

You start down the entrance, a passage running south out of the hall, with a
rack and its shield against its east wall and a potion beside it. It opens
into the hall across its whole width. The hall's west half is where the
training room was, walls and all: the practice dummy and four pillars round
it, and in the south-west corner a stone ledge a metre and a half up, with a
crate against it to go up by in two. A cut you land there is a cut you can
read. Its east half is for your feet: a rail to jump, a low wall and a block
to vault in a row across it, and behind them, along the south wall, four
stepping stones a stride apart to jump from one to the next. Up over the
north-west corner a timber beam waits for a big overhead, and a thin post
stands by the north-east corner to be cut.

Off the hall, behind gates, is everything that wants to kill you: two orcs in
the pen to the west, two kobolds in the warren and three goblins in the cell
to the north, and the ogre in the den to the east — and nothing else in any
of them, because what is in them is the whole of it. Every gate has a lever
on the hall's side of its wall, a pace along from the doorway, and nothing
comes out until you pull it (see [Pulling the lever](#pulling-the-lever)).
Shut, a gate is a wall: timber and iron that stops a blade, a body and a line
of sight the way stone does, so what is behind it neither sees you nor comes
for you, and you do not see it. Opened, it is winched up in a little over
three seconds into the gatehouse built over the doorway to take it — the
walls have no roof, and a gate wound up out of one would stand in the air —
and the doorway is a doorway like any other. It comes down again only with a
reset. Which room you open, and when, and whether you open another before you
have finished with the first, is yours.

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
noticed you, sight alone keeps it coming. So you can stand in the hall and look
through an open gateway at a goblin that has not seen you yet, and walk through
it and find that it has.

Losing sight does not stop a fight dead either, but it knows no more of you
than it saw. For four tenths of a second after the line breaks — about one
pillar's worth — it carries on as it was, squared up to where you were. Past
that it goes to look: to where it last saw you, on a little the way you were
going, and a look round from there. If it still has not found you, it walks back
to its post the way it came — it drops a mark every metre on the way out and
keeps only the corners, so the way back goes through the door and not into the
wall beside it — and turns to face the way it stood. The fight panel says
`waiting` again once it has given you up.

It used to keep coming for two and a half seconds after the line broke, and for
all of them it knew where you actually were. Step through the door out of the
orc's hall and along the other side of the wall, and it walked most of the way
across its hall toward you, into the stone, and gave up there — wherever there
was — and waited against the wall.

**A gate going up is heard.** Standing at its lever you are a pace along the
wall from the doorway, where nothing behind it can see you through it, so
sight alone would leave them waiting at their posts with the gate wide open
until you walked in front of it. But a gate grinding up is a noise, and
anything within ten metres of it that is not already after you goes to see: to
the gateway, on out the far side of it from where it stood, and a look round
from there — the same search it makes where it last saw you. It learns nothing
of you by the noise. The ray it always casts decides whether it finds you,
and from the doorway you are three paces off and in plain sight; if you have
gone, it gives up and walks home, and waits there with the gate open behind it.
The fight panel says `looking` while it is looking, and `fighting` once it has
seen you. It is heard in the room behind the gate and out in the hall, and not
through anybody else's walls: the nearest goblin in the cell is under ten
metres from the warren's doorway, and it hears nothing when the warren's gate
goes up.

## The bestiary

Five creatures, and not one of them has a stat block. A species is **a size, a
weapon, and the shapes of swing its arm knows** — everything that makes an orc
feel like an orc falls out of the physics those three imply.

| | | | |
|---|---|---|---|
| **you / the swordsman** | 1.85m, 82kg | sword, 1.4kg | the reference. Every number in this project was tuned against this figure. |
| **the orc** | 2.11m, 147kg | axe, 3.65kg | slow, enormous, committed to everything it starts |
| **the goblin** | 1.37m, 32kg | spear, 1.05kg | outreaches you, and does nothing else well |
| **the kobold** | 1.11m, 16kg | hatchet, 0.7kg | at your knees, never still, and gone before you can answer |
| **the ogre** | 2.52m, 317kg | club, 6kg | slow, and does not need to be quick: it hits you and you go flying |

(Masses are the walking body — the hull that does the shoving. Arms and weapons
are separate bodies on top.)

Bodies are one set of human proportions multiplied by a length scale and a
thickness scale. Lengths go with the scale, thicknesses with scale × girth, and
mass with volume — so a goblin at 0.74 weighs a third of you and an orc at 1.14
nearly twice, a kobold at 0.6 a fifth, and an ogre at 1.36, built thick, nearly
four times. That cube law is doing real work: it is why an orc shrugs off a
cut that fells a goblin, and it is geometry rather than a difficulty setting.

Two things are derived from that mass, at different rates, and the gap between
them is the whole strategy against a big enemy:

- **health** scales with mass. The orc carries 179 to your 100.
- **joint integrity** scales with mass<sup>2/3</sup> — cross-sectional area,
  which is literally what a cut has to get through. The orc's shoulder is only
  half again as hard to cut as yours.

So you do not out-damage an orc. You take its arm off.

Nor do you knock one over. The same mass is what a blow has to move, and
nothing you can swing moves 173 kilos (see [Weight](#weight)). A goblin, you
can put on the floor.

The kobold and the ogre are the same two laws at the two ends of them. A
kobold carries 19 health to your 100 and a neck one clean cut goes through; it
lives by never being where you swung — it skitters, darts in and out again,
hops clear of most of what comes at it, and lets go of its own swing when you
cut it — and by going for your legs. An ogre carries 387, with joints only
two and a half times as hard as yours, so its arm still comes off; but nothing
here puts it on the floor, and its club puts you there (see
[Sent flying](#sent-flying)). Two kobolds wait in the warren, and the ogre
on its own in the den (see [The testing area](#the-testing-area)).

The one number a species declares that its size does not explain is `grit`, a
strength multiplier, and the two smallest creatures need it. A goblin's spear
is a metre of lever; at the strength its shoulders imply, the arm's torque
budget cannot hold the shaft on line while the hand accelerates, and every
thrust arrived rotating and landed flat. A kobold's hatchet hung off an arm
that short and landed too slowly to bite. A wiry thing that is strong for its
size is both the obvious answer and the true one.

And one creature declares `heave`: how much of its own body it throws in
behind a blow after its arm. Only the ogre does, a quarter of itself.

### What they look like

Every body is the same tapered shells laid over the same capsules
([`skin.ts`](src/game/skin.ts)), and those are shaped like limbs now: a calf is
fullest up by the knee, a forearm by the elbow. Past its size and its
colours, what tells one creature from another is its **look**
([`look.ts`](src/game/look.ts)) — a face, what it wears, and what it is made
of:

| | face | wears |
|---|---|---|
| **you** | a nose, a brow, a chin, ears, cropped hair | a tunic belted over breeches, bracers, boots |
| **the swordsman** | the same, under a steel cap with a nasal | the same, and plates on the shoulders |
| **the orc** | a heavy brow, a flat nose, a jaw thrust out, tusks, pointed ears, a topknot | a leather harness over a bare chest, bracers, boots |
| **the goblin** | a long nose, big ears, yellow eyes that catch the light | rags and a sash, bare clawed feet |
| **the kobold** | a snout, teeth, horns swept back, frills, scales | a hide round its middle, a tail, clawed feet |
| **the ogre** | a wide flat nose, an underslung jaw, short tusks, a topknot | a gut, a hide round its middle, clawed feet |

The surfaces are made rather than painted: cloth has a weave, leather a grain,
skin is mottled and a kobold's is scaled, each one grey, shading whatever
colour it is laid on, and its own bump map. They are built from numbers
rather than drawn on a canvas, so the headless harness builds them as happily
as a browser does. None of it is anything a blade finds: it hangs off the meshes that are
already placed, so a head that comes off takes its ears and its helm with it,
and all of it fades with the body when the camera is backed into a wall. The
weapons have been given the same care — a sword blade faceted to a ridge and a
point, with a crossguard, a cord-bound grip and a wheel pommel, and an axe
head that thins to its edge.

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
  axe manages 47°. Catch someone with the head and it bites deep; catch them
  with the haft and you have hit them with a stick.
- **The spear** weighs a kilo and is held **choked up**, a third of a metre from
  the butt, which is how a spear is actually held and the only reason a 32kg
  goblin can aim one. Gripped at the end its moment of inertia is higher than
  the axe's; the butt behind the hand balances the head in front of it and
  brings that down by a third. Swung side on it is still a broom handle. Driven
  down its own length it is the most dangerous thing in the room.
- **The hatchet** is the axe made small: 0.7kg over forty centimetres, most of
  it in a head that thins to its edge. There is too little of it to carry the
  arm round after it, so it goes where the kobold's arm puts it, and what
  little there is bites keener than a sword's edge — but only at the head.
- **The club** is 6kg of oak with iron bands and studs round its head, 4.6 of
  it in the last half metre. It is the one weapon here that does not bite: it
  lands the same whichever way it is turned, the forearm does not twist to put
  an edge on line, and it never takes anything off anyone — forty blows leave
  an arm on that two cuts of your sword take off. Its damage is what it does
  to your health, and what it does to where you are standing.

Four things a weapon declares rather than derives, because they describe the
shape of its business end and a mass never can: which axis bites (an edge, a
point, or none of it — blunt), where along itself its leverage is, how fast it
has to be moving to do anything, and how concentrated that bite is. A blunt
one declares a fifth, how far it comes back off what it hits (see
[Sent flying](#sent-flying)).

### Swings, made up as they are thrown

An opponent used to throw a short, fixed list of named attacks, each held wound
up for a declared length — three quarters of a second of axe going up — while
the weapon glowed and the panel on the right named it and said how to beat it.
It read clearly and fought like a quiz: you learned the tells and stopped
watching the body.

Now nothing is announced, and every swing is made up as it is thrown:

1. **a part of you** — head, body, sword arm or legs — as often as that
   creature goes for each;
2. **a shape its arm knows** that reaches that part from this distance: the way
   the weapon goes round, over the top, along the floor;
3. and **every number in it drawn afresh**: each angle of the wound-up pose and
   of the follow-through, how far the arm is drawn in and how far it extends,
   and the edge.

| | shapes | goes for |
|---|---|---|
| **swordsman** | forehand and backhand at your head, body or arm · a low cut at your legs | your body, then your head, your sword arm and your legs alike |
| **orc** | overhead at your head or body, three times as often as it goes round · wide swing at your body or head · leg sweep · and a leap, once you have got away from it | your body, sometimes your head, never your arm: a small thing to an orc |
| **goblin** | thrust at anything · shaft sweep, only once you are inside its point | the middle of you |

No two swings are the same, and there is no list of them to learn. Your sword
arm is on it for a reason: taking it is the one cut that ends a fight without
winning it, and the swordsman goes for it as readily as your head. And a
creature reaches for some shapes more than others, which is most of what it is
like to fight: wherever the orc could bring the axe over the top or round, it
comes over the top three times in four — so the axe going up is the thing to
watch, and one line is the thing to step off.

**It draws back for as long as its arm takes, and no longer.** A swing goes the
moment the weapon is where it starts from — the arm's intent on the pose, and
the real hand within a hand's width of it — it is over once the weapon has gone
through, and the opening after it lasts as long as the guard takes to come back
up. There are no clocks, only bounds for a weapon caught on something that
never gets there. So the timing is the weapon's own. A sword is drawn back in a
fifth to two fifths of a second, depending on how far round it has to come, a
spear in about a fifth, and the orc's axe in about a third; back, through and on
guard again, a swing of the sword takes about a second and one of the axe a
fifth of a second more. The heaviest thing in the room is still the slowest,
because it is, not because a table says so — and what you read is what you
would read off anyone: the weapon going back, where to, and how far.

**The edge is the one number not left to chance.** A cut is worth its edge
squared, and which rolls lead with the edge through a real swing is not
something the pose says (see the findings below). Each shape carries a band of
rolls it was measured to cut in, swing by swing, and draws from inside it.
Where the best of a band cut far harder than the attack the shape replaced, it
draws from the side that cuts about as hard as the old attack did — so the
fight is as dangerous as it was, and only no longer tells you what is coming.

Shapes are still chosen for the distance. A goblin outside your reach thrusts;
get inside the point and the only thing it has left is the shaft, which is a
broom handle.

None of which makes a swing scripted. Once it goes, the arm is still a physical
limb being dragged toward a target pose under a clamped force. It overswings,
it catches the low beam, it plants the axe in the floor, and the damage it does
comes out of how fast the weapon happened to be travelling when it arrived.

**The opponent does not cheat.** It drives its weapon arm by emitting *mouse
deltas* through the same input surface your pointer feeds, so its weapon is
subject to the same force clamp, the same reach limits, the same saturating
controller. It cannot teleport its weapon, it cannot swing faster than an arm
can be moved, and if it buries its axe in a pillar it is stuck there exactly as
long as you would be.

### The orc's leap

Get out of the orc's reach and it comes after you through the air.

Only once you have got away. If you were in its reach within the last three
seconds and are now three to five metres off, down a clear line, it runs at you
with the axe going up. When you are one jump away and the axe is up, it jumps —
your jump, on your key, as high as its legs put it for its size — and brings the
axe down at the top. Something that has never had you in reach walks up to you
like anything else: the leap is how an animal too heavy to chase you down closes
ground you just made.

Once its feet leave the floor it is committed. It flies the line it jumped on,
and the chop comes down where you were when it jumped. So the answer is to be
somewhere else: step aside the moment it leaves the ground. In the harness a
player who stands still takes the chop nine times in ten, and one who sidesteps
as the orc jumps takes it none. Come back into its reach during the run-up and
it swings from its feet instead; keep running and it gives the chase up after a
second and a half. It leaps at most once every four seconds.

### How one shape fits three bodies and all of you

The shapes are written in **offsets from level** — the arm pitch at which that
creature's own weapon would cross the part of you it is aimed at — and level is
solved from its own kinematics while it draws back. So one shape reading "a
hand's width above level, swept across" describes the same swing at your head
and at your shins, thrown by a 1.37m goblin or a 2.11m orc. Aimed at your sword
arm, which is off to one side of you, an edge also comes round by however far
from your chest it lies.

The aim follows you while it draws back, as anyone's does, and is held once the
swing goes: chasing you through the swing would make every one of them home,
and you should be able to step off the line it went on.

The solver is bisection over the same pose maths the ghost hand uses. It touches
nothing physical and knows nothing the creature does not: it is an animal
knowing the length of its own arm. The physical limb still has to get to the
pose under a clamped force, and still frequently cannot.

Edges and points ask different questions of it. An **edge** wants to know where
its arc will cross, so it solves for pitch. A **point** wants to be aimed, which
takes both angles — and both ends of the thrust (see the findings below).

### Between swings

An opponent used to walk up to you, stop, and swing, and swing again. Nine
tenths of a fight went on winding up, striking and recovering, and in forty
seconds of it the orc moved twenty centimetres sideways. The gaps between
swings are footwork now:

- **It circles.** Short steps round you, a pause between each, at the edge of
  its own reach — drifting in or out only as far as it takes to stay there. It
  keeps going the same way round more often than not, and more often to its
  own right: your left, away from your sword hand.
- **It waits for its moment, never for the same time twice.** How long it goes
  round before committing is rolled afresh every time, so the gap between two
  swings is not a rhythm you can count. When the moment comes it steps in to
  where its weapon does its work — which you see — and draws back there.
- **It gives ground.** After a swing it presses straight into another, backs
  off a step or two on a slant, or goes round, in proportions that are the
  creature's own.
- **It feints with its feet, never with its weapon.** A dart in and straight
  back out, the weapon at the guard throughout: a question put to your nerve,
  not a tell that lies. The weapon going back still means a swing is coming,
  every time.
- **It rocks in and out.** Some of its steps round you are half-steps straight
  in or out across the edge of its reach instead — in, out, in — so you are
  never sure whether the next step in is the one it swings from. It used to go
  in only to correct its distance, on a slant, and in twenty-five seconds of a
  swordsman circling you it never once stepped straight back out.
- **It answers your feet.** Step in on it and, a reaction time later, it gives
  ground step for step — or stands, and swings as you walk into its reach.
  Back off and it follows, rather than let you set the distance.
- **It offers you a target.** Now and then it steps inside your reach on
  purpose, guard up, holds there a beat, and steps back out. It gets out of the
  way of what that draws more readily than of anything else.
- **Miss, and you pay for it.** A swing of yours that came at it and went by
  leaves you open while your weapon comes back, and it often steps in and
  swings — always, if it was baiting you. So does your weapon knocked aside
  (see [Weapons meeting](#weapons-meeting)).
- **It gets out of the way.** A swing of yours that comes at it is noticed
  once, weighed once against how wary a creature it is, and answered — if at
  all — a reaction time later, 0.12 to 0.22 seconds, by which point a quick
  cut has already landed. What it steps out of is a slow one, a big one, and
  the second of two. Never while it is committed: a swing it has started, it
  finishes, and the time its guard takes to come back up is still yours.
- **Crowd it and it fights.** Inside its guard it backs off while it can.
  Pinned against stone, or pressed for more than 0.6 seconds, it swings at you
  from where it stands with whatever works at that distance — for a goblin,
  the shaft.
- **It looks where it puts its feet.** Every step asks the stone first, knee
  high and a body wide, so it turns back at a wall instead of walking into one,
  and on its way to you it steps round a pillar rather than into it.
- **It swings at what it can see.** Out of sight it goes to where it last saw
  you and looks round from there; only sight lets it commit.

None of this is a way of moving you lack. It steps on the same keys you do —
its sidestep is Q and E too — at the same speed, and it sees nothing of you but
where you are and where your blade is.

Each creature does it like what it is, from a `footwork` block beside its
shapes of swing:

| | goes round you for | between steps | steps out of a swing it sees coming | gives ground after its own |
|---|---|---|---|---|
| **orc** | 0.25–0.9s | a long plant | one in ten | one in ten — and never feints |
| **goblin** | 0.6–1.8s | hardly at all | six in ten | more than half |
| **swordsman** | 0.5–1.5s | a beat | one in three | one in three |

And in and out:

| | half-steps in and out | step in on it and it | steps into your reach to draw a swing | makes you pay for a miss |
|---|---|---|---|---|
| **orc** | now and then | stands and meets you, nine times in ten | never | half the time |
| **goblin** | about a third of its steps | gives ground, eight times in ten | now and then | nearly half the time |
| **swordsman** | four steps in ten | either, as often | now and then | seven times in ten |

So the orc stalks: a heavy step, a long plant, and never long before the axe
goes up — it spends most of a fight swinging, and walking at it is walking into
it. The goblin never stops moving: it goes round you nearly two metres off,
where your sword does its work at 1.1, gives ground as you come, and hops back
from what you swing at it. You have to go and get it — and a swing that falls
short of it costs you. Against a player who swings once a second whatever is
in reach, all three do about the damage they did before any of this — what has
changed is when: on your misses, and as you walk in.

### One swing into the next

A swing used to end with the guard back up in the one place it was always
held, and the next began from there, whatever the last had done: swing, reset,
swing. Now:

- **A miss runs into the next swing.** A swing that goes through nothing ends
  where another starts — a forehand's follow-through is a backhand's wind-up,
  the orc's axe swung round high ends where its sweep along the floor begins,
  and a spear drawn back off a thrust is ready to thrust again — and now and
  then, instead of bringing its guard back up, it goes straight into the one
  that starts there. Stepping back out of a swing is not the end of it.
- **Stopped on your guard, it hacks again.** A swing stopped on your weapon,
  your shield or the stone has nothing left to carry on with. What can follow
  it is the same again, drawn back the way it came.
- **Never off a swing that drew blood.** A run is how it gets past you, not
  how it finishes you: against a player who stands and takes it, all three do
  what they did before any of this.
- **Every swing in a run is drawn back for.** The drawing back is short — the
  end of one is the start of the next — but it is there, and far enough to
  see. The weapon going back still means a swing is coming, every time.
- **A run is paid for.** At the end of one it stands a moment with its guard
  up getting its breath, about a sixth of a second for every swing past the
  first, and while it does it can get out of the way of nothing.

| | runs, after a miss or a block | the most in one | what follows what |
|---|---|---|---|
| **swordsman** | more often than not | three | forehand into backhand into forehand |
| **orc** | one in three | two | round high into along the floor, and back; the overhead ends where nothing starts |
| **goblin** | half the time | three | jab, jab, jab |

### Carried round

A swing that goes round and meets nothing can carry the whole body round
after it. The weapon stays out at full stretch where the swing ended, the body
goes round under it on its heel, stepping toward you as it turns, and the
weapon comes round at you again at the speed a body turning carries it — at
the height of your middle, whatever it went for the first time. It is the
orc's wide swing six times in ten it misses, and the swordsman's forehand or
backhand one time in five.

Its back is to you for the middle of it. That is the moment to go in: it is
committed to going round, and its weapon is behind it. Stay where you stepped
back to and the weapon arrives. It comes out of a spin a beat slow getting its
guard back.

The turn on its heel is yours too: **Shift** with a turn. It is three and a
half times as fast as an ordinary turn, a full circle in about seven tenths of
a second, and you can step while you do it. Carry a swing round with it.

### Its guard

It used to hold its weapon in one place between swings, still, until the next —
something you could learn to stop watching. Now:

- **It keeps its weapon where its last swing left it**: over on its left after
  a forehand, over on its right after a backhand, most of the way, and eases
  it back in its own time. Where one swing ends is where the next is quickest
  from.
- **It shifts its guard as it goes round you** — higher, further across or
  less — every second or three, at a guard's pace and not a swing's (see the
  findings below).
- **It is never quite still.** It sways.

None of it is a weapon going back, and none of it goes below the chest: an axe
held low in front of an orc comes up through you on the way to its next
overhead.

### Drawn back on the move

It used to stop, and then draw back. Now:

- **Pressing in, it often draws back on its way**, and the swing goes as it
  arrives: a weapon going back on something still walking at you. Get away,
  and it gives the swing up, as a leap does.
- **Now and then it gives ground as the weapon goes back**, a step, and comes
  in again behind it. Follow it as it backs off and you walk onto the swing.
  The goblin does it most, the swordsman now and then, the orc never.

### Meeting your blade

Its feet used to be its only answer to a blade. Now it may put its weapon in
the way, a reaction time after it sees yours go back — not when your blade
arrives, which is too late for a weapon to get anywhere, but as it is drawn
back, which is what anyone watching an arm reads, and what you read off its.
What comes of it is the weapons' business (see [Weapons meeting](#weapons-meeting)):
a weapon held still in the way of a hard swing stops it and is knocked aside
by it, as anything held still is; the orc's axe, still on its way into place as
your blade meets it, sends your sword back instead; and a goblin's spear shaft
is a broom handle. Your weapon knocked aside is an opening, and it takes it.

What it reads is a weapon going back fast and near it. Draw back slowly, or
from out of its reach, and there is nothing to read — and nothing it reads
comes any sooner than a reaction time after.

### Hurt

- **It flinches.** A cut that lands while it draws back may take the swing
  off it: the goblin more often than not, the swordsman half the time, the orc
  never. That is pain, not balance — a stagger still takes a swing off
  anything light enough to rock.
- **A cut leg lames it — and you.** A knee's worth of damage to the legs takes
  nearly half of anyone's walking pace and half their jump. A potion mends it
  with the rest of you.
- **Badly hurt, it fights like it.** The orc gets angry: under two fifths of
  its health it hardly waits between swings, runs three together, and stops
  getting out of the way of anything. The goblin gets away: under half, it
  waits longer between thrusts, gives ground, hops back from everything and
  stops offering you a target. The swordsman gets careful: longer between
  swings, and more of yours met with its sword.

### Hops and taunts

- **A step out of the way is sometimes a hop**: the jump key, back and away,
  off the floor, further than a step goes and committed to the line it left
  on. The goblin hops two times in three it gets out of the way, the swordsman
  now and then and after a run of swings, the orc never.
- **Out of its reach, it shows you its weapon.** Back out of its circle and
  stand, or stand well off as it comes for you, and now and then it stops: the
  orc beats the floor with its axe, the swordsman salutes, the goblin shakes
  its spear at you over its head. With you knocked down, it may stand off and
  do it rather than come and finish you. Never a weapon going back, so never a
  lie, and it is over the moment you come at it. And never the moment you have
  got away from the orc: that is what it leaps for.

| | parries | hops | lunges | flinches | taunts | badly hurt |
|---|---|---|---|---|---|---|
| **swordsman** | three in ten swings it reads | one in three | a quarter of its swings from standing | half the time | now and then: a salute | gets careful |
| **orc** | a quarter, with an axe | never | never | never | a fifth: beats the floor | gets angry |
| **goblin** | hardly ever | two in three | a third | four in five | now and then: shakes its spear | gets away |

### Quick steps

A double tap of a movement key throws you that way at twice walking pace for
under a fifth of a second — a metre or so, at your size — and the next cannot
start until seven tenths of a second after this one did. It goes where it set
off, whatever the keys do after. It is from the floor only, on feet that are
your own: a jump off one takes off at the keys' own pace, and a cut leg takes
its share off it, as it does off a walk. The tap is tight — two presses of the
same key, the first let go of within a fifth of a second and the second down
within a quarter of a second of that, nothing else pressed between — because
the keys are tapped all the time to edge in and out of reach, and a quick step
nobody asked for costs a fight. One asked for a moment too soon, still resting
or still in the air, waits that moment rather than be lost.

It is everyone's, on the same flag and the same rest:

- **In with a swing.** Its moment come and you not quite in its reach, an
  opponent may close the last of the gap with a quick step as its weapon goes
  back — straight in from further off, or on a slant round your side from
  where it goes round you — and swing from where it lands, once it has turned
  back square to you. The weapon going back is still the tell; the step is
  how fast what follows arrives.
- **Out after it.** Giving ground after a swing, the first step back may be a
  quick one; and after a swing it quick-stepped in to throw, it goes straight
  back out as readily as it quick-steps at all.
- **Out of the way.** A step out of the way of your swing may be a quick one,
  and in the first fifth of a second it has gone twice as far as a step goes.
- **Round you**, now and then: a flick round your side and out of its circle,
  and back in on the next step.

| | quick steps | in with a swing |
|---|---|---|
| **swordsman** | two in five of its steps out of the way, or out of reach | nearly half the time |
| **orc** | one in ten: a heavy thing throwing its weight about | one in seven |
| **goblin** | seven in ten — nine, badly hurt | three in five |

Against someone standing still they are no deadlier for it. Over at least
thirty-two forty-second fights each, the swordsman left you 41 health of 100 on average
where it used to leave 38, the orc 43 where it left 39, and the goblin 81
where it left 77 — no worse, within what that many fights can tell apart.
Against the harness's player that walks straight in swinging, the swordsman is
as dangerous as it was. The goblin, out of reach again the moment it has
thrust, is not: it costs that player a couple of points more a bout, and
killed it in four bouts of forty, where it used to kill it in none of twenty.

### Steps have weight

A step used to be at full pace the moment the key went down and stopped dead
when it came up, for you and for everything else: a figure slid about rather
than a body shifting its weight. Now the feet take a body up to pace and down
from it in a tenth of a second (`step ease`, under Movement; 0 is the old snap),
at a flat rate, so turning a step round — in and straight back out — takes
twice as long as starting one. The in-and-out above only reads as footwork
because of it.

A jump is still a stride: the legs push the body off at the pace the keys ask
for. Before steps were eased the jump got that by accident — the ground probe
finds the floor for two steps after the feet leave it, and those two set the
pace outright — and the orc's leap got its run from it; eased, it came down
short and none of ten chops landed. And anything that walks a body to a spot
lets go early by as far as the feet will carry it: the pick-up held on to the
last centimetre and went past, back, and past again until it gave up.

### The jump

Space. The take-off speed is derived from the jump height you ask for and the
world's gravity, so turning gravity down floats the same jump instead of firing
you into the ceiling.

In the air you close only about a twentieth of the gap to your intended velocity
each step, which over a jump comes out at well under half your ground
manoeuvring — enough to adjust, not enough to change your mind. That is the
price of
the one thing a jump buys you, which is being above a swing at your legs —
the orc's above all, which is already travelling along the ground and cannot
be sidestepped. The orc has the same jump, and uses it (see
[the orc's leap](#the-orcs-leap)).

It also means a hard swing in mid-air visibly shoves you sideways. A 420N drive
against an 82kg body moves it, and in the air there is no friction to argue.

## Seventy-three things the physics taught us

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

**A drive tuned on one body is tuned on its inertia.** The arm's angular drive
was tuned on the forearm with the weapon welded on, and only ever worked
because the weapon was there: the forearm can hardly roll on its own — the
elbow is a hinge — so any roll swings the hand and drags the weapon with it.
Put a soft wrist between them and the forearm alone got the same damping, far
too much for it: its roll flipped direction every step, and grew. The wrist is
therefore stiff across its bend, as the weld was, and the drive's torque is
shared between forearm and weapon by their inertia about the hand, each toward
its own target, so neither is ever driven harder than the pair was. Two more
traps on the way. A ball joint's per-axis springs in Rapier read the angles
off its quaternion, where each bend axis moves with the other once the grip is
turned — two springs pushing each other sideways circulate, and at the grip's
stop the forearm settled into a steady 12 rad/s roll; the wrist is a velocity
servo on a proper bend error instead. And a bent weapon's share of the drive
turns the forearm about its length too, so the forearm's own roll drive steps
back as the wrist bends, or the two together over-drive it.

**Stopping a drive does not remove its force.** Rapier keeps a user force until
it is cleared, and the arm clears its drive at the top of every step it runs —
so the step a fighter died on, its drive stopped running and its last push
stayed: a few hundred newtons at the hand and the gravity feed-forward, forever,
and the head and off arm held by their last torques the same way. A dead
goblin's arm dragged its own corpse six metres across the floor in ten seconds
and threw it into the air. Nobody noticed while a corpse was the end of the
fight; a knockdown makes an arm limp and then needs it back, and a body on the
floor was crawling away. A limp arm now clears its forces every step, and a
body that dies lets go of its head and off arm. *Nothing must drive a corpse*,
including the last thing that did.

**A practice dummy is for practising cuts.** The dummy used to ignore blows —
a blade passed through it, so nothing pushed. Given the struck limb's share of
a blow, a slap flung a forearm most of a metre. Given the whole dummy's share
at the point it landed, a blow to a hand spun the slender body round its rope.
Given it through the middle, it swung for five seconds on a free pin. All three
were honest physics, and in all three the limb you were cutting was somewhere
else by the next cut: the scripted swing that takes an arm off needed
twenty-one tries instead of nine. It takes a blow like a punching bag now, and
its mount drags, and the arm comes off in nine again.

**Crowding switched an opponent off.** Its only answer to being inside its
guard was a step back, and every attack it had wanted room it never got:
walk into an orc and stay there, and it swung three times in forty seconds. The
goblin's shaft sweep, written for exactly that distance, had never been thrown
at all — its band of distances lay wholly inside the one at which the goblin
stopped attacking. Backing off is still the first answer; pressed for more than
0.6 seconds, or with stone at its back, it swings from where it stands with
whatever it has for that distance.

**A single ray passes a pillar that a shoulder walks into.** Footwork asks the
floor before it steps, and the first probe was one knee-high line from the
middle of the body. An opponent whose line to you cleared a pillar by a hand's
width walked its shoulder into it anyway, stood there with the stone between
you, and — sight gone, memory spent — went back to its post. It looks down both
flanks as well now, and steps round what is in the way. It also no longer swings
on memory: circling put pillars between opponents and their targets often
enough that one wound up and struck at you through the stone.

**How fast a blade is going does not say whether it is coming.** An opponent
first watched for your sword moving fast near it, and your sword moves fast
near it whenever you move: a body's velocity is set outright each step and the
arm lags it, then catches up, so starting a walk or a sidestep whips the tip to
seven or eight metres a second relative to you, and a sidestep while turning to
nine. An opponent flinched at footsteps: a swordsman crowded by a player who
never once swung stepped out of the way of him three to five times in forty
seconds, and spent on that the rest it needs between dodges. A threshold high
enough to ignore all that ignored every overhead chop as well. What a cut does that footwork does not is come *at*
something: the blade's speed toward the watcher, against the body carrying it,
passed 5 m/s once for each of nine cuts and nine chops, and not once in
thirty-six seconds of shuffling, sidestepping and turning.

**In reach is not where a weapon works.** Given footwork, the swordsman went
round you at the edge of its reach and swung the moment you were inside it — so
nearly nine swings in ten came from the last hand's width, with the tip, and
fewer than half of them drew blood. Thrown from further in, nine in ten did.
Now, when its moment comes, it steps in to where its weapon does its work and
swings from there: fewer swings than the old opponent threw, and each doing 5.4
points of damage to their 3.1.

**Which edge leads a swing is not in the pose.** Swivel and edge are one degree
of freedom and a cut is worth its edge squared, so an opponent that makes its
swings up has to know which rolls cut. The obvious answer is to work it out:
take the pose where the swing crosses you, the way the percussion point travels
through it, and solve for the roll that lays the edge along that line. The
solver was right about every pose it was asked about and wrong about every
swing. The swordsman's solved cuts drew blood one time in five, against nine in
ten for the rolls it had been throwing, because a swing is not a sequence of
poses: the blade lags the hand, the grip gives, the wrist bends, and the edge
that arrives is not the one that was asked for. Every shape now carries a band
of rolls measured the only way that works, swing by swing in a live fight.
Most turned out broad, with a cliff either side.

**A stride posed from how far you have walked stops where the walking does.**
The legs follow a stride phase that advances with the distance the body covers,
which is what keeps the feet from sliding at any speed. It also meant that when
the body stopped, the phase stopped, and so did the legs: stand still mid-step
and you stood on one leg, the other knee bent nine tenths of a radian and its
foot a third of a metre off the floor, for as long as you cared to stand there.
Every opponent did it between every two steps of its footwork, which is most of
a fight — and a fighter that had never moved at all stood with its knees half
bent, because a stride phase of zero is not a standing pose. The stride has an
amplitude now as well as a phase: it comes in within a few hundredths of a
second of the feet moving and goes over about a tenth once they stop, and the
raised foot comes down to the floor.

**A swing timed by its weapon lands harder than one timed by a clock.** Taking
out the telegraph's hold changed nothing about a swing but when it started, and
the orc's chop went from 12 points a swing to 25, on the same edge and along
the same line: an axe brought down the moment it is up is not the swing it was
after being held there for a count. Most of the old cleave's damage had been
landing after its strike was over. Every edge was measured again on swings as
they are now thrown, and the orc's comes from the side of its band that cuts
about as hard as the old cleave did. Aiming mattered as much. Going for your
head a quarter of the time, the swordsman beheaded a man standing still half
again as often as before — a neck gives way after seven points — so it goes for
your head less now. And an orc that never aims at your arm at all still takes
it more often than the old one did, because your arm is in front of your body.

**A running body drags its hand behind it.** The arm's drive damps the hand's
speed through the world, not its speed past the shoulder, so a body moving at
walking pace carries its hand a steady distance behind the pose it was sent to:
that speed times the drive's damping over its stiffness, a fifth of a metre at
an orc's run. Every "is the weapon there yet" in the opponent asked for a tenth,
which is right for something standing still and impossible for something
running. The orc's first leap never counted its axe as up until it had stopped
running, and chopped from its feet every time. Now what it waits for allows for
the lag its own speed puts there.

**Nothing hides where a chop really goes.** On its feet the orc steps into its
overhead, and the step covered for two errors nobody knew were there: the axe
falls in the plane of the right shoulder, and hangs off the forearm at an angle,
so a chop aimed straight ahead comes down a third of a metre to one side; and
an overhead meets you at chest height a metre in front, not at the end of its
reach. Out of a leap there is no step. Landed where it swings from and aimed
the way everything else is aimed, its chop drew blood from someone standing
still one leap in four. Aimed by where the axe head arrives rather than where
the arm points, and landed a metre off, it draws blood nine times in ten.

**A leap that follows you is one you cannot get out of the way of.** In the air
the orc has your air control — a twentieth of the gap closed every step, which
over half a second is most of it — and your turn, and it re-aimed its chop at
you all the way down. Stepping aside the moment it jumped, the one answer a leap
should have, still took the axe twelve times in sixteen. Once its feet leave the
floor now it holds its line and its aim at where you were: nine chops in ten on
someone who stands there, and none on someone who steps aside.

**An arm nobody drives is still being driven.** The off arm was "held in a
living posture" by a spring on each bone, weak on purpose, and it was never
still: its damping, applied explicitly, was six or seven times what a bone's
inertia about its own length can take in one step. Each bone flipped its spin every step
and sat at the torque clamp, 37 rad/s, forever — and the head, on the same kind
of spring with two thirds too much damping, buzzed at 15. A weak controller is not
a safe one. Every drive here now asks the body what it can take, axis by axis,
before it pushes.

**An empty hand is a different arm.** The sword arm was tuned with a sword in
it, and the day it could put the sword away the same gains shook the empty hand
back and forth every step at the clamp, a centimetre from where it was sent.
Nothing had changed but the load: a kilo and a half of steel at the end of the
forearm is most of what the linear drive was pushing, and the forearm's swing
and the upper arm's roll — one motion when the elbow is bent — weigh a
fraction of what two drives damping them at once assumed.

**Anything placed has to be placed where it will be.** A sword on the back is
put there before each step, for the step to take it to — and it was put where
the back was before the step. The body then walked out from under it: a step
behind, five centimetres out of the scabbard at a walk, and more at a run. It
is sent to where the chest will be once the hull has carried it a step at the
speed it is going, and stays within a few millimetres. Everything that is
carried along the chest rather than simulated goes through the same one
function, and none of it can forget.

**A hand that follows a moving target trails it by its own damping.** The arm's
drive damps the hand's velocity, which is what makes a swing feel heavy — and
what leaves it the damping over the stiffness behind anything that moves:
55 over 900, a sixteenth of a second. Following a grip down a scabbard at two
metres a second that was twelve centimetres of air between the fist and the
sword. For as much of the ghost as is being guided somewhere — and only that
much, so an aim still feels exactly as it did — the hand is damped against the
ghost's own motion instead, and stays on the grip within a few centimetres.

**A human body cannot pick a potion up off the floor standing over it.** The
hand here is where the forearm ends, 58 centimetres from the shoulder, and the
shoulder is a metre and a half up. An ordinary crouch and a bend of the back
still left the arm, straight and pointing at the floor, fifteen centimetres
short. It takes a squat as deep as the legs go and a bow of sixty-odd degrees —
which is what a person does — and even then the last few centimetres are the
wrist's.

**A swing that has landed is over.** Once blades stopped on bodies, every blow
an opponent landed was followed by a third of a second of it leaning on the
weapon: a swing is over when the arm reaches its follow-through, and a blade
stopped on your hip never reaches it, so the swing waited out its longest.
Close in, getting its guard back was the same, because the guard it wanted was
where you were standing. A swing now also ends when the weapon has stopped
dead, under a metre a second for eighty milliseconds — which a blade checked
for a step by your sword and going on through never is. It knows the way you
know your own arm has stopped.

**A dead body stood on the thing that walked it.** Killed, a fighter used to
stay on its feet for a second and a half and then go over stiff as a plank,
legs straight out: the invisible walking capsule that stands a living body up
was still under it, balanced on its end, and the legs were posed rather than
simulated, so nothing in it could bend. A corpse has no walking capsule now,
and its hips, thighs and shins are bodies of their own on joints with ranges.

**Nothing falls straight down its own middle.** Given joints and nothing else,
every body that died standing folded straight down onto its heels into the same
kneeling heap, face on the floor, whatever had hit it — because the killing
blow's shove went into the stumble a living body's feet would have taken it
out in, and a corpse takes no more steps. It goes on the way the blow sent it
now, and starts to go over some way of its own besides: some sit down hard and
fall onto their side, some crumple and topple, and a goblin is thrown.

**A hand holding its own body is shoved off it.** The trunk pushes the arm out
of itself, which is what keeps a swing from going through your own chest. A
goblin holding the stump of its arm had its forearm across its belly, the trunk
pushed it off, the drive pulled it back, and the hand swung a third of a metre
either side of the wound, steadily. A hand sent to its own body is let rest on
it: the push that keeps it out is a sixth of what it was. And a hand sent after
a stump that swings about swings about with it: it is sent to where the stump
hangs on the body, and the stump is held in.

**A millimetre at the hip is a tenth of a radian at the knee.** The body dips as
it walks, and the legs bend under the dip the way they bend under a crouch, so
the feet stay on the floor. Near a straight leg the knee bends as the square
root of the drop: the last millimetre of a dip fading out after the feet had
stopped bent a man standing still a tenth of a radian at both knees. The dip
only comes in well into a walk now, and is gone before the stride is.

**A joint motor is only as strong as the two bodies it joins.** Rapier's
acceleration-based motors scale their gains by the joint's own effective mass —
the two bodies it joins, and nothing hung off them. The waist of a body on the
floor joins a pair of hips to a chest without its head or arms, so the motor
meant to straighten it before it got up took out the twist and the side bend,
which only slide along the floor, and could not lift either end off it: the
chest stayed 49° off square, on its limit, with the motor on. The gains are a
torque now, worked out from the anatomy — the whole upper body about the waist,
a whole leg about the hip, a shin about the knee — and the same waist comes
straight to within two degrees.

**A spring left moving waits.** A blow throws the chest away from it with a kick
to the posture's springs, and a body gone limp stops stepping its posture — so
the flinch from the blow that floored it waited out the whole time it lay
there, and then threw the chest's collider into the floor the step it began to
get up. The body jumped six degrees, and the legs drawn on it eight
centimetres into the floor. Going limp stops every spring where it is.

**Nothing pushes back on a kinematic leg.** The legs are posed, not simulated,
so they meet nothing but hostile blades — a leg that could touch the room would
bulldoze it. Once blades met bodies, though, the legs met every hostile blade,
including one lying on the floor in a dead hand: a foot coming down on a
goblin's spear fired it off at seventeen metres a second, with the goblin still
holding it. About one run of the harness in a hundred found a corpse fourteen
metres from where it fell, without a blow having landed on it. A weapon nobody
is swinging stops meeting bodies now.

**A quick step stretches the shoulder by its speed, not by its start.** The
first quick steps took the harness's opponent's hand eleven centimetres past
where its arm ends, where walking takes it five. Easing the step up to pace
three times as slowly changed nothing. The drive damps the hand against its
speed through the world, not past the shoulder, so a body going at twice
walking pace leaves its hand behind by twice as much for as long as it goes,
and the shoulder, a soft joint, gives. It is yours as much as theirs, and the
check that an opponent's arm never exceeds its reach measures quick steps on
their own now, against a bound yours is held to as well.

And five about the harness rather than the game:

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

**A test can pass because nothing happened.** "A sheathed sword cuts nothing
it passes through" backed the player through the practice dummy with the sword
on their back, and passed — and passed just as well with the code that stops a
sheathed sword being swept for cuts taken out. The body shoves the dummy aside
before the scabbard gets there. It measured nothing, and now asks only what is
true: that a sword on your back is out of the world.

**A swing at a ghost is not a swing at a body.** The scripted cuts aimed the
blade *at* the target with `aimBladeAt`, then wound up from there and swept
back through it — which a blade that passes through flesh can do, and one that
stops on it cannot. Against a solid dummy the blade was pressed into the body
before the swing began and dragged round it on the flat, and a swing that had
taken an arm off in nine tries took nothing off in twenty-four. They throw the
swordsman's own forehand now: edge rolled to where it cuts, drawn back clear
of the target, and through it from the same side every time. It also showed
what the old swings had been: mostly on the flat, scoring by passing through
four or five parts at a time.

**The scripted player is part of the test.** The footwork checks roll dice, so
they were run across dozens of seeds before their numbers were set, and three
of the failures that turned up had nothing to do with the opponent. The player
that crowds it walked into a pillar and stayed there while the goblin backed
round it. A player it killed got up two rooms away, and the rest of the bout was
an empty room. And the player that swings at it swung only at what came within
a sword's length — which is exactly what a goblin that keeps its distance never
does. Each could have been made to pass by loosening a number, and would then
have been measuring nothing.

**A guard shifted at a swing's pace is a swing.** The first guard that moved
between swings went to its next place as fast as the arm could be moved, which
is the speed a swing goes, and a sword brought round that fast a foot from you
cuts. Standing still in front of a swordsman going round you, you lost eight
times as much health while it went round you as before its guard moved at all.
A guard shifts over half a second now.

**Carried round, a weapon leads with a different edge.** The first spin held
the edge the swing had led with — the band it was measured to cut in — and
landed on the flat three times in four. An arm sweeping a weapon across and a
body carrying it round move it through the air differently: at the rolls the
orc's wide swing cuts in, a spin led with the edge at a third to a half of
square, and the best rolls for going round, measured the same way with the
weapon held out and the body turning, are on the other side of flat.

**A heavy head trails a fast turn by a quarter of it.** The first spin was
over once the body had come all the way round, and the axe had not: turning
at nine radians a second, the head trailed the arm that held it by a radian
and a half, and the spin stopped with the axe still behind you. It is over when
the weapon has come past you now. The same lag drew the hand in, and the first
spin, which shortened the arm to put the head on you, swept the head's circle
past in front of you. It keeps its arm out and moves its feet to put the
circle through you.

**A parry decided when the blade arrives is too late.** It first answered a
swing with its weapon when it answered with its feet: on seeing the blade come
at it. A reaction time after that and an arm's travel after that, the cut had
landed — in a dozen forehands it got its sword to one, and took more than a
swordsman that did nothing, whose guard had at least stayed where it was. It
reads your weapon going back now, which is what anyone watching an arm does,
and meets most of them.

**Following up a hit that landed made standing still fatal.**
The first runs followed any swing that stopped — on your guard, on the stone,
or in you — and a cut that landed was followed by the same again. Against a
player standing still, three swordsmen in eight killed them inside forty
seconds, where before none had. A run is how it gets past you, not how it
finishes you: it follows only a swing that met nothing, or met your weapon.

**A creature that taunts whenever it is out of reach taunts at itself.** The
first taunts came whenever it was well outside its own circle — and it was,
every time it gave ground or stepped back out of offering you a target. The
swordsman spent a tenth of a fight saluting, and every salute ended with it
walking back in, nearer than it had been going round you. It taunts now when
you have backed off, not when it has.

**A step taken from a step goes further.** Stepping inside your reach to draw
a swing was timed as if from a standing start — what a step loses getting
going it makes up coasting to a stop — and one begun while it was already
walking in went nearly half again as deep: inside its own guard, where it stood
long enough to be crowded, and swung at you instead of stepping back out. It
takes off now what its feet would carry it anyway.

**A body turning on the spot stood on a turntable.** Held on A or D, the feet
counted as moving, and moving feet follow the hips: they turned with them, flat
on the floor, the legs straight, a figure on a pedestal going round. The feet
that step when a swing winds the hips up were already there, and turning on the
spot is that stepping kept up. What it needed that a wound-up hip does not was
to get ahead of the turn: at walking turn the hips come round nearly half a
radian while a foot is in the air, so a foot put down square is behind again
before it is down, and the other, waiting for it, runs out of hip to twist in.
Each foot lands as far past square as the hips will go before it lifts again
now, the steps are timed from how fast the hips are turning, and the first
comes from the foot on the side of the turn. Two seconds of A is five or six
steps a foot, one at a time; once the turn is going no leg is more than a
fifth of a radian off the hips, and even the foot left waiting through the
first step is still inside what a hip allows when its turn comes.

**A foot planted by where it points still slides.** The hips sit a hand
either side of the middle of the body, so hips going round over planted feet
carry each hip round a circle, and a foot that held only the way it pointed
would go round with its hip: five centimetres a step, turning on the spot. A
planted foot holds its place as well now, and the leg leans out to it —
measured, it moves nothing at all while the body turns over it. The same lean
holds a foot while a swing twists the hips, and a body shoved about by its own
swing steps a foot back under it once the hip is twelve centimetres off it.

**A stride that asks how far and not which way walks forward everywhere.** The
legs' phase has always gone on with the distance covered, which is what keeps
them from skating, and which way the distance went was never asked. So a
sidestep slid the body along on legs walking ahead, and backing off was a
moonwalk: the knee bent as the foot went forward, as it does walking, while the
body went back. The stride swings the legs the way the body is going now. A leg
swings out to the side a third as far as it swings ahead, so sideways the steps
are shorter and quicker, a shuffle, and the body comes down between feet that
go wide. At walking pace the planted foot still slides at about four tenths of
the body's speed, where a walk ahead slides at three: to slide no more than a
walk, a shuffle at that pace would have to step seven or eight times a second,
and it steps six. And a stride turned from ahead to back flips the way it goes
at the standstill in between, which taken as it comes would jump a leg halfway
through a stride to its mirror in one step: it comes round over a tenth of a
second instead, through standing.

**A facing set outright is not a turn.** The feet measure how fast the hips
come round from how far they came since the last step. The harness puts a
fighter in place by setting its facing, and read as a turn, half a circle in
one step is a hundred and eighty-eight radians a second: the feet stepped round
after it like a spinning top. A body that has come round three times as far
in one step as the quickest heel turn goes has been put there, and its feet
are put down square under it.

**Twelve cuts at a body they knock about come to anything.** The check that a
shield slung on your back spares nothing in front compared twelve cuts at the
front with it there and twelve without, and it failed once the feet learned to
step — though no leg touched anything in any of those cuts. On the code before
them, standing the swordsman a millimetre to one side took the same twelve
anywhere from seven points to twenty-five, and failed the check two times in
four. A body knocked about by each cut meets the next one somewhere else, and
where it started decides the rest. It is cut from nine places a centimetre
apart now, and what they come to together is compared: 147 points with the
shield and 161 without, where the code before gives 160 and 181. The ratio and
the one cut in twelve allowed to catch the rim are what they were.

**A pole the hand can point away from leaves the elbow no side.** The elbow
hangs toward a pole, and goes to whichever side of the shoulder-to-hand line the
pole is on. Set behind and below the hand, the pole points away from a spot in
front of the chest, a little across it and twenty-four degrees up — almost
straight above the guard — and a hand raised through there had no side for its
elbow: it went over the top of the forearm, fifteen degrees in one step of an
unhurried raise, while the blade dipped from upright to below level on its way
up, and a sweep across at that height rolled the edge thirteen degrees in a
step. Bending the pole a little cannot get rid of that spot. The elbow hangs
under the arm wherever a hand is held low and went over it wherever one was
held high, so somewhere between the two it has no side; only where can change.
Above level the pole now tips down by as far as the hand has risen, so a hand
going up gets no nearer that spot than it is at level, and overhead the pole
hangs straight down: the spot is straight up, where no aim goes. Raised, the
elbow stays under the arm and the weapon leans back over the head; at and below
level nothing moved. What leaned on the arm going over the top went with it. A
guard over the head is the blade rolled across it now, which an axe meets more
often than it met the old one, and the orc's overhead, measured again, is
thrown on a new edge.

**The world's rays see nothing before it has stepped.** Rapier finds what a ray
hits in a structure it brings up to date as it steps, so a ray cast before the
first step finds no walls at all — and every opponent looks before the first
step. That never mattered while you started twenty metres from anybody. It
mattered once the harness put you beside the lever: the pen's two orcs, the
shut gate between you, noticed you on their very first thought and were at the
gate before it had moved. Anything moved outright between steps is the same:
a reset shuts the gate, and until the world steps a ray still finds it up. The
rays are brought up to date by hand now, before the first step and after every
reset.

**The fifth fighter was one bit too many.** Every fighter had three collision
bits of its own — body, weapon, hull — which left room for four in sixteen, and
the pen's two orcs made five. But no hull ever needed telling from another:
every hull bumps into every other, whoever's side it is on, and nothing meets
its own colliders anyway. The hulls share one bit now, and at two bits a
fighter there is room for six.

**The ninth fighter needed fewer bits each, not more.** Two bits a fighter
gave out at six, and the rooms off the hall hold eight things that want to
kill you. But "everyone's but mine" never needed a bit of my own: it needs a
set of bits that nobody else's set sits inside. Every fighter's body is three
of six body bits now, and its weapon three of six weapon bits — there are
twenty ways to pick three of six, and no three sits inside another — so a
filter of the three it has not got meets every other three and never its own.
Which side a weapon cuts comes out of the same bits: yours all have the first
bit and theirs never do, so every one of theirs has a bit that nobody on your
side has, and a filter of the bits your side lacks catches all of their side
and none of yours. Fifteen bits hold eleven fighters, one against ten.

**A vault that rises from its first step never gets a hand on the top.** The
first vault drove the body along one curve from where it stood, up, over and
down, so it was climbing from the moment it set off — and the hand that was to
go down on the top was still more than half a metre short of it as the body
went over. A body does not rise until it springs. It runs in level now, takes
off just short of the near side, and the hand has something to go down on.

**A knee brought up in front of a body hanging off a wall is a knee in the
wall.** The first climb brought a knee up as soon as the hands had the edge,
the way a climb is usually drawn, and the knee went twenty centimetres into
the face. The knee stays down and the foot tucked under the hips until the
hips are up past the top now, and the harness measures the legs' own colliders
against the stone for the whole of both moves, not just the hull.

**Easing a foot down to the floor put it through the edge.** Between a posed
leg and one standing on the top, the leg was eased from the one's angles to the
other's, and halfway there it described a leg that was neither, whose foot was
in the stone. A key that puts a foot down now takes its angles from the pose
beside it, so between the two only how much of the leg the floor has changes.

**Reach is measured at the height of what you swing at.** Every creature
measures how far its weapon reaches level with your chest, and for everything
up to now that was where it swung. A kobold swings at your legs half the time,
and measured at your chest, with its short arm reaching up for it, its reach
came out at half a metre: it stood on your toes to swing, and hacked at you on
the way back as much as on the way through. Reach is measured now at whichever
of your head, your middle and your legs a creature goes for most.

**A body's velocity is its centre of mass's.** Rapier's `linvel()` is how fast
a body's centre of mass is going, and a point on it goes at that plus the spin
about the centre of mass. Every speed on a weapon — where a blow landed, how
fast the tip was going — was worked out with the spin about the grip instead,
where the weapon's body has its origin, and a sword's centre of mass is 54
centimetres up the blade, an axe's 79. So every point of a turning weapon was
given its centre of mass's swing a second time: eleven metres a second on the
sword at 20 rad/s, all of it along the swing. Across every blow in the harness
the blades had arrived at about two thirds of the speed they were scored at,
and the slowest "hits" were mostly a blade resting on something while the arm
turned. Measured honestly, the same swings did half the damage, cut a third
less often and shoved a third less hard, and an opponent saw a third of the
cuts coming at it. Everything set against those speeds was fitted again to the
same seven thousand blows on flesh, nine hundred clashes and eighty-nine
thousand looks at a blade coming: each weapon's threshold and bite, so that as
many of its blows get past the one and it does as much in all (a spear, whose
point barely turns in a thrust, lost least, and now draws blood more often and
less each time); when a weapon is knocked aside, and how hard; when an opponent
reads a swing, stops one or leads it; and how much of itself the ogre puts
behind its club, a quarter where it was a tenth, so that its upswing still
lifts you as high. Balance came only part of the way back. Planted feet soak up
the same speed of every blow, a bigger share of a slower one, and a Froude
number any lower than 0.26, two thirds of what it was, has the harness's
middling blow floor a goblin it should only stagger: an orc's axe rocks you
about half as often as it did. A throw had it right all along: it leaves at the
palm's speed about the forearm's centre of mass. The blade speeds quoted
elsewhere in this document were measured about the grip, and most are half as
high again as the blade was really going.

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
(lean, bend, shrug and head-tracking, and the hips and chest walking and
breathing), `hips' share of a turn`, and `clearance
from body` (how far the target pose keeps off your own chest and hips; 0 turns
off both clearance layers). The angular drive adds `grip twist`: how hard the
forearm turns the weapon in the hand — weak, and a blow on the flat knocks the
edge off line — and `wrist`: how hard it bends the weapon back onto the line
you aimed along. The wrist is far stiffer than a real one on purpose, and its
range starts above where the resting arm begins to shake. Input adds `flick speed cap` and `flick accel cap`: anything
slower reaches the arm untouched.

Impact adds three, and they apply to every blow, yours and theirs: `arm behind the
blow`, how much of the swinging arm's weight lands with the weapon — at 0 only
the steel arrives and nobody is knocked over, which is the truth about a sword
on its own — and `balance`, the Froude number, how big a shove anything can
step out of. Lower it and everything goes over more easily, but the orc still
takes five times what the goblin does: it weighs five times as much. And
`weapon knocked aside`: how much of its strength an arm loses when its weapon
is knocked by a heavier blow, at 0 none, and the weapon is held wherever it is
hit.

Movement adds `step ease` — how long the feet take to get to walking pace and
to stop, everyone's — `pivot speed`, how fast Shift and a turn take you round
on your heel, everyone's too, `quick step` and `quick step rest`, how fast a
double tap throws you as a multiple of walking pace and how long until the
next, everyone's as well, `jump height` and `air control`. Presets: **heavy** (a sword that
fights you), **rigid** (a robot arm — useful as a control), **noodle** (too weak
to lift it). Try `rigid` for ten seconds to hear what the mechanic sounds like
when you take the clamp away.

The arm's knobs drive your arm only. An orc's force budget is its own, scaled
from its size. The world's — gravity, the impact knobs, step ease, the pivot
and the quick step — are everyone's.

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
- **An opponent that loses you goes to look, then goes home.** It walks to
  where it last saw you, a little further the way you were going, and looks
  round. It does not know where you went, only where you were. If it finds
  nothing, it walks back to its post the way it came.
- **An opponent sometimes steps out of your swing.** It saw it start, and moved
  a reaction time later — so a quick cut usually lands and a slow, big one often
  does not. Never in the middle of a swing of its own. The goblin does it
  most; the orc hardly ever.
- **Back away from the orc and it jumps at you.** Axe up, one jump, and the
  axe down at the top of it. It cannot change its line once its feet leave the
  floor: step aside then, not before.
- **An opponent sometimes darts in and straight back out without swinging.**
  That is a feint with its feet. Its weapon stays at the guard; only a real
  swing draws it back.
- **An opponent sometimes steps into your reach and stands there.** It is
  offering you a target. Swing, and it is already on its way out; miss, and it
  steps back in.
- **Your sword gets knocked aside.** Something heavier met it — the orc's axe
  above all — and your arm gives for a moment before it brings the sword back
  to where you are aiming. Hold a guard against the orc and it goes through.
- **Nothing tells you what an opponent is about to do.** The fight panel says
  whether it has seen you and whether it can still fight, and that is all.
  What is coming is on its arm: watch the weapon go back, and where to.
- **The swordsman goes for your sword arm.** As readily as your head. Losing
  it ends the fight without the fight being won.
- **The goblin backs away when you come for it.** It goes round you out of your
  reach and gives ground as you close. Pin it against a wall, or stay in its
  face, and it swings the shaft at you — the one swing it has up close, and a
  poor one.
- **At the very end of a cross-body cut the blade drifts a few degrees back
  toward your left shoulder.** With the elbow kept out of the ribs the forearm
  points back over it; the wrist bends the blade onto the line you aimed along,
  but a wrist only bends so far, and past about fifty degrees the rest shows.
- **The weapon turns and bends in your hand when you have not rolled it.** That
  is the forearm keeping your edge and the wrist keeping your line while the
  body moves your elbow. Watch `grip twist` and `wrist bend` in the HUD: at the
  guard both read zero.
- **Hold a big turn and you step.** The hips come round under the chest, and
  when they have turned far enough over planted feet, the feet follow — the
  leading one first.
- **The ghost hand can wait for your arm.** With *show ghost hand* on, a flick
  shows the ghost sweeping round rather than jumping, and slowing when a heavy
  blade falls far behind it. The mouse's aim itself is never touched.
- **The orc does not move when you hit it.** It is not resisting. It weighs
  173 kilograms, and its feet soak up what your sword gives it. The same swing
  puts a goblin on its back.
- **You get knocked down too.** The rules are the same for everyone: the orc's
  axe staggers you, and a hard enough blow floors you for the best part of two
  seconds while it keeps coming. Your arm hangs while you are down; the mouse
  does nothing until you are up and the sword is back at the guard.
- **A stagger costs your feet, not your arm.** While you reel you cannot walk,
  sidestep or jump, but you can still swing.
- **Your shield stays where you left it.** Let go of the left button and it
  holds that guard, as the sword holds its aim. An empty off hand goes back to
  hanging in front of you.
- **A blocked blow can still put you on your back.** The shield stops the
  blade, not the weight behind it.
- **F does nothing with your sword drawn.** The hand that picks things up is
  the one holding it. X first.
- **F puts a head in your bag rather than picking the next thing up.** With
  something in your hand, that is what F does. Press it again for the next.
- **Your sword comes out and the head you were holding hits the floor.** The
  hand lets go of it to take the sword. F first, to keep it.
- **G throws what you hold across the room.** Your arm was moving: what
  leaves your hand leaves it moving as your hand was. Hold the mouse still
  to put it down.
- **A thrown head hurts nobody.** It knocks into bodies as the weight it is,
  but a blow is something a weapon in a hand does.
- **A thrown axe goes straight through the orc.** A weapon nobody is swinging
  meets only the floor, the walls and other blades — the same rule that keeps
  the one you drop from taking your foot off.
- **Something you let go of turns up in front of you rather than in your
  hand.** Your hand had it in a wall, or in the floor, and it cannot be let go
  of there.
- **The orc's axe in your hand cuts nothing.** You are holding it, not
  wielding it: it is out of the world until you take it up with X.
- **The orc's axe is slow in your hand.** It weighs what it weighs, and your
  arm is a man's. The orc swings it on an orc's strength.
- **The goblin's spear does nothing close in.** Its point is past anything a
  sword's length away, and what reaches it is the shaft. Stand off, and
  thrust.
- **F takes the body away from you for a moment.** It walks you over, turns
  you, and puts you on your haunches. Press a key and you have it back.
- **X takes a second, and a sword half put away is not one you can swing.**
  Between the mouth of the scabbard and the hand it is out of the world, and
  cuts nothing.
- **H does nothing with a sword in one hand and a shield on the other arm.**
  Drinking takes a free hand. Z puts the shield on your back, and the hand is
  free.
- **A shield on your back only guards your back.** It stops a cut from behind
  and nothing from in front; Z again to have it on your arm, where you can
  put it in the way.
- **The inventory does not pause the fight.** B opens it over whatever is
  going on, and the mouse still moves your sword.
- **Space puts you on top of a low wall instead of jumping.** Only when you
  are moving forward at something you can stand on; standing still it is a
  jump. Going over it is V's.
- **An opponent you have disarmed backs away bent over, holding the stump.**
  It is beaten, not dead. So are you, if it happens to you — unless you are
  steering that hand, or it has a shield on it.
- **No two bodies fall the same way.** A body that dies standing is given a
  small tip of its own, in a direction nobody chose, as well as whatever the
  killing blow did.
- **Standing still gets you killed** — by the orc in about a minute, by the
  goblin in about two, and much faster by both, if you manage to bring them
  together. Twice as fast, while blades passed through bodies: your guard,
  held still, now stops blows that used to go through it.
- **An opponent that misses you can swing again at once.** From where the
  miss ended, drawn back a little way. Not after a swing that landed.
- **The orc turns its back on you.** It is going round after an axe that met
  nothing, and the axe is coming round again. Go in.
- **Shift and A spins you round.** On your heel, fast. It is how anything
  carries a swing round.
- **An opponent's weapon moves when it is not swinging.** Its guard is held
  where its last swing left it, shifts, and sways. Only a weapon going back is
  a swing coming.
- **It swings while it is still walking at you**, and **it backs off as its
  weapon goes back, then comes at you.** Both are drawn back first.
- **It puts its weapon in the way of yours** when it sees yours go back. The
  orc's, still moving as yours meets it, knocks yours aside.
- **It lets go of a swing when you cut it.** Not the orc.
- **A cut leg slows you down.** Anybody's. A potion mends it.
- **A badly hurt orc stops waiting.** A badly hurt goblin stops coming.
- **The orc beats the floor with its axe.** You are out of its reach; it is
  telling you what it thinks of that.
- **Tapping W twice throws you a metre.** Two short taps of the same key, close
  together. A key held, tapped slowly, or with another between is a walk.
- **It comes at you from the side.** A quick step in on a slant lands it round
  your side and turned off you, and it squares up before it swings. Turn to
  meet it.
- **Your arm trails a quick step.** Anybody's does. The hand is damped against
  its speed through the world, and a body going at twice walking pace leaves it
  behind for a moment.
- **F does nothing at the lever with your sword drawn.** The hand that pulls it
  is the sword hand. X first, as for anything F does.
- **The lever takes a moment, and your hand lags it.** It is sprung, and the
  arm pulls it down against the spring under the same clamp as a swing. The
  body leans in to do it.
- **Your sword goes straight through the lever.** It is scenery to a blade,
  like the door frames. Only a hand moves it.
- **Let go of the lever halfway and it springs back up.** A blow, or a key of
  your own, and the gate stays shut. It only stays down once it has caught.
- **The gate does not come down again.** Once the lever has caught, the gate is
  up until a reset.
- **Two orcs come out when the gate goes up, though they never saw you.** They
  heard it. They come to look, and from the doorway you are in plain sight.
- **Pull the lever and walk away, and they go back in.** They look round the
  gateway, find nobody, and walk home to wait by the open gate.

## Structure

```
src/
  main.ts            wiring, camera, the gates' noise, and what is shown
  tuning.ts          every constant that shapes the feel
  core/
    loop.ts          fixed 60Hz accumulator
    physics.ts       Rapier world, and three bits of six for each fighter's
                     body and weapon
    renderer.ts      three.js scene
    interpolate.ts   render interpolation between physics states
  input/input.ts     pointer lock, accumulated deltas
  game/
    arm.ts           THE MECHANIC — read this one first
    weapons.ts       sword, axe, spear, hatchet, club: masses, leverage, what
                     bites -- or, for a club, how far it comes back off you --
                     and inertia
    species.ts       the bestiary — a size, a weapon, the shapes of swing it
                     knows, and what it looks like
    look.ts          faces, clothes, harness, helm, tail and claws: what a
                     creature wears over its shells, and the woven, grained,
                     mottled and scaled surfaces they are made of
    anatomy.ts       one set of proportions, scaled to any body
    fighter.ts       torso, locomotion, the jump, the climb and the vault, feet
                     that stay planted and step round a turn, a stride that goes
                     the way the body does, legs that bend into a crouch or a
                     stoop, and a body that can be knocked over and get back up
    traverse.ts      the vault and the climb as a body does them: poses keyed
                     to the landmarks along the way, and how fast it goes
                     between them
    posture.ts       how the trunk carries the arm: lead, girdle, lean, gaze,
                     how far a crouch sinks it and a stoop bows it over, the
                     hips and chest walking with the legs whichever way they
                     go, breathing, and curling round a lost arm
    ragdoll.ts       a body with nobody in it, or knocked flat: hips, legs and
                     waist let go -- braced going over, gathered to get up
    offarm.ts        the other arm: a ghost hand of its own, a shield on it, and
                     slinging that shield onto the back and taking it down
    shield.ts        a round shield: what it weighs, how it is drawn, and where
                     it rides on the back
    drive.ts         an angular PD held inside what each axis's inertia can take
    items.ts         potions, the shield, the rack, what was cut off somebody
                     and their weapon: taking them, holding them, letting go
                     of them and throwing them
    remains.ts       what comes off a body, and the weapon a dead hand lets go of
    inventory.ts     the bag: potions, and pieces of other people put in it
    pickup.ts        F: walking over, getting down to it, and reaching for it --
                     or taking hold of a lever and pulling it down
    clearance.ts     keeping the arm out of its own chest and hips
    motion.ts        the two filters: intent that must not lag, bodies that should
    arena.ts         a hall and the entrance to it, four rooms off it behind
                     gates, things to climb, vault and jump, the gatehouses,
                     where everything waits, and where the things lying about go
    roster.ts        who waits behind which gate, and who hears one go up
    gate.ts          a gate, winched up into its gatehouse, and the lever on
                     the wall beside it: a sprung bar on a pin that a hand
                     takes hold of and pulls down until it catches
    combatant.ts     a fighter, their arm, and what a cut or a blow does to them
    ai.ts            the opponent's brain — mouse deltas and your keys, nothing
                     more; and what it does about a noise it hears
    cutting.ts       swept-segment hit detection: the backstop for a blade already inside someone
    dummy.ts         the practice dummy, and how it comes apart
    damage.ts        the damage curve
    balance.ts       what a blow does to a body that has to stay on its feet,
                     and how far a club sends one that cannot
    skin.ts          the visible body: tapered shells over the capsules, full
                     where the muscle is
    blood.ts         droplets, and the two faces a cut leaves behind
    impacts.ts       contact events -> impact quality; gold sparks off stone, red off flesh
    targets.ts       collider -> name registry
    trail.ts         the swept arc
  ui/                HUD, tuning panel, and the inventory
tools/smoke.ts       headless harness driving the real modules
```

`npm run smoke` runs the real `Arm`, `Fighter`, `Arena`, `Dummy`, `Combatant`
and `Ai` against Rapier in Node — no WebGL, no browser, 444 checks in a few
minutes. It asserts the claim the design rests on: that the arm tracks the mouse
closely when free and *fails to* when blocked. If the second ever stops failing,
the mechanic is gone.

The dice the game rolls are loaded there. The AI rolls `Math.random()` for
nearly everything it decides, a body rolls for the way it falls when it dies
and a severed limb for its spin, and a check that follows a fight starts from
wherever the fight left things: with real dice the same code failed one check
on one run and four on the next. `tools/dice.ts` puts a seeded generator in
its place before anything else is loaded, and starts it again at the head of
every group of checks, from the seed and the group's name. The same code gives
the same result on every run, to the last digit of every measurement, and a
group rolls the same wherever it runs: first, last, or on its own. The seed is
printed at the top of the log and on its last line, and `SMOKE_SEED=7 npm run
smoke` rolls another set.

So there are two kinds of check. Most are rules: no NaN, no blade through
stone, never your own sword in you, every swing drawn back for. They hold
whatever the dice, and one that fails on any seed at all is a bug. The rest
are tendencies, marked `~` in the log: what the AI does often enough — the
orc's leap lands three times in five, the goblin quick-steps more than the
swordsman — taken over the random choices it makes in a fight. Even a sound
one misses on the odd seed, since anything that changes what is rolled, or
when, or how anything in a fight moves, deals the rest of its group different
dice. So each takes enough samples that luck alone should sink it on well
under one seed in a hundred, and a miss (`MISS`, not `FAIL`) is weighed
across seeds rather than read off one run: `npm run smoke:seeds -- --groups
<group> --against HEAD` runs a group on seeds 1 to 10 with the change and
without it, and says whether anything does worse. A tendency that misses too
often on luck gets more samples, never a lower bar. `SMOKE_ONLY=<group> npm
run smoke` runs one group, which gives exactly what it gives among the rest.

It also drives a real scripted swing all the way through to a severed limb,
takes a fighter apart and checks that a reset puts it back together — measuring
the joint anchor rather than the limb, because an arm attached to nothing still
hovers roughly where it belongs — jumps a fighter and measures where it lands, checks that an axe really does come
round slower than a sword on the same arm and the same command, shows that a
spear held by the butt swings markedly less far than a choked-up one, and runs
half a minute of live fight against each species to check it closes, swings,
lands cuts, and never exceeds the reach of its own arm. It holds the vault and
the climb to what they look like — legs out of the stone, a hand on the top,
the chest over the edge — puts a club and a blade of the same weight through
the same body to check the club throws it further and lifts it, has the ogre
swing up through you until it has floored you six times or most of a minute
has gone and checks you got up whole, and fades every creature to check
nothing it wears is left hanging in front of the camera.

It also holds the layout to its claims: that each room holds what it should,
behind a gate out of the hall with its lever on the hall's side; that a wall
stops a line of sight and the entrance does not; that an opponent which cannot
see you neither moves nor swings — and that walking into its room starts a
fight; that every gate, shut, stops a line of sight and the step probe as the
walls do, and is a doorway once it is up; and that the stones and the rail
take a jump, and walking does not get you onto or over any of them. And it
takes a joint apart to check that the cut reports two
faces to bleed from, that both are attached to something that is placed every
frame, and that the droplets fall, land and go.

And it holds the body to its claims: that the same cross-body sweep that went
twenty centimetres into the old rigid chest now stays out of it at three
heights, and a flick only grazes it; that nothing pushes on an arm at rest; that
the original flick no longer spins the forearm; that either hand raised from
its guard to overhead keeps its elbow under the arm, and the sword goes up with
it rather than dipping; that a drag reaches the ghost
with no lag at all and a flick arrives within a few frames; that the chest is
more than half turned before the hand crosses it while the hips lag behind;
that planted feet do not skate, step one at a time, and end up under the hips;
that a fighter stopped anywhere in a stride has both feet on the floor a third
of a second later, and one that has never walked stands on straight legs; and
that the shoulder a held aim settles to is exactly the one the opponent's
probes predicted.

And the grip: that each weapon's inertia is where its iron is — a one-part
sword exactly as Rapier had it, a spear that rolls like a shaft rather than a
pole; that the grip sits square when nothing needs it; that a roll toward the
chest turns the edge all the way without the body pushing or the hand moving;
that an elbow moved out of the ribs no longer takes the edge with it; that the
wrist is straight at the guard and, across the body, holds the blade on the
line the elbow lost; and that ten seconds of the worst input there is never
spins a weapon in anyone's hand or bends a wrist past its stop.

And it weighs blows: that one swing floors a goblin, shoves a man a centimetre
and leaves an orc where it stood; that a floored fighter lies there with
nothing driving it, gets up by itself, upright, at standing height, with its
sword arm on its shoulder, and comes at you again — three times over, and still
whole; that a stagger takes a goblin's thrust off it while it draws back,
until its feet are back; that forty seconds of the orc's axe rock you and forty of the
goblin's spear never move you at all; that your own real swings never move an
orc; that the dummy swings from a blow and settles before the next; that a
blade through two parts of a body carries one swing's weight; and that a corpse
comes to rest where it fell — its legs simulated and folded, nothing of it
higher than a knee, and, reset, standing on posed legs again with not one body
or joint left over in the world.

And it keeps a body a body: that walking, the hips turn and tilt with the
stride and the body dips, while the chest turns against them; that the chest
the sword shoulder hangs from is exactly the one drawn; that standing still the
walk is gone and the chest breathes; and that a fighter who loses its sword arm
curls over the wound and holds it — the socket, or the stump, for a man, an orc
and a goblin — and keeps holding it while it backs away, the stump held in.

And it holds the opponents to their footwork: that between swings each one goes
round you — metres of it, where the old one managed centimetres — and not
always the same way round; that the orc spends more of a fight swinging than
the others, while the goblin goes round you out of your sword's reach and gives
more ground; that the goblin steps out of cuts it sees coming, and never out of
the middle of a swing of its own; that crowded, every one of them still
swings, and the goblin swings its shaft; that the step probe finds the wall
behind you and open floor where there is nothing; and that a swordsman fought
into a corner turns back at the walls instead of walking into them.

And it holds them to swinging the way you do: half a minute against each, in
which every swing is drawn back first and for no set time, the axe comes back
slower than the sword, the swings go for more of you than one place and no two
are the same, and nothing but the arm gives one away; that the orc brings the
axe over the top three times in four wherever it has the choice, across two
thousand swings made up and never thrown; and that a swing at your legs from
the orc really does pass under a jump.

And it holds the orc's leap to its claims, ten times standing still and ten
times stepping aside, in the bare cell: that once you have been in its reach
and got out of it, it leaps nearly every time, its feet leaving the floor by
half a metre; that the axe is up before it jumps and comes down in the air;
that it lands on someone who stands there and misses someone who steps aside as
it jumps; and that it walks up to you, rather than leaping, the first time.

And it holds the new kit to its claims: that the other arm and the head hold
still standing, and the arm settles back where it hangs after a walk; that X
takes about a second, the hand going up over the shoulder with the sword and
staying within a few centimetres of the grip all the way in, with nothing about
it a snap; that the sword is then out of the world, with the empty hand steady,
and stays within millimetres of the scabbard while you walk and turn; that it
is drawn back into the hand within half a millimetre, and that an arm cut off
halfway leaves it on the back; that nothing is picked up with the sword drawn
or on its way to your back, a potion heals over seconds and never past full,
and with a shield on one arm and a sword in the other there is no hand to drink
with; that the rack gives the shield and takes it back; that F walks over to a
potion, gets down to it, and takes it only once the hand is on it, and that a
key of your own calls it off while one already held does not; that a blade
meeting a shield is stopped, the body behind it is cut a third as much, and the
blow's weight still arrives; that the left button raises the shield and the
sword holds its aim meanwhile; that a crouch lowers the head and chest a third
of a metre with both feet on the floor, and halves your pace; that W and Space
climb the ledge, the crate and the crate then the ledge, with the hands on the
edge, and not a wall or a pillar; and that V vaults the low wall and the block
and does nothing at a pillar.

And the new kit after that: that Z puts the shield on your back in under a
second, the hand going up over the shoulder with it, and takes it down the
same way; that on the back its collider leaves the arm for the back and stays
where the shield is drawn, face out, walking and turning; that the empty hand
hangs at rest and drinks with the sword still drawn, and back on the arm the
shield has a collider there again and holds its guard; that on a body turned
away, a dozen cuts across its back meet the shield slung there, do a ninth of
the damage, and still land their weight, while the same cuts to its front
land as hard as without it; that on your back it is still the
one shield, the rack takes it back from there, and an arm cut off going for it
leaves it there with nothing to take it down; that a head and a forearm with
its sword in it come off and lie on the floor as three things to take; that F
goes for the head and keeps it in the hand, where nothing of it is drawn or
touched, the hand takes nothing else and F offers to bag it; that F again puts
it in the bag, and out of the bag it comes back into the hand; that G from a
still hand lets go of it exactly where the copy in the hand was, and it drops
to the floor; that F takes the sword out of the dead fist, leaving the fist on
the forearm and the forearm lying there for the next F; that drawing your own
sword lets go of it, and it falls without cutting you; that let go of facing a
wall it stays out of the stone and settles with no more speed than its fall
gave it; that a reset puts every piece back on, from the hand and the bag, and
the sword back in the fist; and that Z, B, G and the numbers are where the
HUD says.

And that what you hold can be thrown: that let go of at the fastest of an
overhand swing the head leaves at exactly the palm's speed and the forearm's
spin, and flies more than two and a half metres within a few degrees of the
way the hand was going; that it passes through the hand that threw it for the
steps it takes to clear it, and meets you as it did before after that; that
a whole arm thrown underhand leaves as one, its halves moving together and
the elbow holding, and lands ahead; that a sword thrown the same way lands
ahead and hurts nobody; that thrown at a wall a pace off, the head stops at
the stone and falls back into the room; that where the copy in the hand is in
the floor, it is put down in front of you instead, still; and that a reset
while one is still leaving the hand gives it back what it meets.

And that the orc's axe, taken off it dead, is a weapon in your hand: that X
takes it up with the axe's weight and shape, jointed in your hand, your sword
drawn in its scabbard and the orc's axe out of the world; that swung at the
dummy every hit is the axe's; that ten seconds of the worst input there is
spins nothing in your hand, as for every weapon in its owner's; that X again
puts it up, your sword back on your back at its own weight; that let go of
while wielded it is where yours was, falls, and cuts nobody; that F bags it
straight out of the fight; and that a reset puts your sword back in your hand,
the axe back in the orc's, and your sword cuts as a sword again. And that it
is not only the axe: that every weapon anything carries — every one in the
list, and whatever the bestiary carries besides — is taken off whatever
carries it, dead, taken up, and swung at the dummy with that creature's own
first shape of swing, a thrust from a spear's distance, landing every time as
itself and cutting; that nothing spins in your hand under the same ten seconds
of abuse; and that X puts it up again.

And the lever and the pen: that with the sword drawn F goes nowhere and the
prompt says to put it up; that F walks you over to the lever and the hand goes
up to within a couple of centimetres of the handle, and nothing moves the
lever until the hand has hold of it; that the hand stays on the bar, jointed
there to within a millimetre, the whole way down, the body leaning in and the
arm never flailing; that the lever catches and stays down and the hand lets go
of it, and the gate starts up about half a second later and is clear of its
doorway in under four; that a lever that is down is not offered again; that a
reset puts it up and shuts the gate; and that let go of halfway, it springs
back up and nothing opens. That the game's nine fit in the collision groups,
every weapon reaching whoever it should and nobody else, and every hull still
bumping into every other. And, with all nine in one arena: that behind the
shut gate the pen's two hold their posts, facing it, within noticing distance
of you and unable to see you; that the gate going up is heard in the pen and
behind no other gate; that they come out through the gateway, find you, and
swing, without a cut between them; and that with nobody to find, they look,
give it up, and go home.

## Stack

TypeScript · Vite · three.js · [Rapier](https://rapier.rs) (Rust→WASM).

Physics is a fixed 60Hz accumulator with render interpolation — stiff PD drives
explode under a variable timestep. CCD is on for the weapon and forearm; without
it a fast tip tunnels straight through the thin post.

## What's next

Rounds and a reason to be in the rooms. Friendly fire. A thrown
axe that cuts, and a thrown head that staggers whoever it hits. A scabbard or a belt
for what you take off someone, so the orc's axe can go on you rather than in a
bag. A shield for an opponent, and the second hand a spear actually
wants. Blood that stays on the
floor, and on the blade.
