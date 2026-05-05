//
//  OpticalFlowAnalyser.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import Foundation
import Vision
import Observation
import QuartzCore
import AVFoundation
import SwiftUI

/// Plug into: `CameraSessionManager.analysers = [analyser]`
///
/// IMPORTANT:
/// Your old code used `TrackOpticalFlowRequest().perform(on: sampleBuffer)`.
/// In the new pattern the analyser receives a CVPixelBuffer.
/// So this analyser assumes you have (or can add) a pixelBuffer-based API:
///     `TrackOpticalFlowRequest.perform(on pixelBuffer: CVPixelBuffer) async throws -> OpticalFlowObservation?`
///
/// If your TrackOpticalFlowRequest currently ONLY accepts CMSampleBuffer,
/// tell me and I’ll give you a tiny adapter approach that still keeps the “camera setup reusable” goal.
final class OpticalFlowAnalyser: VideoFrameAnalyser {

    struct Output: Equatable {
        var averageAngle: Double
        var motionIntensity: Float
    }

    /// Called on MAIN with smoothed results.
    var onOutput: (@MainActor (Output) -> Void)?

    // Same knobs as your original MotionManager
    var angleSmoothing: Double = 0.15
    var intensityDecay: Float = 0.80
    var sensitivityMultiplier: Float = 12.0

    /// Grid sampling step (your original used stride by 12)
    var sampleStride: Int = 12

    /// Prevent overlapping async processing (like your `isProcessing`)
    private var isProcessing = false

    // Circular smoothing state
    private var smoothedSin: Double = 0.0
    private var smoothedCos: Double = 1.0 // Start facing "Right" (0°)

    // Smoothed intensity state
    private var smoothedIntensity: Float = 0.0

    // Your existing request type
    private let opticalFlowRequest = TrackOpticalFlowRequest()

    func analyse(pixelBuffer: CVPixelBuffer, timestamp: CFTimeInterval) {
        guard !isProcessing else { return }
        isProcessing = true

        Task {
            defer { self.isProcessing = false }

            do {
                // Assumes you have this pixelBuffer API.
                if let observation = try await opticalFlowRequest.perform(on: pixelBuffer) {
                    processWholeFrame(observation)
                }
            } catch {
                // ignore transient errors
            }
        }
    }

    private func processWholeFrame(_ observation: OpticalFlowObservation) {
        observation.withUnsafePointer { pointer in
            let rawData = pointer.assumingMemoryBound(to: Float32.self)
            let width = Int(observation.size.width)
            let height = Int(observation.size.height)

            var frameDx: Double = 0
            var frameDy: Double = 0
            var frameMagnitude: Float = 0
            var samples: Double = 0

            //let stride = max(sampleStride, 1)

            let step = max(sampleStride, 1)
            for y in Swift.stride(from: 0, to: height, by: step) {
                for x in Swift.stride(from: 0, to: width, by: step) {
                    let index = (y * width + x) * 2
                    let dx = Double(rawData[index])
                    let dy = Double(rawData[index + 1])

                    frameMagnitude += Float((dx * dx + dy * dy).squareRoot())

                    // FRONT CAMERA PORTRAIT FIX (same as your code):
                    // 1) swap dx/dy
                    // 2) negate both to un-mirror + flip axes
                    frameDx += -dy
                    frameDy += -dx

                    samples += 1
                }
            }

            guard samples > 0 else { return }

            let currentFrameAngleRad = atan2(frameDy, frameDx)
            let rawIntensity = (frameMagnitude / Float(samples)) * sensitivityMultiplier

            // Smooth on MAIN (so model updates are clean for SwiftUI)
            Task { @MainActor in
                // Intensity smoothing (same formula)
                self.smoothedIntensity = (self.smoothedIntensity * self.intensityDecay)
                    + (rawIntensity * (1.0 - self.intensityDecay))

                // Circular smoothing
                self.smoothedSin = (self.smoothedSin * (1.0 - self.angleSmoothing))
                    + (sin(currentFrameAngleRad) * self.angleSmoothing)

                self.smoothedCos = (self.smoothedCos * (1.0 - self.angleSmoothing))
                    + (cos(currentFrameAngleRad) * self.angleSmoothing)

                let avgAngleDeg = atan2(self.smoothedSin, self.smoothedCos) * (180.0 / .pi)

                self.onOutput?(
                    Output(
                        averageAngle: avgAngleDeg,
                        motionIntensity: self.smoothedIntensity
                    )
                )
            }
        }
    }
}






