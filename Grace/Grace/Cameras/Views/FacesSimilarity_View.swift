//
//  FacesSimilarity_View.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//
import SwiftUI
import Observation


struct FaceCameraSimilarityView: View {

    let model: FaceSimilarityModel
    var showPreview: Bool = true

    var body: some View {
        ZStack {
            if showPreview {
                CameraPreview(session: model.session)
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            GeometryReader { geo in
                ForEach(model.trackedFaces) { tf in
                    let bb = tf.boundingBox
                    let w = bb.width * geo.size.width
                    let h = bb.height * geo.size.height
                    let x = bb.minX * geo.size.width
                    let yTopLeft = (1.0 - bb.maxY) * geo.size.height

                    ZStack(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(lineWidth: 3)

                        VStack(alignment: .leading, spacing: 2) {
                            Text("ID \(tf.personID)")
                                .font(.caption)
                                .bold()

                            if let d = tf.lastDistance {
                                Text(String(format: "dist: %.3f  conf: %.2f", d, tf.confidence))
                                    .font(.caption2)
                            } else {
                                Text(String(format: "dist: —  conf: %.2f", tf.confidence))
                                    .font(.caption2)
                            }
                        }
                        .padding(6)
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .padding(6)
                    }
                    .frame(width: w, height: h)
                    .position(x: x + w * 0.5, y: yTopLeft + h * 0.5)
                    .animation(.smooth(duration: 0.08), value: tf.boundingBox)
                }
            }

            VStack {
                HStack {
                    Circle()
                        .fill(model.isRunning ? .green : .red)
                        .frame(width: 10, height: 10)

                    Text(model.statusText)
                        .font(.footnote)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())

                    Spacer()
                }
                .padding()

                Spacer()
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }
}
