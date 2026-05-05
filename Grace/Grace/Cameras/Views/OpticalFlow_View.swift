//
//  OpticalFlow_View.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//

import SwiftUI


struct OpticalFlowView: View {
    // Replaces @StateObject for observable classes
    let model:OpticalFlowModel

    var body: some View {
        ZStack {
            CameraPreview(session: model.session)
                .ignoresSafeArea()

            ArrowShape()
                                    .fill(Color.cyan)
                                    .frame(width: 60, height: 80)
                                    // Rotate based on the smooth angle from Vision
                                    // Note: We add 90 degrees if the arrow points 'up' by default
                                    .rotationEffect(.degrees(model.averageAngle))
                                    // Scale the arrow slightly based on intensity
                                    .scaleEffect(CGFloat(model.motionIntensity / 50.0))
                                    .animation(.spring(response: 0.3, dampingFraction: 0.6), value: model.averageAngle)
            VStack {
                VStack(alignment: .leading, spacing: 8) {
                    Text("GLOBAL VIDEO AVERAGE")
                    Text("Angle: \(model.averageAngle)")
                    Text("Intensity: \(model.motionIntensity)")
                }
                .padding()
                .background(.ultraThinMaterial)
                .cornerRadius(12)
                .padding(.top, 50)
                Spacer()
            }
        }.onAppear { model.start() }
            .onDisappear { model.stop() }
    }
}

struct ArrowShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let width = rect.width
        let height = rect.height
        
        path.move(to: CGPoint(x: width / 2, y: 0))           // Tip
        path.addLine(to: CGPoint(x: width, y: height * 0.7)) // Right shoulder
        path.addLine(to: CGPoint(x: width * 0.7, y: height * 0.7)) // Right notch
        path.addLine(to: CGPoint(x: width * 0.7, y: height)) // Right base
        path.addLine(to: CGPoint(x: width * 0.3, y: height)) // Left base
        path.addLine(to: CGPoint(x: width * 0.3, y: height * 0.7)) // Left notch
        path.addLine(to: CGPoint(x: 0, y: height * 0.7))    // Left shoulder
        path.closeSubpath()
        
        return path
    }
}
