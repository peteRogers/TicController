//
//  FaceLandmarks.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import AVFoundation
import Vision
import QuartzCore   // CACurrentMediaTime


final class FaceLandmarksAnalyser: VideoFrameAnalyser {

    struct Output {
        var faceBoundingBox: CGRect? = nil
        var landmarkPoints: [CGPoint] = []
    }

    /// Called on MAIN when results are ready.
    var onOutput: (@MainActor (Output) -> Void)?

    var minInterval: CFTimeInterval = 0.08 // analyser throttling (separate from camera)
    private var lastProcessTime: CFTimeInterval = 0

    private let sequenceHandler = VNSequenceRequestHandler()

    func analyse(pixelBuffer: CVPixelBuffer, timestamp: CFTimeInterval) {
        if timestamp - lastProcessTime < minInterval { return }
        lastProcessTime = timestamp

        let request = VNDetectFaceLandmarksRequest { [weak self] request, _ in
            guard let self else { return }

            guard let faces = request.results as? [VNFaceObservation], !faces.isEmpty else {
                Task { @MainActor in self.onOutput?(Output(faceBoundingBox: nil, landmarkPoints: [])) }
                return
            }

            let best = faces.max(by: {
                ($0.boundingBox.width * $0.boundingBox.height) <
                ($1.boundingBox.width * $1.boundingBox.height)
            })

            guard let best else {
                Task { @MainActor in self.onOutput?(Output(faceBoundingBox: nil, landmarkPoints: [])) }
                return
            }

            let bb = best.boundingBox

            var points: [CGPoint] = []
            if let lm = best.landmarks {
                func append(_ region: VNFaceLandmarkRegion2D?) {
                    guard let region else { return }
                    for p in region.normalizedPoints {
                        let gx = bb.minX + CGFloat(p.x) * bb.width
                        let gy = bb.minY + CGFloat(p.y) * bb.height
                        points.append(CGPoint(x: gx, y: gy))
                    }
                }

                append(lm.leftEye)
                append(lm.rightEye)
                append(lm.leftEyebrow)
                append(lm.rightEyebrow)
                append(lm.nose)
                append(lm.noseCrest)
                append(lm.outerLips)
                append(lm.innerLips)
                append(lm.faceContour)
            }

            Task { @MainActor in
                self.onOutput?(Output(faceBoundingBox: bb, landmarkPoints: points))
            }
        }

        do {
            try sequenceHandler.perform([request], on: pixelBuffer, orientation: .up)
        } catch {
            // ignore transient Vision errors
        }
    }
}

// MARK: - Model that composes camera + analyser



