// Face-tracking version of the p5TicControl sketch.
// ml5 faceMesh finds a face in the webcam; its horizontal position is mapped
// to an angle (0–180° by default) and each energized Tic is sent there using
// position control instead of velocity.
//
// The Tic counts position from wherever the motor was at power-up, so line the
// shaft up with your 0° mark and press "Set 0° here" before tracking.

const VIDEO_W = 640;
const VIDEO_H = 480;
const SEND_INTERVAL_MS = 50; // max rate of position updates per motor

let tic;
let panels = [];
let video;
let faceMesh;
let faces = [];
let modelReady = false;

let faceX = 0.5; // smoothed face centre, 0 (left of screen) – 1 (right)
let hasFace = false;
let addButton;

function setup() {
  createCanvas(VIDEO_W, VIDEO_H + 60);
  textFont("monospace");

  video = createCapture(VIDEO, { flipped: true });
  video.size(VIDEO_W, VIDEO_H);
  video.hide();

  faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: false, flipped: true }, () => {
    modelReady = true;
    faceMesh.detectStart(video, (results) => (faces = results));
  });

  tic = new TicController({ product: "T500" });

  addButton = createButton("Add Tic…");
  addButton.mousePressed(async () => {
    const motor = await tic.addTic(); // needs a user gesture
    if (motor) buildPanel(motor);
  });

  // Reconnect any Tics this page was already allowed to use
  tic.scanForTics().then((motors) => motors.forEach(buildPanel));

  window.addEventListener("beforeunload", () => tic.disconnectAll());
}

function draw() {
  background(24);
  image(video, 0, 0, VIDEO_W, VIDEO_H);

  hasFace = faces.length > 0;
  if (hasFace) {
    const box = faces[0].box;
    const centre = (box.xMin + box.width / 2) / VIDEO_W;
    faceX = lerp(faceX, constrain(centre, 0, 1), 0.3);

    noFill();
    stroke(80, 255, 120);
    strokeWeight(2);
    rect(box.xMin, box.yMin, box.width, box.height);
  }

  // Face position marker
  stroke(80, 160, 255);
  strokeWeight(2);
  line(faceX * VIDEO_W, 0, faceX * VIDEO_W, VIDEO_H);

  for (const panel of panels) updateMotor(panel);

  noStroke();
  fill(0, 160);
  rect(0, 0, VIDEO_W, 80);
  fill(240);
  textSize(13);
  text(modelReady ? (hasFace ? "face found" : "no face") : "loading face model...", 12, 20);
  text(tic.ticListMessage, 12, 40);
  text(`message: ${tic.lastMessage}`, 12, 60);

  fill(255, 120, 120);
  text(tic.lastError, 12, VIDEO_H + 8, width - 24, 52);

  addButton.position(width - 100, 8);
}

// Sends the motor to the angle under the face. Rate-limited, and only sent
// when the target actually changes, so the USB queue never backs up.
function updateMotor(panel) {
  const motor = panel.motor;
  if (!motor.isEnergized || motor.isChangingEnergizedState) return;
  if (!hasFace && !panel.settings.returnHome) return; // hold last position

  const s = panel.settings;
  const x = hasFace ? (s.invert ? 1 - faceX : faceX) : null;
  const angle = x === null ? s.homeAngle : lerp(s.minAngle, s.maxAngle, x);
  panel.angle = angle;

  const target = Math.round(degreesToMicrosteps(angle, s));
  if (Math.abs(target - motor.targetPosition) < s.deadband) return;
  if (panel.sending || millis() - panel.lastSend < SEND_INTERVAL_MS) return;

  panel.sending = true;
  panel.lastSend = millis();
  tic.setTargetPosition(motor.motorNum, target).finally(() => (panel.sending = false));
}

function degreesToMicrosteps(angle, s) {
  const microstepsPerRev = s.stepsPerRev * TIC_STEP_MODES[s.stepModeIndex] * s.gearRatio;
  return (angle / 360) * microstepsPerRev;
}

// MARK: - Control panel

function buildPanel(motor) {
  if (panels.some((p) => p.motor === motor)) return;

  // Position mode wants faster limits than the velocity sketch's defaults.
  motor.maxSpeed = 4_000_000;
  motor.accel = 1_000_000;
  motor.deccel = 1_000_000;

  const settings = {
    stepsPerRev: 200,
    stepModeIndex: 0,
    gearRatio: 1,
    minAngle: 0,
    maxAngle: 180,
    homeAngle: 90,
    invert: false,
    returnHome: false,
    deadband: 1, // microsteps
  };

  const box = createDiv().class("panel");
  createElement("h3", motor.name).parent(box);
  const stateLabel = createDiv().class("caption").parent(box);
  const angleLabel = createDiv().class("caption").parent(box);

  const panel = { motor, settings, box, angle: 0, lastSend: 0, sending: false, applyTimer: null };

  const invert = createCheckbox(" invert direction", settings.invert).parent(box);
  invert.changed(() => (settings.invert = invert.checked()));
  const returnHome = createCheckbox(" go to home angle when no face", settings.returnHome).parent(box);
  returnHome.changed(() => (settings.returnHome = returnHome.checked()));

  slider(box, "min angle", 0, 360, settings.minAngle, 1, (v) => (settings.minAngle = v), (v) => `${v}°`);
  slider(box, "max angle", 0, 360, settings.maxAngle, 1, (v) => (settings.maxAngle = v), (v) => `${v}°`);
  slider(box, "home angle", 0, 360, settings.homeAngle, 1, (v) => (settings.homeAngle = v), (v) => `${v}°`);

  slider(box, "motor steps / rev", 24, 400, settings.stepsPerRev, 1, (v) => (settings.stepsPerRev = v));
  slider(box, "step mode", 0, TIC_STEP_MODES.length - 1, settings.stepModeIndex, 1, (v) => {
    settings.stepModeIndex = v;
    scheduleApply(panel);
  }, (v) => (v === 0 ? "full step" : `1/${TIC_STEP_MODES[v]} step`));
  slider(box, "gear ratio", 1, 20, settings.gearRatio, 0.1, (v) => (settings.gearRatio = v), (v) => `${v}:1`);

  slider(box, "acceleration", 50_000, 32_000_000, motor.accel, 50_000, (v) => {
    motor.accel = v;
    scheduleApply(panel);
  });
  slider(box, "deceleration", 50_000, 32_000_000, motor.deccel, 50_000, (v) => {
    motor.deccel = v;
    scheduleApply(panel);
  });
  slider(box, "max speed", 0, 100_000_000, motor.maxSpeed, 200_000, (v) => {
    motor.maxSpeed = v;
    scheduleApply(panel);
  });
  const maxIndex = motor.supportedCurrentLimitsMA.length - 1;
  slider(box, "current limit", 0, maxIndex, motor.currentIndex, 1, (v) => {
    motor.currentIndex = v;
    scheduleApply(panel);
  }, () => `${motor.selectedCurrentLimitMA} mA`);

  const energize = createButton("Energize").parent(box);
  energize.mousePressed(async () => {
    motor.isChangingEnergizedState = true;
    refresh();
    if (motor.isEnergized) {
      await tic.deenergize(motor.motorNum);
    } else {
      await applyToTic(panel);
      await tic.resumeAndEnergize(motor.motorNum, { keepAlive: true });
    }
    motor.isChangingEnergizedState = false;
    refresh();
  });

  // Declare the motor's current physical position as 0°.
  const zero = createButton("Set 0° here").parent(box);
  zero.mousePressed(() => tic.haltAndSetPosition(motor.motorNum, 0));

  function refresh() {
    stateLabel.html(motor.isEnergized ? "energized" : "deenergized");
    stateLabel.style("color", motor.isEnergized ? "#6f6" : "#f66");
    energize.html(
      motor.isChangingEnergizedState ? "Working..." : motor.isEnergized ? "Deenergize" : "Energize"
    );
    energize.elt.disabled = motor.isChangingEnergizedState;
  }

  // Live readout of where the motor is being sent
  setInterval(() => {
    angleLabel.html(`angle: ${panel.angle.toFixed(1)}°  target: ${motor.targetPosition} µsteps`);
  }, 100);

  refresh();
  panels.push(panel);
}

function slider(parent, title, min, max, value, step, onInput, format = (v) => v.toLocaleString()) {
  const row = createDiv().class("row").parent(parent);
  const label = createSpan().parent(row);
  const s = createSlider(min, max, value, step).parent(row);
  const show = () => label.html(`${title}: ${format(s.value())}`);
  s.input(() => {
    onInput(s.value());
    show();
  });
  show();
  return s;
}

// Debounced like ControlPanel.scheduleApplyToTic (250 ms)
function scheduleApply(panel) {
  clearTimeout(panel.applyTimer);
  panel.applyTimer = setTimeout(() => applyToTic(panel), 250);
}

async function applyToTic(panel) {
  const m = panel.motor;
  await tic.setStepMode(m.motorNum, panel.settings.stepModeIndex);
  return tic.setMotionLimits(m.motorNum, {
    maxSpeed: m.maxSpeed,
    maxAccel: m.accel,
    maxDecel: m.deccel,
    current: m.selectedCurrentLimitMA,
  });
}
