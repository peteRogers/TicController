//
//  FaceLandmarks_View.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import SwiftUI
import Observation

struct FaceLandmarkView: View {
    let model: FaceLandmarkModel
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
                if let bb = model.faceBoundingBox {
                    let w = bb.width * geo.size.width
                    let h = bb.height * geo.size.height
                    let x = bb.minX * geo.size.width
                    let yTopLeft = (1.0 - bb.maxY) * geo.size.height

                    RoundedRectangle(cornerRadius: 10)
                        .stroke(lineWidth: 3)
                        .frame(width: w, height: h)
                        .position(x: x + w * 0.5, y: yTopLeft + h * 0.5)
                        .animation(.smooth(duration: 0.08), value: bb)
                }

                if !model.landmarkPoints.isEmpty {
                    Canvas { context, size in
                        for p in model.landmarkPoints {
                            let pt = CGPoint(
                                x: p.x * size.width,
                                y: (1.0 - p.y) * size.height
                            )
                            let r: CGFloat = 2.0
                            let rect = CGRect(x: pt.x - r, y: pt.y - r, width: r * 2, height: r * 2)
                            context.fill(Path(ellipseIn: rect), with: .color(.white))
                        }
                    }
                    .allowsHitTesting(false)
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

