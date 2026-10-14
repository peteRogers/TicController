//
//  FaceSimilarityAnalyser.swift
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


final class FaceSimilarityAnalyser: VideoFrameAnalyser {

    // UI-friendly output
    struct TrackedFace: Identifiable, Equatable {
        let id: Int
        let personID: Int
        var boundingBox: CGRect
        var lastDistance: Double?
        var confidence: Double
        var lastSeen: CFTimeInterval
    }

    private struct Track {
        var id: Int
        var bbox: CGRect
        var lastSeen: CFTimeInterval
        var prints: [VNFeaturePrintObservation]
        var lastDistance: Double?
        var confidence: Double
        var trackingObservation: VNDetectedObjectObservation?
    }

    /// Called on MAIN whenever output updates.
    var onOutput: (@MainActor ([TrackedFace]) -> Void)?

    // Vision
    private let sequenceHandler = VNSequenceRequestHandler()
    private let ciContext = CIContext()

    // Tracks
    private var nextPersonID: Int = 1
    private var tracks: [Int: Track] = [:]

    // Tuning (same meaning as your original model)
    var forgetAfterSeconds: CFTimeInterval = 30.0
    var matchThreshold: Float = 0.45     // strict threshold
    var relaxedThreshold: Float = 0.85   // allowed when IOU is high
    var minIOUForRelaxed: Float = 0.20
    var strongOverlapNoNewID: Float = 0.30
    var maxPrintHistory: Int = 8

    // Identity refresh throttle
    var detectionInterval: CFTimeInterval = 0.08
    private var lastDetectionTime: CFTimeInterval = 0

    func analyse(pixelBuffer: CVPixelBuffer, timestamp: CFTimeInterval) {
        let now = timestamp

        // 0) Tracking every frame
        trackExistingObjects(on: pixelBuffer, now: now)

        // Identity refresh periodically (rectangles + prints)
        if now - lastDetectionTime < detectionInterval {
            publishTracks(now: now)
            return
        }
        lastDetectionTime = now

        // 1) Detect faces
        let detect = VNDetectFaceRectanglesRequest()
        do {
            try sequenceHandler.perform([detect], on: pixelBuffer, orientation: .up)
        } catch {
            return
        }

        let faces = (detect.results as? [VNFaceObservation]) ?? []

        // If no faces: do NOT clear IDs, keep them alive (TTL handles expiry)
        if faces.isEmpty {
            publishTracks(now: now)
            return
        }

        // 2) Build detections (bbox + feature print)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let width = ciImage.extent.width
        let height = ciImage.extent.height

        struct Detection {
            let bbox: CGRect
            let fp: VNFeaturePrintObservation
        }

        var detections: [Detection] = []
        detections.reserveCapacity(faces.count)

        for face in faces {
            let bb = face.boundingBox

            let rect = CGRect(
                x: bb.minX * width,
                y: bb.minY * height,
                width: bb.width * width,
                height: bb.height * height
            ).intersection(ciImage.extent)

            guard rect.width >= 16, rect.height >= 16 else { continue }

            let cropped = ciImage.cropped(to: rect)
            guard let cg = ciContext.createCGImage(cropped, from: cropped.extent) else { continue }

            let req = VNGenerateImageFeaturePrintRequest()
            let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
            do { try handler.perform([req]) } catch { continue }

            guard let fp = req.results?.first as? VNFeaturePrintObservation else { continue }
            detections.append(Detection(bbox: bb, fp: fp))
        }

        if detections.isEmpty {
            publishTracks(now: now)
            return
        }

        // 3) If no tracks, create tracks from detections
        if tracks.isEmpty {
            for det in detections {
                let id = nextPersonID
                nextPersonID += 1

                tracks[id] = Track(
                    id: id,
                    bbox: det.bbox,
                    lastSeen: now,
                    prints: [det.fp],
                    lastDistance: nil,
                    confidence: 1.0,
                    trackingObservation: VNDetectedObjectObservation(boundingBox: det.bbox)
                )
            }
            publishTracks(now: now)
            return
        }

        // 4) Cost matrix for greedy assignment (min distance over history + IOU blend)
        let trackIDs = tracks.keys.sorted()

        var costMatrix: [[Float]] = []
        costMatrix.reserveCapacity(trackIDs.count)

        for tid in trackIDs {
            guard let tr = tracks[tid], !tr.prints.isEmpty else {
                costMatrix.append(Array(repeating: Float.greatestFiniteMagnitude, count: detections.count))
                continue
            }

            var row: [Float] = []
            row.reserveCapacity(detections.count)

            for det in detections {
                let dist = minDistance(to: tr, from: det.fp)
                let overlap = iou(tr.bbox, det.bbox)

                let allow: Bool = (overlap >= minIOUForRelaxed)
                    ? (dist <= relaxedThreshold)
                    : (dist <= matchThreshold)

                if allow {
                    let cost = (0.80 * dist) + (0.20 * (1.0 - overlap))
                    row.append(cost)
                } else {
                    row.append(Float.greatestFiniteMagnitude)
                }
            }

            costMatrix.append(row)
        }

        let assignments = assignGreedy(costMatrix)

        var matchedDetections = Set<Int>()
        var matchedTracks = Set<Int>()

        // 5) Apply matches
        for (trackIndex, detectionIndex) in assignments {
            let tid = trackIDs[trackIndex]
            let det = detections[detectionIndex]
            guard var tr = tracks[tid] else { continue }

            matchedTracks.insert(tid)
            matchedDetections.insert(detectionIndex)

            tr.bbox = det.bbox
            tr.trackingObservation = VNDetectedObjectObservation(boundingBox: det.bbox)
            tr.lastSeen = now

            let appearanceDist = minDistance(to: tr, from: det.fp)
            tr.lastDistance = Double(appearanceDist)

            tr.confidence = min(1.0, tr.confidence + 0.12)

            tr.prints.append(det.fp)
            if tr.prints.count > maxPrintHistory {
                tr.prints.removeFirst(tr.prints.count - maxPrintHistory)
            }

            tracks[tid] = tr
        }

        // 6) Unmatched tracks: decay confidence, keep alive
        for tid in trackIDs where !matchedTracks.contains(tid) {
            guard var tr = tracks[tid] else { continue }
            tr.confidence = max(0.0, tr.confidence - 0.08)
            if tr.confidence < 0.10 { tr.trackingObservation = nil }
            tracks[tid] = tr
        }

        // 7) Unmatched detections: create new IDs only if not strongly overlapping an existing track
        for (idx, det) in detections.enumerated() where !matchedDetections.contains(idx) {
            var overlapsExisting = false
            for tid in trackIDs {
                if let tr = tracks[tid], iou(tr.bbox, det.bbox) >= strongOverlapNoNewID {
                    overlapsExisting = true
                    break
                }
            }
            if overlapsExisting { continue }

            let id = nextPersonID
            nextPersonID += 1

            tracks[id] = Track(
                id: id,
                bbox: det.bbox,
                lastSeen: now,
                prints: [det.fp],
                lastDistance: nil,
                confidence: 1.0,
                trackingObservation: VNDetectedObjectObservation(boundingBox: det.bbox)
            )
        }

        publishTracks(now: now)
    }

    // MARK: - Helpers

    private func iou(_ a: CGRect, _ b: CGRect) -> Float {
        let inter = a.intersection(b)
        if inter.isNull || inter.width <= 0 || inter.height <= 0 { return 0 }
        let interArea = Float(inter.width * inter.height)
        let unionArea = Float(a.width * a.height + b.width * b.height) - interArea
        if unionArea <= 0 { return 0 }
        return interArea / unionArea
    }

    private func minDistance(to track: Track, from fp: VNFeaturePrintObservation) -> Float {
        var best: Float = .greatestFiniteMagnitude
        for stored in track.prints {
            var d: Float = 0
            do { try fp.computeDistance(&d, to: stored) } catch { continue }
            if d < best { best = d }
        }
        return best
    }

    private func assignGreedy(_ costMatrix: [[Float]]) -> [(Int, Int)] {
        var assignments: [(Int, Int)] = []
        var usedRows: Set<Int> = []
        var usedCols: Set<Int> = []

        let rowCount = costMatrix.count
        let colCount = costMatrix.first?.count ?? 0

        while true {
            var best: Float = .greatestFiniteMagnitude
            var bestR: Int? = nil
            var bestC: Int? = nil

            for r in 0..<rowCount where !usedRows.contains(r) {
                for c in 0..<colCount where !usedCols.contains(c) {
                    let v = costMatrix[r][c]
                    if v < best {
                        best = v
                        bestR = r
                        bestC = c
                    }
                }
            }

            if let r = bestR, let c = bestC, best < Float.greatestFiniteMagnitude {
                assignments.append((r, c))
                usedRows.insert(r)
                usedCols.insert(c)
            } else {
                break
            }
        }

        return assignments
    }

    private func publishTracks(now: CFTimeInterval) {
        let cutoff = now - forgetAfterSeconds
        tracks = tracks.filter { $0.value.lastSeen >= cutoff }

        let ui = tracks.values
            .sorted(by: { $0.id < $1.id })
            .map { t in
                TrackedFace(
                    id: t.id,
                    personID: t.id,
                    boundingBox: t.bbox,
                    lastDistance: t.lastDistance,
                    confidence: t.confidence,
                    lastSeen: t.lastSeen
                )
            }

        Task { @MainActor in
            self.onOutput?(ui)
        }
    }

    private func trackExistingObjects(on pixelBuffer: CVPixelBuffer, now: CFTimeInterval) {
        guard !tracks.isEmpty else { return }

        let ids = tracks.keys.sorted()

        var requests: [VNTrackObjectRequest] = []
        requests.reserveCapacity(ids.count)

        for tid in ids {
            guard let obs = tracks[tid]?.trackingObservation else { continue }
            let req = VNTrackObjectRequest(detectedObjectObservation: obs)
            req.trackingLevel = .fast
            requests.append(req)
        }
        guard !requests.isEmpty else { return }

        do {
            try sequenceHandler.perform(requests, on: pixelBuffer, orientation: .up)
        } catch {
            return
        }

        var reqIndex = 0
        for tid in ids {
            guard var tr = tracks[tid], tr.trackingObservation != nil else { continue }
            let req = requests[reqIndex]
            reqIndex += 1

            guard let newObs = req.results?.first as? VNDetectedObjectObservation else {
                tr.trackingObservation = nil
                tr.confidence = max(0.0, tr.confidence - 0.20)
                tracks[tid] = tr
                continue
            }

            if newObs.confidence < 0.2 {
                tr.trackingObservation = nil
                tr.confidence = max(0.0, tr.confidence - 0.20)
                tracks[tid] = tr
                continue
            }

            tr.trackingObservation = newObs
            tr.bbox = newObs.boundingBox
            tr.lastSeen = now
            tr.confidence = min(1.0, max(tr.confidence * 0.8, Double(newObs.confidence)))
            tracks[tid] = tr
        }
    }
}




