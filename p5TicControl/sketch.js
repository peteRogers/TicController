// Example p5 sketch using ticController.js
// Mirrors Grace's ContentView + ControlPanel: one panel per Tic, and each
// motor runs while an "activity" value is above its threshold.
// Here activity = mouse speed, standing in for the optical-flow magnitude.

let tic;
let panels = [];
let activity = 0;
let addButton;

function setup() {
  createCanvas(windowWidth, 220);
  textFont("monospace");

  tic = new TicController({ product: "T500" });

  addButton = createButton("Add Tic…");
  addButton.position(16, 16);
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

  // Stand-in for the optical flow value (0–100)
  const mouseSpeed = dist(mouseX, mouseY, pmouseX, pmouseY);
  activity = lerp(activity, constrain(mouseSpeed * 2, 0, 100), 0.1);

  for (const panel of panels) updateMotor(panel);

  fill(240);
  noStroke();
  textSize(14);
  text(tic.ticListMessage, 16, 70);
  text(`activity: ${activity.toFixed(1)}`, 16, 95);
  text(`message:  ${tic.lastMessage}`, 16, 120);
  fill(255, 120, 120);
  text(tic.lastError, 16, 145, width - 32, 70);

  fill(80, 160, 255);
  rect(16, 190, map(activity, 0, 100, 0, width - 32), 12);
}

// Like ContentView's onChange: only send a command when the state changes,
// not every frame.
function updateMotor(panel) {
  const motor = panel.motor;
  if (!motor.isEnergized) return;

  const shouldRun = activity > motor.threshold;
  const direction = motor.shouldMoveForward ? 1 : -1;
  const state = shouldRun ? direction : 0;
  if (state === panel.lastState) return;
  panel.lastState = state;

  if (state === 0) tic.stop(motor.motorNum);
  else if (state > 0) tic.moveForward(motor.motorNum, motor.maxSpeed);
  else tic.moveBackward(motor.motorNum, motor.maxSpeed);
}

// MARK: - Control panel (port of TicControlPanelView.swift)

function buildPanel(motor) {
  if (panels.some((p) => p.motor === motor)) return;

  const box = createDiv().class("panel");
  createElement("h3", motor.name).parent(box);
  const stateLabel = createDiv().class("caption").parent(box);

  const direction = createCheckbox(" forward motion", motor.shouldMoveForward).parent(box);
  direction.changed(() => (motor.shouldMoveForward = direction.checked()));

  const panel = { motor, box, lastState: 0, applyTimer: null };

  slider(box, "acceleration", 50_000, 32_000_000, motor.accel, 50_000, (v) => {
    motor.accel = v;
    scheduleApply(panel);
  });
  slider(box, "deceleration", 50_000, 32_000_000, motor.deccel, 50_000, (v) => {
    motor.deccel = v;
    scheduleApply(panel);
  });
  slider(box, "max speed", 0, 300_000_000, motor.maxSpeed, 3_000_000, (v) => {
    motor.maxSpeed = v;
    panel.lastState = null; // resend velocity at the new speed
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
      await tic.resumeAndEnergize(motor.motorNum);
      await applyToTic(panel);
    }
    panel.lastState = 0;
    motor.isChangingEnergizedState = false;
    refresh();
  });

  slider(box, "movement threshold", 0, 100, motor.threshold, 0.2, (v) => {
    motor.threshold = v;
  });

  function refresh() {
    stateLabel.html(motor.isEnergized ? "energized" : "deenergized");
    stateLabel.style("color", motor.isEnergized ? "#6f6" : "#f66");
    energize.html(
      motor.isChangingEnergizedState ? "Working..." : motor.isEnergized ? "Deenergize" : "Energize"
    );
    energize.elt.disabled = motor.isChangingEnergizedState;
  }

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

function applyToTic(panel) {
  const m = panel.motor;
  return tic.setMotionLimits(m.motorNum, {
    maxSpeed: m.maxSpeed,
    maxAccel: m.accel,
    maxDecel: m.deccel,
    current: m.selectedCurrentLimitMA,
  });
}

function windowResized() {
  resizeCanvas(windowWidth, 220);
}
