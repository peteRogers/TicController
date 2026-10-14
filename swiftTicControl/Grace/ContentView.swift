//
//  ContentView.swift
//  Grace
//
//  Created by Peter Rogers on 27/04/2026.
//

import SwiftUI



struct ContentView: View {
    @State private var opticalModel = OpticalFlowModel()
    @State private var tic = TicController()
    
    var body: some View {
        ZStack{
            VStack {
                OpticalFlowView(model: opticalModel)
            }
            .onChange(of: opticalModel.motionIntensity) { oldValue, newValue in
                for motor in tic.motors {
                    guard motor.isEnergized else {
                        continue
                    }

                    if newValue > Float(motor.threshold) {
                        if motor.shouldMoveForward {
                            tic.moveForward(motorNum: motor.motorNum, speed: Int32(motor.maxSpeed))
                        } else {
                            tic.moveBackward(motorNum: motor.motorNum, speed: Int32(motor.maxSpeed))
                        }
                    } else {
                        tic.stop(motorNum: motor.motorNum)
                    }
                }
            }
            VStack {
                Spacer()

              

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .bottom, spacing: 16) {
                        ForEach($tic.motors) { $motor in
                            ControlPanel(
                                motor: $motor,
                                toggleEnergized: {
                                    guard !motor.isChangingEnergizedState else { return }
                                    motor.isChangingEnergizedState = true

                                    Task {
                                        let success: Bool

                                        if motor.isEnergized {
                                            success = await tic.deenergizeAndConfirm(motorNum: motor.motorNum)
                                        } else {
                                            success = await tic.resumeAndEnergizeAndConfirm(motorNum: motor.motorNum)
                                        }

                                        if success {
                                            motor.isEnergized.toggle()

                                            if !motor.isEnergized {
                                                tic.stop(motorNum: motor.motorNum)
                                            }
                                        }

                                        motor.isChangingEnergizedState = false
                                    }
                                },
                                applyToTic: {
                                    tic.setMotionLimits(
                                        maxSpeed: Int32(motor.maxSpeed),
                                        maxAccel: Int32(motor.accel),
                                        maxDecel: Int32(motor.deccel),
                                        motorNum: motor.motorNum,
                                        current: Double(motor.selectedCurrentLimitMA)
                                    )
                                }
                            )
                        }
                    }
                    .padding(.vertical, 20)
                    .padding(.horizontal, 20)
                }
                HStack(spacing: 12) {
                    Button("Scan Tics") {
                        tic.scanForTics()
                    }
                    .buttonStyle(.borderedProminent)

                    Text(tic.ticListMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .backgroundStyle(.blue)
                }
                .padding(.horizontal, 20)
            }.padding(.bottom, 20)
        }
    }
}

#Preview {
    ContentView()
}

struct TitledSliderView: View {
    let title: String
    @Binding var value: Double
    var range: ClosedRange<Double> = 0...100
    var step: Double
    var body: some View {
        VStack(spacing: 12) {
            Text("\(title): \(Int(value))")
                .font(.headline)
            Slider(value: $value, in: range,  step: step)
        }
        .padding()
    }
}
