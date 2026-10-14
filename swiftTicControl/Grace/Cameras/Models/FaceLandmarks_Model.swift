//
//  FaceLandmark_Model.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import SwiftUI
import Observation
import AVFoundation
import Vision
import QuartzCore

@MainActor
@Observable
final class FaceLandmarkModel {

    // Observed outputs for the UI
    var faceBoundingBox: CGRect? = nil
    var landmarkPoints: [CGPoint] = []
    var isRunning: Bool = false
    var statusText: String = "Starting…"

    // Reusable camera manager (setup lives here now)
    @ObservationIgnored
    let camera = CameraSessionManager()

    // This analyser can be swapped for another one later
    @ObservationIgnored
    private let faceAnalyser = FaceLandmarksAnalyser()

    init() {
        // Camera-level throttling (optional). If you want max camera rate, set 0.
        camera.minFrameInterval = 0.0

        // Analyser throttling (your old minInterval idea)
        faceAnalyser.minInterval = 0.01

        faceAnalyser.onOutput = { [weak self] out in
            guard let self else { return }
            self.faceBoundingBox = out.faceBoundingBox
            self.landmarkPoints = out.landmarkPoints
        }

        camera.analysers = [faceAnalyser]
    }

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

    // MARK: - Derived UI-friendly values

    var faceYTopDown: CGFloat? {
        guard let bb = faceBoundingBox else { return nil }
        return 1.0 - bb.midY
    }

    var faceOpacity: Double {
        guard let y = faceYTopDown else { return 0.15 }
        let clamped = min(max(y, 0), 1)
        return Double(clamped)
    }

    // For your preview
    var session: AVCaptureSession { camera.session }
}
