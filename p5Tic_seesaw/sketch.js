// Seesaw sketch using ticController.js
// Start homes the motor to position 0, then swings it back and forth between
// MIN_POSITION and MAX_POSITION. Stop sends it back to 0 and deenergizes it.
// The motion settings are fixed here, so this uses its own buttons instead of
// tic.createControls().
//
// The Tic moves with a fixed profile (accelerate, cruise, decelerate), so the
// sketch works out how long each move takes from SETTINGS instead of reading
// the motor's position back.

const SETTINGS = {
  stepModeIndex: 2, // TIC_STEP_MODES[2] = 1/4 step
  maxSpeed: 15_000_000, // microsteps per 10,000 s (= 1500 microsteps/s)
  maxAccel: 150_000, // microsteps per 100 s^2 (= 1500 microsteps/s^2)
  maxDecel: 150_000,
  current: 1092, // mA
};
const MIN_POSITION = -3000; // microsteps
const MAX_POSITION = 3000;
const SETTLE_MS = 150; // extra wait after each move, for USB latency

// Same limits in microsteps per second (and per second squared)
const SPEED = SETTINGS.maxSpeed / 10_000;
const ACCEL = SETTINGS.maxAccel / 100;
const DECEL = SETTINGS.maxDecel / 100;

let tic;
let state = "idle"; // idle → starting → homing → swinging → returning → idle
let move = { from: 0, to: 0, start: 0, duration: 0 };
let startButton, zeroButton;

function setup() {
  createCanvas(windowWidth, 220);
  textFont("monospace");

  tic = new TicController({ product: "T500" });

  const add = createButton("Add Tic…");
  add.mousePressed(() => tic.addTic()); // needs a user gesture
  startButton = createButton("Start");
  startButton.mousePressed(toggle);
  // Declare wherever the motor is now as position 0.
  zeroButton = createButton("Set 0 here");
  zeroButton.mousePressed(() => tic.haltAndSetPosition(0));

  tic.scanForTics();
  window.addEventListener("beforeunload", () => tic.disconnectAll());
}

function draw() {
  background(24);

  // Each time the current move has had time to finish, pick the next one.
  if (millis() - move.start >= move.duration + SETTLE_MS) {
    if (state === "homing") {
      state = "swinging";
      moveTo(MAX_POSITION);
    } else if (state === "swinging") {
      moveTo(move.to === MAX_POSITION ? MIN_POSITION : MAX_POSITION);
    } else if (state === "returning") {
      state = "idle";
      tic.deenergize(0);
    }
  }

  drawSeesaw();

  fill(240);
  noStroke();
  textSize(14);
  text(`state: ${state}  position (estimated): ${round(estimatedPosition())}  target: ${move.to}`, 16, 24);
  text(`${tic.ticListMessage} · ${tic.lastMessage}`, 16, 44);
  fill(255, 120, 120);
  text(tic.lastError, 16, 64);

  startButton.html(state === "idle" ? "Start" : "Stop");
  startButton.elt.disabled = state === "starting" || state === "returning";
  zeroButton.elt.disabled = state !== "idle";
}

async function toggle() {
  if (state === "idle") start();
  else if (state === "homing" || state === "swinging") {
    state = "returning";
    // The motor may be at full speed heading the other way, so allow time
    // for it to stop first.
    moveTo(0, { extraDistance: (SPEED * SPEED) / (2 * DECEL) });
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
  // We can't tell where the motor is, so wait long enough for the furthest
  // it could be from 0.
  moveTo(0, { distance: max(abs(MIN_POSITION), abs(MAX_POSITION)) });
}

function moveTo(position, { distance, extraDistance = 0 } = {}) {
  const from = estimatedPosition();
  distance ??= abs(position - from);
  move = { from, to: position, start: millis(), duration: profile(distance + extraDistance).duration };
  tic.setTargetPosition(0, position);
}

// Accelerate up to SPEED (or as near as the distance allows), cruise, then
// decelerate to a stop. Times in ms.
function profile(distance) {
  let peak = SPEED;
  if (distance < (peak * peak) / (2 * ACCEL) + (peak * peak) / (2 * DECEL)) {
    peak = sqrt((2 * distance) / (1 / ACCEL + 1 / DECEL));
  }
  const accelTime = peak / ACCEL;
  const decelTime = peak / DECEL;
  const cruiseTime =
    peak > 0 ? (distance - (peak * peak) / (2 * ACCEL) - (peak * peak) / (2 * DECEL)) / peak : 0;
  return {
    peak,
    accelTime: accelTime * 1000,
    cruiseTime: cruiseTime * 1000,
    duration: (accelTime + cruiseTime + decelTime) * 1000,
  };
}

// Where the motor should be now, for drawing.
function estimatedPosition() {
  const distance = abs(move.to - move.from);
  const p = profile(distance);
  const t = min(millis() - move.start, p.duration) / 1000;
  const t1 = p.accelTime / 1000;
  const t2 = t1 + p.cruiseTime / 1000;

  let travelled;
  if (t < t1) travelled = 0.5 * ACCEL * t * t;
  else if (t < t2) travelled = 0.5 * ACCEL * t1 * t1 + p.peak * (t - t1);
  else {
    const td = t - t2;
    travelled = 0.5 * ACCEL * t1 * t1 + p.peak * (t2 - t1) + p.peak * td - 0.5 * DECEL * td * td;
  }
  return move.from + Math.sign(move.to - move.from) * min(travelled, distance);
}

function drawSeesaw() {
  const pivotY = 160;
  const tilt = map(estimatedPosition(), MIN_POSITION, MAX_POSITION, -0.3, 0.3);

  fill(80);
  noStroke();
  triangle(width / 2, pivotY, width / 2 - 20, pivotY + 40, width / 2 + 20, pivotY + 40);

  push();
  translate(width / 2, pivotY);
  rotate(tilt);
  fill(80, 160, 255);
  rectMode(CENTER);
  rect(0, 0, min(width - 64, 500), 10, 5);
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, 220);
}
