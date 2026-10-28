// Seesaw sketch with positional feedback, using ticController.js
// Start homes the motor to position 0, then swings it back and forth between
// MIN_POSITION and MAX_POSITION. Stop sends it back to 0 and deenergizes it.
// Unlike p5Tic_seesaw, this reads the motor's actual position back from the
// Tic and only turns around once it has really arrived.
// Speed, acceleration and deceleration have sliders (±20% of SETTINGS); the
// rest is fixed, so this uses its own controls instead of tic.createControls().

const SETTINGS = {
  stepModeIndex: 2, // TIC_STEP_MODES[2] = 1/4 step
  maxSpeed: 15_000_000, // microsteps per 10,000 s (= 1500 microsteps/s)
  maxAccel: 150_000, // microsteps per 100 s^2 (= 1500 microsteps/s^2)
  maxDecel: 150_000,
  current: 1092, // mA
};
const MIN_POSITION = -3000; // microsteps
const MAX_POSITION = 3000;
const POLL_MS = 50;
const SLIDER_RANGE = 0.2; // sliders go from 20% below to 20% above SETTINGS

let tic;
let state = "idle"; // idle → starting → homing → swinging → returning → idle
let target = 0;
let status = null; // last status read from the Tic, see TicController.getStatus
let isPolling = false;
let lastPoll = 0;
let startButton, zeroButton;
let applyTimer = null;

function setup() {
  createCanvas(windowWidth, 260);
  textFont("monospace");

  tic = new TicController({ product: "T500" });

  const add = createButton("Add Tic…");
  add.mousePressed(() => tic.addTic()); // needs a user gesture
  startButton = createButton("Start");
  startButton.mousePressed(toggle);
  // Declare wherever the motor is now as position 0.
  zeroButton = createButton("Set 0 here");
  zeroButton.mousePressed(() => tic.haltAndSetPosition(0));
  // One-off read, logged to the console, for checking feedback works.
  const read = createButton("Read status");
  read.mousePressed(async () => console.log(await tic.getStatus(0)));

  addTicStyles();
  const panel = createDiv().class("tic-panel");
  motionSlider(panel, "max speed", "maxSpeed", 100_000);
  motionSlider(panel, "acceleration", "maxAccel", 1_000);
  motionSlider(panel, "deceleration", "maxDecel", 1_000);

  tic.scanForTics();
  window.addEventListener("beforeunload", () => tic.disconnectAll());
}

function draw() {
  background(24);
  pollStatus();

  // Each time the motor reaches its target, pick the next one. Checking the
  // Tic's own target too ignores reads from before the last move was sent.
  if (status && status.currentPosition === target && status.targetPosition === target) {
    if (state === "homing") {
      state = "swinging";
      moveTo(MAX_POSITION);
    } else if (state === "swinging") {
      moveTo(target === MAX_POSITION ? MIN_POSITION : MAX_POSITION);
    } else if (state === "returning") {
      state = "idle";
      tic.deenergize(0);
    }
  }

  drawSeesaw();

  fill(240);
  noStroke();
  textSize(14);
  text(`state: ${state}  target: ${target}`, 16, 24);
  if (status) {
    text(
      `position: ${status.currentPosition}  velocity: ${status.currentVelocity}  tic: ${status.operationState}`,
      16, 44
    );
    text(`errors: ${status.errors.join(", ") || "none"}`, 16, 64);
  } else {
    text("position: no reading", 16, 44);
  }
  text(`${tic.ticListMessage} · ${tic.lastMessage}`, 16, 84);
  fill(255, 120, 120);
  text(tic.lastError, 16, 104);

  startButton.html(state === "idle" ? "Start" : "Stop");
  startButton.elt.disabled = state === "starting" || state === "returning";
  zeroButton.elt.disabled = state !== "idle";
}

async function toggle() {
  if (state === "idle") start();
  else if (state === "homing" || state === "swinging") {
    state = "returning";
    moveTo(0);
  }
}

async function start() {
  if (!tic.motors[0]) {
    tic.lastError = "No Tic connected. Try Add Tic first.";
    return;
  }
  state = "starting";
  await tic.setStepMode(0, SETTINGS.stepModeIndex);
  await tic.setMotionLimits(0, SETTINGS);
  // keepAlive stops the Tic's command timeout from halting it between moves.
  if (!(await tic.resumeAndEnergize(0, { keepAlive: true }))) {
    state = "idle";
    return;
  }
  state = "homing";
  moveTo(0);
}

// A slider for one of the SETTINGS, ±SLIDER_RANGE around its starting value.
// While running, changes are sent to the Tic (debounced, like the panels in
// ticController.js) and take effect on the move in progress.
function motionSlider(parent, title, key, step) {
  const value = SETTINGS[key];
  const low = Math.round((value * (1 - SLIDER_RANGE)) / step) * step;
  const high = Math.round((value * (1 + SLIDER_RANGE)) / step) * step;
  ticSlider(parent, title, low, high, value, step, (v) => {
    SETTINGS[key] = v;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      if (state !== "idle" && tic.motors[0]) tic.setMotionLimits(0, SETTINGS);
    }, 250);
  });
}

function moveTo(position) {
  target = position;
  tic.setTargetPosition(0, position);
}

// Reads the Tic's status, rate-limited and one read at a time.
function pollStatus() {
  if (!tic.motors[0] || isPolling || millis() - lastPoll < POLL_MS) return;
  isPolling = true;
  lastPoll = millis();
  tic
    .getStatus(0)
    .then((s) => {
      if (s) status = s;
    })
    .finally(() => (isPolling = false));
}

function drawSeesaw() {
  const pivotY = 200;
  const length = min(width - 64, 500);
  const tiltOf = (position) => map(position, MIN_POSITION, MAX_POSITION, -0.3, 0.3);

  fill(80);
  noStroke();
  triangle(width / 2, pivotY, width / 2 - 20, pivotY + 40, width / 2 + 20, pivotY + 40);

  push();
  translate(width / 2, pivotY);
  rectMode(CENTER);
  // Faint outline where it's heading, solid where it actually is.
  noFill();
  stroke(80, 160, 255, 90);
  push();
  rotate(tiltOf(target));
  rect(0, 0, length, 10, 5);
  pop();
  if (status) {
    noStroke();
    fill(80, 160, 255);
    rotate(tiltOf(status.currentPosition));
    rect(0, 0, length, 10, 5);
  }
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, 260);
}
