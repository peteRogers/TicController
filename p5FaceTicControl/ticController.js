//
//  ticController.js
//  p5 / browser port of Grace/TicMotorControl/TicController.swift
//  This copy adds position control (setTargetPosition, haltAndSetPosition,
//  setStepMode) for driving the motor to an angle.
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
  constructor({ product = "T500", keepAliveMs = 500 } = {}) {
    this.product = product;
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
    this.motors = this.motors.filter((m) => m !== motor);
    this.motors.forEach((m, i) => (m.motorNum = i));
    this.lastError = `${motor.name} disconnected`;
    this._updateListMessage();
  }

  _updateListMessage() {
    this.ticListMessage =
      this.motors.length === 0
        ? "No Tic controllers found"
        : `Found ${this.motors.length} Tic controller(s)`;
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
      if (showAsLastMessage) this.lastMessage = "Tic command sent";
      return true;
    } catch (err) {
      this.lastError = `Tic write failed.\nCommand: ${this.lastCommand}\nError: ${err.message}`;
      return false;
    }
  }

  _send(motor, { request, value, index }) {
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

// MARK: - Data structs

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
}

function clampIndex(value, list) {
  return Math.min(Math.max(Math.round(value), 0), list.length - 1);
}
