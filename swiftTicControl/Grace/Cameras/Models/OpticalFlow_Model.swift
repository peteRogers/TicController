//
//  OpticalFlow_Mode.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//
import SwiftUI
import Observation
import AVFoundation

@MainActor
@Observable
final class OpticalFlowModel {

    // Observable UI properties (same as your MotionManager)
    var averageAngle: Double = 0.0
    var motionIntensity: Float = 0.0

    var isRunning: Bool = false
    var statusText: String = "Starting…"

    // Reusable camera setup object
    @ObservationIgnored
    let camera = CameraSessionManager()

    // Pluggable analyser
    @ObservationIgnored
    let analyser = OpticalFlowAnalyser()

    init() {
        // Match your previous capture settings as closely as possible
        camera.sessionPreset = .vga640x480
        camera.pixelFormat = kCVPixelFormatType_32BGRA
        camera.minFrameInterval = 0.0

        // Match old MotionManager tuning
        analyser.angleSmoothing = 0.15
        analyser.intensityDecay = 0.80
        analyser.sensitivityMultiplier = 12.0
        analyser.sampleStride = 12

        analyser.onOutput = { [weak self] out in
            guard let self else { return }
            self.averageAngle = out.averageAngle
            self.motionIntensity = out.motionIntensity
        }

        camera.analysers = [analyser]
    }

    var session: AVCaptureSession { camera.session }

    func start() {
        Task {
            do {
                try await camera.start()
                isRunning = true
                statusText = "Running"
            } catch {
                isRunning = false
                statusText = "Failed: \(error.localizedDescription)"
            }
        }
    }

    func stop() {
        camera.stop()
        isRunning = false
        statusText = "Stopped"
    }
}
