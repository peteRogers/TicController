//
//  PersonSegmentation.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import Foundation
import Vision
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import Vision
import CoreImage
import CoreImage.CIFilterBuiltins

final class PersonSegmentationCompositorAnalyser: VideoFrameAnalyser {

    struct Output: Equatable {
        let compositedCGImage: CGImage
    }

    /// Called on MAIN with the final composited frame.
    var onOutput: (@MainActor (Output) -> Void)?

    // Tuning
    var minInterval: CFTimeInterval = 0.05          // ~20fps (segmentation is heavier)
    var segmentationQuality: VNGeneratePersonSegmentationRequest.QualityLevel = .balanced
    var maskBlurRadius: Double = 2.0                // soften edges a bit

    /// Set this from the model (CIImage is easiest for CoreImage).
    /// Should match the camera aspect roughly or we’ll scale it.
    var backgroundCIImage: CIImage? = nil

    private let sequenceHandler = VNSequenceRequestHandler()
    private let ciContext = CIContext()

    private var lastTime: CFTimeInterval = 0

    func analyse(pixelBuffer: CVPixelBuffer, timestamp: CFTimeInterval) {
        if timestamp - lastTime < minInterval { return }
        lastTime = timestamp

        guard let bg = backgroundCIImage else { return }

        // 1) Run person segmentation
        let req = VNGeneratePersonSegmentationRequest()
        req.qualityLevel = segmentationQuality
        req.outputPixelFormat = kCVPixelFormatType_OneComponent8 // 1-channel mask

        do {
            try sequenceHandler.perform([req], on: pixelBuffer, orientation: .up)
        } catch {
            return
        }

        guard let maskBuffer = (req.results?.first as? VNPixelBufferObservation)?.pixelBuffer else {
            return
        }

        // 2) Build CIImages
        let fg = CIImage(cvPixelBuffer: pixelBuffer)
        var mask = CIImage(cvPixelBuffer: maskBuffer)

        // Vision mask is typically lower-res than the camera frame. Scale mask to match fg extent.
        mask = mask.transformed(by: CGAffineTransform(
            scaleX: fg.extent.width / mask.extent.width,
            y: fg.extent.height / mask.extent.height
        ))

        // Optional: soften mask edges for nicer cutout
        if maskBlurRadius > 0 {
            mask = mask
                .clampedToExtent()
                .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: maskBlurRadius])
                .cropped(to: fg.extent)
        }

        // 3) Scale background to match foreground size
        let bgScaled = bg
            .cropped(to: bg.extent)
            .transformed(by: CGAffineTransform(
                scaleX: fg.extent.width / bg.extent.width,
                y: fg.extent.height / bg.extent.height
            ))
            .cropped(to: fg.extent)

        // 4) Composite: output = fg over bg, using mask (white=keep fg, black=show bg)
        let blend = CIFilter.blendWithMask()
        blend.inputImage = fg
        blend.backgroundImage = bgScaled
        blend.maskImage = mask

        guard let out = blend.outputImage else { return }

        // 5) Render to CGImage for SwiftUI
        guard let cg = ciContext.createCGImage(out, from: out.extent) else { return }

        Task { @MainActor in
            self.onOutput?(Output(compositedCGImage: cg))
        }
    }
}


