//
//  TicControlPanel.swift
//  Grace
//
//  Created by Peter Rogers on 01/05/2026.
//
import SwiftUI

struct ControlPanel: View {
    @Binding var motor: MotorControlSettings
    let toggleEnergized: () -> Void
    let applyToTic: () -> Void

    @State private var applyTask: Task<Void, Never>?

    var body: some View {
        VStack {
            Text("Tic \(motor.serialNumber)")
                .font(.title3.bold())

//            Text(motor.name)
//                .font(.caption2)
//                .foregroundStyle(.secondary)
//                .lineLimit(2)
//                .multilineTextAlignment(.center)

            Text("Motor index: \(motor.motorNum)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(motor.isEnergized ? "UI state: energized" : "UI state: deenergized")
                .font(.caption)
                .foregroundStyle(motor.isEnergized ? .green : .red)

            Toggle(isOn: $motor.shouldMoveForward) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("motion direction")
                        .font(.headline)

                    Text(motor.shouldMoveForward ? "Forward motion" : "Backward motion")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .padding(.vertical, 8)
            
            TitledSliderView(
                title: "acceleration",
                value: $motor.accel,
                range: 50_000...320_000_00,
                step: 50000
            )

            TitledSliderView(
                title: "decceleration",
                value: $motor.deccel,
                range: 50_000...320_000_00,
                step: 50000
            )

            TitledSliderView(
                title: "max speed",
                value: $motor.maxSpeed,
                range: 0...900_000_00,
                step: 2000000
            )
            
            VStack(spacing: 12) {
                Text("current limit: \(motor.selectedCurrentLimitMA) mA")
                    .font(.headline)

                Slider(
                    value: $motor.currentIndex,
                    in: 0...Double(motor.supportedCurrentLimitsMA.count - 1),
                    step: 1
                )
            }
            .padding()
            
            Button(motor.isChangingEnergizedState ? "Working..." : (motor.isEnergized ? "Deenergize" : "Energize")) {
                toggleEnergized()
            }
            .buttonStyle(.borderedProminent)
            .tint(motor.isEnergized ? .yellow : .green)
            .foregroundStyle(.black)
            .disabled(motor.isChangingEnergizedState)

            TitledSliderView(
                title: "movement threshold",
                value: $motor.threshold,
                range: 0...100,
                step: 0.2
            ).padding()



        }
        .frame(width: 320)
        .padding()
        .background(.blue.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding()
        .onChange(of: motor.accel) { _, _ in
            scheduleApplyToTic()
        }
        .onChange(of: motor.deccel) { _, _ in
            scheduleApplyToTic()
        }
        .onChange(of: motor.maxSpeed) { _, _ in
            scheduleApplyToTic()
        }
        .onChange(of: motor.currentIndex) { _, _ in
            scheduleApplyToTic()
        }
    }

    private func scheduleApplyToTic() {
        applyTask?.cancel()

        applyTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))

            guard !Task.isCancelled else { return }
            applyToTic()
        }
    }
}
