// Example p5 sketch using ticController.js
// Mirrors Grace's ContentView + ControlPanel: one panel per Tic, and each
// motor runs while an "activity" value is above its threshold.
// Here activity = mouse speed, standing in for the optical-flow magnitude.
// All the motor settings and buttons live in ticController.js.

let tic;
let activity = 0;

function setup() {
  createCanvas(windowWidth, 60);
  textFont("monospace");

  tic = new TicController({ product: "T500", mode: "velocity" });
  tic.createControls();
}

function draw() {
  background(24);

  // Stand-in for the optical flow value (0–100)
  const mouseSpeed = dist(mouseX, mouseY, pmouseX, pmouseY);
  activity = lerp(activity, constrain(mouseSpeed * 2, 0, 100), 0.1);

  fill(240);
  noStroke();
  textSize(14);
  text(`activity: ${activity.toFixed(1)}`, 16, 24);
  fill(80, 160, 255);
  rect(16, 36, map(activity, 0, 100, 0, width - 32), 12);

  tic.drive(activity);
}

function windowResized() {
  resizeCanvas(windowWidth, 60);
}
