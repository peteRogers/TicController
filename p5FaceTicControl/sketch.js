// Face-tracking version of the p5TicControl sketch.
// ml5 faceMesh finds a face in the webcam and its horizontal position is
// handed to the TicController, which turns each energized Tic to match.
// All the motor settings and buttons live in ticController.js.
//
// The Tic counts position from wherever the motor was at power-up, so line the
// shaft up with your 0° mark and press "Set 0° here" before tracking.

const VIDEO_W = 640;
const VIDEO_H = 480;

let tic;
let video;
let faceMesh;
let faces = [];
let modelReady = false;
let faceX = 0.5; // smoothed face centre, 0 (left of screen) – 1 (right)

function setup() {
  createCanvas(VIDEO_W, VIDEO_H);
  textFont("monospace");

  video = createCapture(VIDEO, { flipped: true });
  video.size(VIDEO_W, VIDEO_H);
  video.hide();

  // With p5 2.x, ml5.faceMesh() returns a Promise of the model rather than the
  // model itself, so start detecting once it resolves.
  // No `flipped` option here: ml5 already mirrors its results to match the
  // flipped capture, and asking it to flip again puts the box on the wrong side.
  ml5.faceMesh({ maxFaces: 1, refineLandmarks: false }).then((model) => {
    faceMesh = model;
    modelReady = true;
    faceMesh.detectStart(video, (results) => (faces = results));
  });

  tic = new TicController({ product: "T500", mode: "position" });
  tic.createControls();
}

function draw() {
  image(video, 0, 0, VIDEO_W, VIDEO_H);

  if (faces.length > 0) {
    const box = faces[0].box;
    const centre = (box.xMin + box.width / 2) / VIDEO_W;
    faceX = lerp(faceX, constrain(centre, 0, 1), 0.3);

    noFill();
    stroke(80, 255, 120);
    strokeWeight(2);
    rect(box.xMin, box.yMin, box.width, box.height);
  }

  stroke(80, 160, 255);
  line(faceX * VIDEO_W, 0, faceX * VIDEO_W, VIDEO_H);
  tic.follow(faces.length > 0 ? faceX : null);

 
}
