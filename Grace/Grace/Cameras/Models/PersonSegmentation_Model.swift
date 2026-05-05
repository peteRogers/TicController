//
//  PersonSegmentation_Model.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import SwiftUI
import Observation
import AVFoundation
import CoreImage
import Vision

#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
@Observable
final class PersonSegmentationModel {

    // Observed output (show this in SwiftUI)
    var compositedImage: CGImage? = nil

    var isRunning: Bool = false
    var statusText: String = "Starting…"

    @ObservationIgnored
    let camera = CameraSessionManager()

    @ObservationIgnored
    let analyser = PersonSegmentationCompositorAnalyser()

    /// Call with an asset image name, file URL, or provide your own CIImage.
    init(backgroundImageNamed name: String) {
        // Camera setup
        //camera.sessionPreset = .vga640x480
        camera.sessionPreset = .high
        camera.pixelFormat = kCVPixelFormatType_32BGRA
        camera.minFrameInterval = 0.0

        // Background image (from Assets)
        if let ci = Self.loadCIImage(named: name) {
            analyser.backgroundCIImage = ci
        }

        // Segmentation tuning
        analyser.segmentationQuality = .accurate
        analyser.minInterval = 0.01
        analyser.maskBlurRadius = 1.0

        analyser.onOutput = { [weak self] out in
            self?.compositedImage = out.compositedCGImage
        }

        camera.analysers = [analyser]
    }

    var session: AVCaptureSession { camera.session } // not used for display here, but available

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

    private static func loadCIImage(named name: String) -> CIImage? {
        #if os(macOS)
        guard let nsImage = NSImage(named: name) else { return nil }
        guard let tiffData = nsImage.tiffRepresentation else { return nil }
        guard let bitmap = NSBitmapImageRep(data: tiffData) else { return nil }
        return CIImage(bitmapImageRep: bitmap)
        #else
        guard let uiImage = UIImage(named: name) else { return nil }
        return CIImage(image: uiImage)
        #endif
    }
}
