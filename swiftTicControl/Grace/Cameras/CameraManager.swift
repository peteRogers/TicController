//
//  CameraManager.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import SwiftUI
import Observation
import AVFoundation
import Vision
import QuartzCore   // CACurrentMediaTime

protocol VideoFrameAnalyser: AnyObject {
    /// Called on the camera's video queue (NOT main actor).
    func analyse(pixelBuffer: CVPixelBuffer, timestamp: CFTimeInterval)
}

protocol SampleBufferAnalyser: AnyObject {
    func analyse(sampleBuffer: CMSampleBuffer, timestamp: CFTimeInterval)
}

@MainActor
final class CameraSessionManager: NSObject {
    enum CameraError: LocalizedError {
        case noDevice
        case cannotAddInput
        case cannotAddOutput

        var errorDescription: String? {
            switch self {
            case .noDevice: return "No video capture device available."
            case .cannotAddInput: return "Cannot add camera input."
            case .cannotAddOutput: return "Cannot add video output."
            }
        }
    }

    // Public
    let session = AVCaptureSession()
    private(set) var isRunning: Bool = false

    // Config
    var sessionPreset: AVCaptureSession.Preset = .vga640x480
    var pixelFormat: OSType = kCVPixelFormatType_32BGRA
    var minFrameInterval: CFTimeInterval = 0.0 // 0 = no throttling (camera max)

    /// Set/replace analysers at runtime.
    var analysers: [VideoFrameAnalyser] = []
    var sampleBufferAnalysers: [SampleBufferAnalyser] = []

    // Private
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "CameraSessionManager.VideoQueue")

    private var isConfigured = false
    private var lastDeliverTime: CFTimeInterval = 0

    func start() async throws {
        let granted = await Self.requestCameraAccessIfNeeded()
        guard granted else { throw NSError(domain: "CameraSessionManager", code: 0, userInfo: [NSLocalizedDescriptionKey: "Camera permission not granted"]) }

        try configureIfNeeded()
        session.startRunning()
        isRunning = true
    }

    func stop() {
        if session.isRunning { session.stopRunning() }
        isRunning = false
        queue.async { [weak self] in self?.lastDeliverTime = 0 }
    }

    private func configureIfNeeded() throws {
        guard !isConfigured else { return }
        isConfigured = true

        session.beginConfiguration()
        session.sessionPreset = sessionPreset

        guard let camera = Self.preferredCameraDevice() else {
            session.commitConfiguration()
            throw CameraError.noDevice
        }

        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CameraError.cannotAddInput
        }
        session.addInput(input)

        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(pixelFormat)]
        output.setSampleBufferDelegate(self, queue: queue)

        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CameraError.cannotAddOutput
        }
        session.addOutput(output)

        if let conn = output.connection(with: .video) {
            conn.videoRotationAngle = 90
            conn.isVideoMirrored = (camera.position == .front)
        }

        session.commitConfiguration()
    }
    
    private static func preferredCameraDevice() -> AVCaptureDevice? {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        )

        if let builtIn = discovery.devices.first(where: { $0.deviceType == .builtInWideAngleCamera }) {
            return builtIn
        }

        if let external = discovery.devices.first(where: { $0.deviceType == .external }) {
            return external
        }

        return discovery.devices.first
    }

//    private static func preferredCameraDevice() -> AVCaptureDevice? {
//        let discovery = AVCaptureDevice.DiscoverySession(
//            deviceTypes: [.external, .builtInWideAngleCamera],
//            mediaType: .video,
//            position: .unspecified
//        )
//
//        if let external = discovery.devices.first(where: { $0.deviceType == .external }) {
//            return external
//        }
//        return discovery.devices.first
//    }

    private static func requestCameraAccessIfNeeded() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: .video) { cont.resume(returning: $0) }
            }
        default:
            return false
        }
    }
}

extension CameraSessionManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {

        let now = CACurrentMediaTime()

        // (optional) throttle once here
        if minFrameInterval > 0, now - lastDeliverTime < minFrameInterval { return }
        lastDeliverTime = now

        // 1) sampleBuffer analysers (optical flow etc.)
        for a in sampleBufferAnalysers {
            a.analyse(sampleBuffer: sampleBuffer, timestamp: now)
        }

        // 2) pixelBuffer analysers (brightness, faces, etc.)
        if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            for a in analysers {
                a.analyse(pixelBuffer: pixelBuffer, timestamp: now)
            }
        }
    }
}



// MARK: - SwiftUI camera preview (Catalyst / iOS / macOS)

struct CameraPreview: View {
    let session: AVCaptureSession

    var body: some View {
        PreviewRepresentable(session: session)
    }
}

//#if canImport(UIKit)
#if os(iOS) || targetEnvironment(macCatalyst)
import UIKit
struct PreviewRepresentable: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.setSession(session)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.setSession(session)
    }
}

final class PreviewView: UIView {
    private let previewLayer = AVCaptureVideoPreviewLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        previewLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(previewLayer)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        backgroundColor = .black
        previewLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(previewLayer)
    }

    func setSession(_ session: AVCaptureSession) {
        if previewLayer.session !== session {
            previewLayer.session = session
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.frame = bounds
        CATransaction.commit()
    }
}

#elseif os(macOS)
import AppKit
struct PreviewRepresentable: NSViewRepresentable {
    let session: AVCaptureSession

    func makeNSView(context: Context) -> PreviewNSView {
        let view = PreviewNSView()
        view.setSession(session)
        return view
    }

    func updateNSView(_ nsView: PreviewNSView, context: Context) {
        nsView.setSession(session)
    }
}

final class PreviewNSView: NSView {
    private let previewLayer = AVCaptureVideoPreviewLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.black.cgColor
        previewLayer.videoGravity = .resizeAspectFill
        layer?.addSublayer(previewLayer)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.black.cgColor
        previewLayer.videoGravity = .resizeAspectFill
        layer?.addSublayer(previewLayer)
    }

    func setSession(_ session: AVCaptureSession) {
        if previewLayer.session !== session {
            previewLayer.session = session
        }
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.frame = bounds
        CATransaction.commit()
    }
}
#endif



