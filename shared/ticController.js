//
//  ticController.js
//  p5 / browser port of Grace/TicMotorControl/TicController.swift
//  Shared by p5TicControl and p5FaceTicControl; load it from each page with
//  <script src="../shared/ticController.js">.
//
//  Comes with a ready-made UI, in one of two modes:
//
//    velocity: each motor runs while an activity value is above its threshold
//      tic = new TicController({ mode: "velocity" });
//      tic.createControls();   // in setup(): Add Tic button, status, panels
//      tic.drive(activity);    // in draw(): activity = 0–100
//
//    position: each motor turns to an angle
//      tic = new TicController({ mode: "position" });
//      tic.createControls();
//      tic.follow(x);          // in draw(): x = 0–1 across the range, or null
//
//    While no Tic is connected, a preview panel shows the controls for a
//    simulated motor (nothing is sent over USB). Its settings carry over to
//    the first real Tic. Turn it off with tic.createControls({ preview: false }).
//
//  The Swift version shells out to `ticcmd`. Browsers can't run processes, so
//  this talks to each Tic directly over its native USB interface using WebUSB,
//  sending the same vendor control transfers that ticcmd sends via libusb.
//  (The Tic has no USB virtual serial port, so Web Serial can't see it.)
//
//  Requirements:
//    - Chrome / Edge (WebUSB), page served over https or http://localhost
//      (the p5 web editor works).
//    - Tic control mode set to "Serial / I2C / USB" (same as needed for ticcmd).
//    - Close the Tic Control Center app first; only one program can hold the
//      USB connection at a time.
//
//  Units are identical to ticcmd:
//    velocity / max speed: microsteps per 10,000 s
//    accel / decel:        microsteps per 100 s^2
//    position:             microsteps
//    current:              mA (converted to the Tic's current-limit code)
//

const TIC_USB_VENDOR_ID = 0x1ffb; // Pololu

// USB product ID -> product name used for current-limit conversion
const TIC_USB_PRODUCTS = {
  0x00b3: "T825",
  0x00b5: "T834",
  0x00bd: "T500",
  0x00c9: "T249",
};

const TIC_USB_FILTERS = Object.keys(TIC_USB_PRODUCTS).map((id) => ({
  vendorId: TIC_USB_VENDOR_ID,
  productId: Number(id),
}));

// Command bytes, used as the USB bRequest (Tic user's guide, "Command reference")
const TIC_CMD = {
  setTargetPosition: 0xe0,
  setTargetVelocity: 0xe3,
  haltAndHold: 0x89,
  resetCommandTimeout: 0x8c,
  deenergize: 0x86,
  energize: 0x85,
  exitSafeStart: 0x83,
  enterSafeStart: 0x8f,
  clearDriverError: 0x8a,
  setMaxSpeed: 0xe6,
  setMaxAccel: 0xea,
  setMaxDecel: 0xe9,
  setCurrentLimit: 0x91,
  haltAndSetPosition: 0xec,
  setStepMode: 0x94,
};

// Step mode code (index) -> microsteps per full step. The T500 only goes to
// 1/8; the others go to at least 1/32.
const TIC_STEP_MODES = [1, 2, 4, 8, 16, 32];

// Position updates are sent at most this often per motor, so the USB queue
// never backs up.
const TIC_SEND_INTERVAL_MS = 50;

// Current limit code -> mA for the Tic T500 (non-linear table).
const TIC_T500_CURRENT_TABLE_MA = [
  0, 1, 174, 343, 495, 634, 762, 880, 990, 1092, 1189, 1281, 1368, 1452, 1532,
  1611, 1687, 1762, 1835, 1909, 1982, 2056, 2131, 2207, 2285, 2366, 2451, 2540,
  2634, 2734, 2843, 2962, 3093,
];

// Linear products: mA per current-limit code unit.
const TIC_CURRENT_UNITS_MA = {
  T825: 32,
  T834: 32,
  T249: 40,
};

class TicController {
  constructor({ product = "T500", mode = "velocity", keepAliveMs = 500 } = {}) {
    this.product = product;
    this.mode = mode;
    this.keepAliveMs = keepAliveMs;

    this.motors = [];
    this.ticListMessage = "No Tic scan yet";
    this.isMoving = false;
    this.lastMessage = "Ready";
    this.lastError = "";
    this.lastCommand = "";

    this.supportedCurrentLimitsMA = [174, 343, 495, 634, 762, 880, 990];
    this.selectedCurrentLimitIndex = 3;

    if ("usb" in navigator) {
      navigator.usb.addEventListener("disconnect", (e) =>
        this._handleDisconnect(e.device)
      );
    }
  }

  get selectedCurrentLimitMA() {
    const i = clampIndex(this.selectedCurrentLimitIndex, this.supportedCurrentLimitsMA);
    return this.supportedCurrentLimitsMA[i];
  }

  static isSupported() {
    return "usb" in navigator;
  }

  // MARK: - Finding Tics (replaces `ticcmd --list`)

  // Reconnects to every Tic this page has already been given permission
  // for. Doesn't need a user gesture, so it's safe to call from setup().
  async scanForTics() {
    if (!TicController.isSupported()) {
      this.ticListMessage = "WebUSB not supported (use Chrome or Edge)";
      return this.motors;
    }

    this.ticListMessage = "Scanning for Tic controllers...";
    try {
      const devices = (await navigator.usb.getDevices()).filter(
        (d) => d.vendorId === TIC_USB_VENDOR_ID && d.productId in TIC_USB_PRODUCTS
      );
      for (const device of devices) await this._openDevice(device);
      this._updateListMessage();
    } catch (err) {
      this.ticListMessage = `Tic scan failed: ${err.message}`;
    }
    return this.motors;
  }

  // Shows the browser's device picker. MUST be called from a user gesture
  // (e.g. a button's mousePressed callback).
  async addTic() {
    if (!TicController.isSupported()) {
      this.ticListMessage = "WebUSB not supported (use Chrome or Edge)";
      return null;
    }

    try {
      const device = await navigator.usb.requestDevice({ filters: TIC_USB_FILTERS });
      const motor = await this._openDevice(device);
      this._updateListMessage();
      return motor;
    } catch (err) {
      // NotFoundError = user cancelled the picker
      if (err.name !== "NotFoundError") {
        this.lastError = `Could not open Tic: ${err.message}`;
      }
      return null;
    }
  }

  // MARK: - Public controls

  setMotionLimits(motorNum, { maxSpeed, maxAccel, maxDecel, current }) {
    return this._runTicCommands(motorNum, [
      encode32(TIC_CMD.setMaxSpeed, maxSpeed),
      encode32(TIC_CMD.setMaxAccel, maxAccel),
      encode32(TIC_CMD.setMaxDecel, maxDecel),
      this._encodeCurrent(current, motorNum),
    ]);
  }

  moveForward(motorNum, speed) {
    return this.startMoving(Math.abs(speed), motorNum);
  }

  moveBackward(motorNum, speed) {
    return this.startMoving(-Math.abs(speed), motorNum);
  }

  async stop(motorNum) {
    this._stopKeepAlive(motorNum);
    this.isMoving = false;
    this.lastMessage = "Stopping...";
    if (await this._runTicCommands(motorNum, [encode32(TIC_CMD.setTargetVelocity, 0)])) {
      this.lastMessage = "Stopped";
    }
  }

  async deenergize(motorNum) {
    const motor = this._motor(motorNum, "Could not deenergize");
    if (!motor) return false;

    this._stopKeepAlive(motorNum);
    this.isMoving = false;
    this.lastError = "";
    this.lastMessage = `De-energizing motor ${motorNum}...`;

    const ok = await this._runTicCommands(motorNum, [
      encode32(TIC_CMD.setTargetVelocity, 0),
      quick(TIC_CMD.deenergize),
    ]);
    if (!ok) {
      this.lastMessage = `Failed to deenergize motor ${motorNum}`;
      return false;
    }

    motor.isEnergized = false;
    this.lastMessage = `Motor ${motorNum} deenergized`;
    return true;
  }

  // Equivalent of `ticcmd --energize`, `--exit-safe-start`, `--resume`.
  // Pass { keepAlive: true } for position control, where the Tic should keep
  // holding its target even when no new position has been sent for a while.
  async resumeAndEnergize(motorNum, { keepAlive = false } = {}) {
    const motor = this._motor(motorNum, "Could not energize");
    if (!motor) return false;

    this.lastError = "";
    this.lastMessage = `Energizing motor ${motorNum}...`;

    const ok = await this._runTicCommands(motorNum, [
      quick(TIC_CMD.energize),
      quick(TIC_CMD.exitSafeStart),
    ]);
    if (!ok) {
      this.lastMessage = `Failed to energize motor ${motorNum}`;
      return false;
    }

    motor.isEnergized = true;
    if (keepAlive) this._startKeepAlive(motorNum);
    this.lastMessage = `Motor ${motorNum} resumed and energized`;
    return true;
  }

  async setSelectedCurrentLimit(motorNum) {
    const currentMA = this.selectedCurrentLimitMA;
    this.lastMessage = `Setting current limit to ${currentMA} mA...`;
    if (await this._runTicCommands(motorNum, [this._encodeCurrent(currentMA, motorNum)])) {
      this.lastMessage = `Current limit set to ${currentMA} mA`;
    }
  }

  // MARK: - Position control

  // Equivalent of `ticcmd --position`. The Tic moves there itself using the
  // max speed / accel / decel limits. Position is in microsteps.
  async setTargetPosition(motorNum, position) {
    const motor = this._motor(motorNum, "Could not move");
    if (!motor) return false;

    const target = Math.round(position);
    const ok = await this._runTicCommands(
      motorNum,
      [encode32(TIC_CMD.setTargetPosition, target)],
      { showAsLastMessage: false }
    );
    if (ok) {
      motor.targetPosition = target;
      this.lastMessage = `Target position ${target}`;
    }
    return ok;
  }

  // Equivalent of `ticcmd --halt-and-set-position`: stops the motor and
  // tells the Tic that wherever it is now counts as `position`. The Tic
  // starts at 0 on power-up, so use this to define your 0° point.
  async haltAndSetPosition(motorNum, position = 0) {
    const motor = this._motor(motorNum, "Could not set position of");
    if (!motor) return false;

    const ok = await this._runTicCommands(motorNum, [
      encode32(TIC_CMD.haltAndSetPosition, position),
    ]);
    if (ok) {
      motor.targetPosition = Math.round(position);
      this.lastMessage = `Motor ${motorNum} position set to ${Math.round(position)}`;
    }
    return ok;
  }

  // Equivalent of `ticcmd --step-mode`. `modeIndex` indexes TIC_STEP_MODES
  // (0 = full step, 1 = 1/2, 2 = 1/4, ...).
  setStepMode(motorNum, modeIndex) {
    return this._runTicCommands(motorNum, [
      { request: TIC_CMD.setStepMode, value: modeIndex, index: 0 },
    ]);
  }

  // MARK: - Driving from draw()

  // Velocity mode. Call every frame from draw(). Each energized motor runs at
  // its max speed while `activity` (0–100) is above its threshold, and stops
  // otherwise.
  drive(activity) {
    for (const motor of this.motors) this._driveMotor(motor, activity);
  }

  // Only sends a command when the state changes, not every frame.
  _driveMotor(motor, activity) {
    if (!motor.panel || !motor.isEnergized || motor.isChangingEnergizedState) return;

    const direction = motor.shouldMoveForward ? 1 : -1;
    const state = activity > motor.threshold ? direction : 0;
    if (state === motor.lastState) return;
    motor.lastState = state;

    if (state === 0) this.stop(motor.motorNum);
    else if (state > 0) this.moveForward(motor.motorNum, motor.maxSpeed);
    else this.moveBackward(motor.motorNum, motor.maxSpeed);
  }

  // Position mode. Call every frame from draw(). `x` runs 0–1 across each
  // motor's min–max angle; pass null when there's nothing to follow and the
  // motor either holds still or returns to its home angle.
  follow(x) {
    for (const motor of this.motors) this._followTarget(motor, x);
  }

  // Only sends when the target actually changes, and rate-limited.
  _followTarget(motor, x) {
    if (!motor.panel || !motor.isEnergized || motor.isChangingEnergizedState) return;
    const hasTarget = x !== null && x !== undefined;
    if (!hasTarget && !motor.returnHome) return; // hold last position

    if (hasTarget) {
      const t = Math.min(Math.max(motor.invert ? 1 - x : x, 0), 1);
      motor.angle = motor.minAngle + (motor.maxAngle - motor.minAngle) * t;
    } else {
      motor.angle = motor.homeAngle;
    }

    const target = Math.round((motor.angle / 360) * motor.microstepsPerRev);
    if (Math.abs(target - motor.targetPosition) < motor.deadband) return;
    if (motor.isSending || performance.now() - motor.lastSend < TIC_SEND_INTERVAL_MS) return;

    motor.isSending = true;
    motor.lastSend = performance.now();
    this.setTargetPosition(motor.motorNum, target).finally(() => (motor.isSending = false));
  }

  // MARK: - Control panels (uses p5's DOM functions, so call from setup())

  // Adds the Add Tic button, a status line and one panel per Tic, reconnects
  // any Tics this page was already allowed to use, and de-energizes them all
  // when the page closes.
  createControls({ preview = true } = {}) {
    addTicStyles();
    this.showPreview = preview;

    const bar = createDiv().class("tic-bar");
    const add = createButton("Add Tic…").parent(bar);
    add.mousePressed(async () => {
      const motor = await this.addTic(); // needs a user gesture
      if (motor) this._connectPanel(motor);
    });
    const status = createSpan().class("tic-caption").parent(bar);
    const error = createDiv().class("tic-error");

    this.scanForTics().then((motors) => {
      motors.forEach((m) => this._connectPanel(m));
      this._updatePreview();
    });
    window.addEventListener("beforeunload", () => this.disconnectAll());

    setInterval(() => {
      status.html(` ${this.ticListMessage} · ${this.lastMessage}`);
      error.html(this.lastError);
      for (const motor of this.motors) motor.panel?.refresh();
    }, 100);
  }

  // MARK: - Preview motor

  // Shows the preview panel when no real Tic is connected, and removes it
  // once one is.
  _updatePreview() {
    const preview = this.motors.find((m) => m.isPreview);
    const hasRealTic = this.motors.some((m) => !m.isPreview);

    if (preview && hasRealTic) {
      this._stopKeepAlive(preview.motorNum);
      preview.panel.remove();
      this._removeMotor(preview);
    } else if (!preview && !hasRealTic && this.showPreview) {
      const motor = new MotorControlSettings({
        name: "Preview (no Tic connected)",
        motorNum: this.motors.length,
      });
      motor.isPreview = true;
      motor.product = this.product;
      motor.queue = Promise.resolve();
      this._applyModeDefaults(motor);
      this.motors.push(motor);
      this._buildPanel(motor);
    }
  }

  // Builds the panel for a newly connected Tic, starting from the preview's
  // settings if there was one.
  _connectPanel(motor) {
    const preview = this.motors.find((m) => m.isPreview);
    if (motor.panel) return;
    if (preview) {
      for (const key of MOTOR_SETTING_KEYS) motor[key] = preview[key];
    } else {
      this._applyModeDefaults(motor);
    }
    this._buildPanel(motor);
    this._updatePreview();
  }

  _applyModeDefaults(motor) {
    if (this.mode === "position") {
      // Position mode wants faster limits than the velocity defaults: about
      // 1 s for a 180° sweep with the default 5.1:1 gearbox at 1/8 step.
      motor.maxSpeed = 40_000_000;
      motor.accel = 2_000_000;
      motor.deccel = 2_000_000;
    }
  }

  _removeMotor(motor) {
    this.motors = this.motors.filter((m) => m !== motor);
    this.motors.forEach((m, i) => (m.motorNum = i));
  }

  _buildPanel(motor) {
    if (motor.panel) return;
    const isPosition = this.mode === "position";

    // Debounced like ControlPanel.scheduleApplyToTic (250 ms)
    let applyTimer = null;
    const scheduleApply = () => {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => this._applySettings(motor), 250);
    };
    const degrees = (v) => `${v}°`;

    const box = createDiv().class("tic-panel");
    createElement("h3", motor.name).parent(box);
    const stateLabel = createDiv().class("tic-caption").parent(box);
    const angleLabel = isPosition ? createDiv().class("tic-caption").parent(box) : null;

    if (isPosition) {
      ticCheckbox(box, "invert direction", motor.invert, (v) => (motor.invert = v));
      ticCheckbox(box, "go to home angle when nothing to follow", motor.returnHome, (v) => (motor.returnHome = v));

      ticSlider(box, "min angle", 0, 360, motor.minAngle, 1, (v) => (motor.minAngle = v), degrees);
      ticSlider(box, "max angle", 0, 360, motor.maxAngle, 1, (v) => (motor.maxAngle = v), degrees);
      ticSlider(box, "home angle", 0, 360, motor.homeAngle, 1, (v) => (motor.homeAngle = v), degrees);

      ticSlider(box, "motor steps / rev", 24, 400, motor.stepsPerRev, 1, (v) => (motor.stepsPerRev = v));
      ticSlider(box, "step mode", 0, TIC_STEP_MODES.length - 1, motor.stepModeIndex, 1, (v) => {
        motor.stepModeIndex = v;
        scheduleApply();
      }, (v) => (v === 0 ? "full step" : `1/${TIC_STEP_MODES[v]} step`));
      ticSlider(box, "gear ratio", 1, 20, motor.gearRatio, 0.1, (v) => (motor.gearRatio = v), (v) => `${v}:1`);
    } else {
      ticCheckbox(box, "forward motion", motor.shouldMoveForward, (v) => (motor.shouldMoveForward = v));
    }

    ticSlider(box, "acceleration", 50_000, 32_000_000, motor.accel, 50_000, (v) => {
      motor.accel = v;
      scheduleApply();
    });
    ticSlider(box, "deceleration", 50_000, 32_000_000, motor.deccel, 50_000, (v) => {
      motor.deccel = v;
      scheduleApply();
    });
    const speedMax = isPosition ? 100_000_000 : 90_000_000;
    const speedStep = isPosition ? 200_000 : 2_000_000;
    ticSlider(box, "max speed", 0, speedMax, motor.maxSpeed, speedStep, (v) => {
      motor.maxSpeed = v;
      motor.lastState = null; // velocity mode: resend at the new speed
      scheduleApply();
    });
    const maxIndex = motor.supportedCurrentLimitsMA.length - 1;
    ticSlider(box, "current limit", 0, maxIndex, motor.currentIndex, 1, (v) => {
      motor.currentIndex = v;
      scheduleApply();
    }, () => `${motor.selectedCurrentLimitMA} mA`);

    const energize = createButton("Energize").parent(box);
    energize.mousePressed(async () => {
      motor.isChangingEnergizedState = true;
      if (motor.isEnergized) {
        await this.deenergize(motor.motorNum);
      } else {
        await this._applySettings(motor);
        // Position mode keeps the Tic holding its target between updates.
        await this.resumeAndEnergize(motor.motorNum, { keepAlive: isPosition });
      }
      motor.lastState = 0;
      motor.isChangingEnergizedState = false;
    });

    if (isPosition) {
      // Declare the motor's current physical position as 0°.
      const zero = createButton("Set 0° here").parent(box);
      zero.mousePressed(() => this.haltAndSetPosition(motor.motorNum, 0));
    } else {
      ticSlider(box, "movement threshold", 0, 100, motor.threshold, 0.2, (v) => (motor.threshold = v));
    }

    motor.panel = {
      remove: () => box.remove(),
      refresh: () => {
        stateLabel.html(motor.isEnergized ? "energized" : "deenergized");
        stateLabel.style("color", motor.isEnergized ? "#6f6" : "#f66");
        angleLabel?.html(`angle: ${motor.angle.toFixed(1)}°  target: ${motor.targetPosition} µsteps`);
        energize.html(
          motor.isChangingEnergizedState ? "Working..." : motor.isEnergized ? "Deenergize" : "Energize"
        );
        energize.elt.disabled = motor.isChangingEnergizedState;
      },
    };
    motor.panel.refresh();
  }

  async _applySettings(motor) {
    // Velocity mode leaves the step mode as configured in the Tic.
    if (this.mode === "position") await this.setStepMode(motor.motorNum, motor.stepModeIndex);
    return this.setMotionLimits(motor.motorNum, {
      maxSpeed: motor.maxSpeed,
      maxAccel: motor.accel,
      maxDecel: motor.deccel,
      current: motor.selectedCurrentLimitMA,
    });
  }

  // MARK: - Main movement

  async startMoving(velocity, motorNum) {
    this.lastError = "";
    this.lastMessage = "Starting...";
    this._stopKeepAlive(motorNum);

    // `ticcmd --resume` = energize + exit safe start
    const ok = await this._runTicCommands(motorNum, [
      quick(TIC_CMD.energize),
      quick(TIC_CMD.exitSafeStart),
      encode32(TIC_CMD.setTargetVelocity, velocity),
    ]);

    if (ok) {
      this._startKeepAlive(motorNum);
      this.isMoving = velocity !== 0;
      this.lastMessage = `Moving at velocity ${velocity}`;
    } else {
      this.isMoving = false;
      this._stopKeepAlive(motorNum);
    }
  }

  async disconnectAll() {
    for (const motor of this.motors) {
      this._stopKeepAlive(motor.motorNum);
      if (motor.isPreview) continue;
      try {
        await this._send(motor, quick(TIC_CMD.deenergize));
        await motor.device.close();
      } catch (_) {}
    }
    this.motors = [];
    this._updateListMessage();
  }

  // MARK: - Keep alive

  // The Tic's command timeout (default 1 s) stops the motor if it doesn't hear
  // from us, so keep resetting it while moving.
  _startKeepAlive(motorNum) {
    const motor = this.motors[motorNum];
    if (!motor) return;
    clearInterval(motor.keepAliveTimer);
    motor.keepAliveTimer = setInterval(() => {
      this._runTicCommands(motorNum, [quick(TIC_CMD.resetCommandTimeout)], {
        showAsLastMessage: false,
      });
    }, this.keepAliveMs);
  }

  _stopKeepAlive(motorNum) {
    const motor = this.motors[motorNum];
    if (!motor) return;
    clearInterval(motor.keepAliveTimer);
    motor.keepAliveTimer = null;
  }

  // MARK: - USB wrappers

  async _openDevice(device) {
    const existing = this.motors.find((m) => m.device === device);
    if (existing) return existing;

    try {
      if (!device.opened) await device.open();
      if (device.configuration === null) await device.selectConfiguration(1);
    } catch (err) {
      throw new Error(
        `${err.message} (is the Tic Control Center or ticcmd using it?)`
      );
    }
    // Control transfers go to the device, so claiming is only a courtesy that
    // stops other programs grabbing it; don't fail if it's unavailable.
    try {
      await device.claimInterface(0);
    } catch (_) {}

    const product = TIC_USB_PRODUCTS[device.productId] ?? this.product;
    const serial = device.serialNumber ? ` #${device.serialNumber}` : "";
    const motor = new MotorControlSettings({
      name: `Tic ${product}${serial}`,
      motorNum: this.motors.length,
    });
    motor.product = product;
    motor.device = device;
    motor.queue = Promise.resolve();

    this.motors.push(motor);
    return motor;
  }

  _handleDisconnect(device) {
    const motor = this.motors.find((m) => m.device === device);
    if (!motor) return;
    clearInterval(motor.keepAliveTimer);
    motor.panel?.remove();
    this._removeMotor(motor);
    this.lastError = `${motor.name} disconnected`;
    this._updateListMessage();
    if (this.showPreview) this._updatePreview();
  }

  _updateListMessage() {
    const count = this.motors.filter((m) => !m.isPreview).length;
    this.ticListMessage =
      count === 0 ? "No Tic controllers found" : `Found ${count} Tic controller(s)`;
  }

  _motor(motorNum, action) {
    const motor = this.motors[motorNum];
    if (!motor) {
      this.lastError = `No Tic connected for motor index ${motorNum}. Try Add Tic first.`;
      this.lastMessage = `${action} motor ${motorNum}`;
    }
    return motor;
  }

  // Sends a list of commands to one Tic. Transfers are queued per device so
  // overlapping calls always arrive in order.
  async _runTicCommands(motorNum, commands, { showAsLastMessage = true } = {}) {
    const motor = this.motors[motorNum];
    if (!motor) {
      this.lastError = `No Tic connected for motor index ${motorNum}. Try Add Tic first.`;
      this.lastCommand = "command not sent";
      return false;
    }

    if (commands.some((c) => c === null)) {
      this.lastError = `Unknown Tic product "${motor.product}"`;
      return false;
    }
    this.lastCommand = `motor ${motorNum}: ${commands.map(formatCommand).join(", ")}`;

    try {
      for (const command of commands) await this._send(motor, command);
      if (showAsLastMessage) {
        this.lastMessage = motor.isPreview ? "Preview only, nothing sent" : "Tic command sent";
      }
      return true;
    } catch (err) {
      this.lastError = `Tic write failed.\nCommand: ${this.lastCommand}\nError: ${err.message}`;
      return false;
    }
  }

  _send(motor, { request, value, index }) {
    if (motor.isPreview) return Promise.resolve(); // no USB device to send to
    const job = motor.queue.then(async () => {
      const result = await motor.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request,
        value,
        index,
      });
      if (result.status !== "ok") throw new Error(`USB transfer ${result.status}`);
    });
    motor.queue = job.catch(() => {});
    return job;
  }

  _encodeCurrent(currentMA, motorNum) {
    const product = this.motors[motorNum]?.product ?? this.product;
    try {
      return { request: TIC_CMD.setCurrentLimit, value: currentToCode(product, currentMA), index: 0 };
    } catch (_) {
      return null;
    }
  }
}

// MARK: - Protocol helpers

// Native USB commands are vendor control transfers: bRequest is the command
// byte, and data goes in wValue / wIndex (same as libpololu-tic).

function quick(command) {
  return { request: command, value: 0, index: 0 };
}

// 32-bit data: low 16 bits in wValue, high 16 bits in wIndex.
function encode32(command, value) {
  const v = Math.round(value) >>> 0; // two's complement for negative velocity
  return { request: command, value: v & 0xffff, index: v >>> 16 };
}

function formatCommand({ request, value, index }) {
  return `${hex2(request)}(${hex4(value)} ${hex4(index)})`;
}

// Same rounding as ticcmd: the highest code whose current doesn't exceed currentMA.
function currentToCode(product, currentMA) {
  const mA = Math.max(0, Math.round(currentMA));
  if (product === "T500") {
    let code = 0;
    TIC_T500_CURRENT_TABLE_MA.forEach((tableMA, i) => {
      if (tableMA <= mA) code = i;
    });
    return code;
  }
  const units = TIC_CURRENT_UNITS_MA[product];
  if (!units) throw new Error(`Unknown Tic product "${product}"`);
  return Math.min(127, Math.floor(mA / units));
}

function hex2(n) {
  return n.toString(16).padStart(2, "0");
}

function hex4(n) {
  return (n ?? 0).toString(16).padStart(4, "0");
}

// MARK: - Panel widgets

// Default look for the controls. Added first in <head> so a page's own
// stylesheet can override any of it.
function addTicStyles() {
  if (document.getElementById("tic-styles")) return;
  const style = document.createElement("style");
  style.id = "tic-styles";
  style.textContent = `
    .tic-bar { margin: 8px 16px 0; font-family: system-ui, sans-serif; }
    .tic-error { margin: 4px 16px; color: #f88; font: 13px system-ui, sans-serif; white-space: pre-wrap; }
    .tic-panel {
      display: inline-block; vertical-align: top; width: 320px; margin: 16px;
      padding: 16px; border-radius: 18px; background: rgba(40, 90, 200, 0.6);
      color: #eee; font-family: system-ui, sans-serif;
    }
    .tic-panel h3 { margin: 0 0 4px; font-size: 15px; }
    .tic-caption { font-size: 12px; margin-bottom: 8px; }
    .tic-row { display: flex; flex-direction: column; margin: 10px 0; font-size: 13px; }
    .tic-row input { width: 100%; }
    .tic-bar button, .tic-panel button { margin-top: 8px; margin-right: 6px; }
  `;
  document.head.prepend(style);
}

function ticSlider(parent, title, min, max, value, step, onInput, format = (v) => v.toLocaleString()) {
  const row = createDiv().class("tic-row").parent(parent);
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

function ticCheckbox(parent, title, value, onChange) {
  const c = createCheckbox(` ${title}`, value).parent(parent);
  c.changed(() => onChange(c.checked()));
  return c;
}

// MARK: - Data structs

// The panel settings carried over from the preview motor to a real Tic.
const MOTOR_SETTING_KEYS = [
  "accel", "deccel", "maxSpeed", "currentIndex", "threshold", "shouldMoveForward",
  "stepsPerRev", "stepModeIndex", "gearRatio", "minAngle", "maxAngle", "homeAngle",
  "invert", "returnHome", "deadband",
];

class MotorControlSettings {
  constructor({ name, motorNum }) {
    this.name = name;
    this.motorNum = motorNum;
    this.accel = 50000;
    this.deccel = 50000;
    this.maxSpeed = 6000000;
    this.threshold = 10;
    this.currentIndex = 2;
    this.shouldMoveForward = true;
    this.isEnergized = false;
    this.isChangingEnergizedState = false;
    this.targetPosition = 0;

    // Position following (see TicController.follow)
    // Defaults match our motor: 200 steps/rev, 5.1:1 gearbox, run at 1/8 step.
    this.stepsPerRev = 200;
    this.stepModeIndex = 3; // index into TIC_STEP_MODES: 1/8 step
    this.gearRatio = 5.1;
    this.minAngle = 0;
    this.maxAngle = 180;
    this.homeAngle = 90;
    this.invert = false;
    this.returnHome = false;
    this.deadband = 1; // microsteps
    this.angle = 0;
    this.lastSend = 0;
    this.isSending = false;
    this.lastState = 0; // velocity mode: -1 back, 0 stopped, 1 forward
    this.isPreview = false; // simulated motor shown while no Tic is connected
    this.panel = null;

    this.supportedCurrentLimitsMA = [
      343, 445, 506, 634, 762, 880, 1007, 1115, 1241, 1352, 1500,
    ];

    // USB plumbing, set by TicController
    this.product = null;
    this.device = null;
    this.queue = null;
    this.keepAliveTimer = null;
  }

  get selectedCurrentLimitMA() {
    const i = clampIndex(this.currentIndex, this.supportedCurrentLimitsMA);
    return this.supportedCurrentLimitsMA[i];
  }

  get microstepsPerRev() {
    return this.stepsPerRev * TIC_STEP_MODES[this.stepModeIndex] * this.gearRatio;
  }
}

function clampIndex(value, list) {
  return Math.min(Math.max(Math.round(value), 0), list.length - 1);
}
