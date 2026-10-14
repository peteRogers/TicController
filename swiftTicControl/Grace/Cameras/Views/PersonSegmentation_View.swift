//
//  PersonSegmentation_View.swift
//  cameraTest
//
//  Created by Peter Rogers on 28/01/2026.
//
import SwiftUI

struct PersonCutoutView: View {
    let model: PersonSegmentationModel
    var body: some View {
        ZStack {
            if let cg = model.compositedImage {
                Image(decorative: cg, scale: 1.0, orientation: .up)
                    .resizable()
                    .scaledToFill()
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack {
                HStack {
                    Circle().fill(model.isRunning ? .green : .red).frame(width: 10, height: 10)
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
