//
//  FacesSimilarity_Model.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import Foundation
import Observation
import AVFoundation
import Vision
import CoreImage
import SwiftUI


// MARK: - Model (thin): wires CameraSessionManager + FaceSimilarityAnalyser

@MainActor
@Observable
final class FaceSimilarityModel{

    typealias TrackedFace = FaceSimilarityAnalyser.TrackedFace

    // Observed (for SwiftUI)
    var trackedFaces: [TrackedFace] = []
    var isRunning: Bool = false
    var statusText: String = "Starting…"

    // Reusable camera setup (shared across analysers)
    @ObservationIgnored
    let camera = CameraSessionManager()

    // Pluggable analyser (this file)
    @ObservationIgnored
    let analyser = FaceSimilarityAnalyser()

    init() {
        // Keep BGRA for easy preview + CI crop -> CGImage
        camera.pixelFormat = kCVPixelFormatType_32BGRA
        camera.minFrameInterval = 0.0

        analyser.detectionInterval = 0.08
        analyser.onOutput = { [weak self] faces in
            self?.trackedFaces = faces
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
