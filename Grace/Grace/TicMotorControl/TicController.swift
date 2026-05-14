//
//  TicController.swift
//  Grace
//
//  Created by Peter Rogers on 27/04/2026.
//

import SwiftUI
import Observation
import Foundation


@MainActor
@Observable
final class TicController {
    // MARK: - Settings
    var ticcmdPath: String = "/Applications/Pololu Tic Stepper Motor Controller.app/Contents/MacOS/ticcmd"
    var serialNumbers: [String] = []
    var ticListMessage: String = "No Tic scan yet"
    var motors: [MotorControlSettings] = []
    let supportedCurrentLimitsMA: [Int] = [
        174,343, 495, 634, 762, 880, 990
    ]

    var selectedCurrentLimitIndex: Double = 3
    var selectedCurrentLimitMA: Int {
        let safeIndex = min(
            max(Int(selectedCurrentLimitIndex.rounded()), 0),
            supportedCurrentLimitsMA.count - 1
        )

        return supportedCurrentLimitsMA[safeIndex]
    }

    var isMoving: Bool = false
    var lastMessage: String = "Ready"
    var lastError: String = ""
    var lastCommand: String = ""
    var resolvedTiccmdPath: String = "Not checked yet"

    private var keepAliveTimer: Timer?

    // MARK: - Public controls

    func testTiccmdList() {
        lastError = ""
        lastMessage = "Testing ticcmd --list..."
        print("test")
        Task {
            await runRawTiccmd(["--list"])
        }
    }
    
    func listTicDevices() async throws -> [TicDevice] {
        lastError = ""
        lastMessage = "Running ticcmd --list..."

        guard let ticcmdURL = findTiccmdURL() else {
            lastError = "Could not find ticcmd. Check Terminal with: which ticcmd"
            lastCommand = "ticcmd not found"
            throw NSError(
                domain: "ticcmd",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: lastError]
            )
        }

        resolvedTiccmdPath = ticcmdURL.path
        lastCommand = "\(ticcmdURL.path) --list"

        let result = await runProcess(
            executableURL: ticcmdURL,
            arguments: ["--list"]
        )

        if result.exitCode != 0 {
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
            let error = result.error.trimmingCharacters(in: .whitespacesAndNewlines)

            lastError = """
            ticcmd --list failed.
            Exit code: \(result.exitCode)
            Command: \(lastCommand)
            Output: \(output.isEmpty ? "none" : output)
            Error: \(error.isEmpty ? "none" : error)
            """

            throw NSError(
                domain: "ticcmd",
                code: Int(result.exitCode),
                userInfo: [NSLocalizedDescriptionKey: lastError]
            )
        }

        let devices = parseTicList(result.output)
        serialNumbers = devices.map(\.serialNumber)
        lastMessage = "Found \(devices.count) Tic controller(s)"
        return devices
    }

    func scanForTics() {
        ticListMessage = "Scanning for Tic controllers..."

        Task {
            do {
                let devices = try await listTicDevices()

                if devices.isEmpty {
                    ticListMessage = "No Tic controllers found"
                    motors = []
                } else {
                    ticListMessage = "Found \(devices.count) Tic controller(s)"
                    motors = devices.enumerated().map { index, device in
                        MotorControlSettings(
                            name: device.description,
                            serialNumber: device.serialNumber,
                            motorNum: index,
                            isEnergized: false
                        )
                    }
                }
            } catch {
                ticListMessage = "Tic scan failed: \(error.localizedDescription)"
                motors = []
            }
        }
    }

    func setMotionLimits(maxSpeed: Int32, maxAccel: Int32, maxDecel: Int32, motorNum:Int, current: Double) {
       // velocityText = "\(maxSpeed)"
        Task {
            let currentMA = Int(current.rounded())

            await runTicCommand([
                "--max-speed", "\(maxSpeed)",
                "--max-accel", "\(maxAccel)",
                "--max-decel", "\(maxDecel)",
                "--current", "\(currentMA)"
            ], motorNum: motorNum)
        }
    }

    func moveForward(motorNum: Int, speed: Int32) {
        startMoving(velocity: abs(speed), motorNum: motorNum)
    }

    func moveBackward(motorNum: Int, speed: Int32) {
        startMoving(velocity: -abs(speed), motorNum: motorNum)
    }

    func stop(motorNum: Int) {
        stopKeepAlive()
        isMoving = false
        lastMessage = "Stopping..."
        Task {
            await runTicCommand(["--velocity", "0"], motorNum: motorNum)
            lastMessage = "Stopped"
        }
    }

    func deenergize(motorNum: Int) {
        Task {
            _ = await deenergizeAndConfirm(motorNum: motorNum)
        }
    }


    func deenergizeAndConfirm(motorNum: Int) async -> Bool {
        guard serialNumbers.indices.contains(motorNum) else {
            lastError = "No Tic serial number found for motor index \(motorNum). Try Scan Tics first."
            lastMessage = "Could not deenergize motor \(motorNum)"
            return false
        }

        stopKeepAlive()
        isMoving = false
        lastError = ""
        lastMessage = "De-energizing motor \(motorNum)..."

        let stopped = await runTicCommand(["--velocity", "0"], motorNum: motorNum)
        guard stopped else {
            lastMessage = "Failed to stop motor \(motorNum) before deenergizing"
            return false
        }

        stopKeepAlive()

        let deenergized = await runTicCommand(["--deenergize"], motorNum: motorNum)
        guard deenergized else {
            lastMessage = "Failed to deenergize motor \(motorNum)"
            return false
        }

        lastMessage = "Motor \(motorNum) deenergized"
        return true
    }

    func resumeAndEnergize(motorNum: Int) {
        Task {
            _ = await resumeAndEnergizeAndConfirm(motorNum: motorNum)
        }
    }

    func resumeAndEnergizeAndConfirm(motorNum: Int) async -> Bool {
        guard serialNumbers.indices.contains(motorNum) else {
            lastError = "No Tic serial number found for motor index \(motorNum). Try Scan Tics first."
            lastMessage = "Could not energize motor \(motorNum)"
            return false
        }

        lastError = ""
        lastMessage = "Energizing motor \(motorNum)..."

        let energized = await runTicCommand(["--energize"], motorNum: motorNum)
        guard energized else {
            lastMessage = "Failed to energize motor \(motorNum)"
            return false
        }

        let exitedSafeStart = await runTicCommand(["--exit-safe-start"], motorNum: motorNum)
        guard exitedSafeStart else {
            lastMessage = "Failed to exit safe start for motor \(motorNum)"
            return false
        }

        let resumed = await runTicCommand(["--resume"], motorNum: motorNum)
        guard resumed else {
            lastMessage = "Failed to resume motor \(motorNum)"
            return false
        }

        lastMessage = "Motor \(motorNum) resumed and energized"
        return true
    }

    func setSelectedCurrentLimit(motorNum: Int) {
        let currentMA = selectedCurrentLimitMA
        lastMessage = "Setting current limit to \(currentMA) mA..."
        Task {
            let success = await runTicCommand([
                "--current", "\(currentMA)"
            ], motorNum: motorNum)

            if success {
                lastMessage = "Current limit set to \(currentMA) mA"
            }
        }
    }

    // MARK: - Main movement

    func startMoving(velocity: Int32, motorNum: Int) {
        lastError = ""
        lastMessage = "Starting..."
        stopKeepAlive()
        Task {
            let success = await runTicCommand([
                "--resume",
                "--velocity", "\(velocity)"
            ], motorNum: motorNum)

            if success {
                startKeepAlive(motorNum: motorNum)
                isMoving = velocity != 0
                lastMessage = "Moving at velocity \(velocity)"
            } else {
                isMoving = false
                stopKeepAlive()
            }
        }
    }

    // MARK: - Keep alive

    private func startKeepAlive(motorNum:Int) {
        keepAliveTimer?.invalidate()

        keepAliveTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }

            Task { @MainActor in
                await self.runTicCommand(
                    ["--reset-command-timeout"],
                    showAsLastMessage: false,
                    motorNum: motorNum
                )
            }
        }
    }

    private func stopKeepAlive() {
        keepAliveTimer?.invalidate()
        keepAliveTimer = nil
    }


    // MARK: - ticcmd wrappers

    @discardableResult
    private func runTicCommand(
        _ arguments: [String],
        showAsLastMessage: Bool = true,
        motorNum: Int
    ) async -> Bool {
        guard serialNumbers.indices.contains(motorNum) else {
            lastError = "No Tic serial number found for motor index \(motorNum). Try Scan Tics first."
            lastCommand = "ticcmd command not run"
            return false
        }

        return await runRawTiccmd(
            ["-d", serialNumbers[motorNum]] + arguments,
            showAsLastMessage: showAsLastMessage
        )
    }

    @discardableResult
    private func runRawTiccmd(
        _ arguments: [String],
        showAsLastMessage: Bool = true
    ) async -> Bool {
        lastError = ""

        guard let ticcmdURL = findTiccmdURL() else {
            lastError = "Could not find ticcmd. Check Terminal with: which ticcmd"
            lastCommand = "ticcmd not found"
            return false
        }

        resolvedTiccmdPath = ticcmdURL.path
        lastCommand = ([ticcmdURL.path] + arguments).joined(separator: " ")
        print("Running:", lastCommand)

        let result = await runProcess(
            executableURL: ticcmdURL,
            arguments: arguments
        )

        if result.exitCode == 0 {
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
            let error = result.error.trimmingCharacters(in: .whitespacesAndNewlines)

            if showAsLastMessage {
                if !output.isEmpty {
                    lastMessage = output
                } else if !error.isEmpty {
                    lastMessage = error
                } else {
                    lastMessage = "ticcmd command succeeded"
                }
            }

            return true
        } else {
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
            let error = result.error.trimmingCharacters(in: .whitespacesAndNewlines)

            lastError = """
            ticcmd failed.
            Exit code: \(result.exitCode)
            Command: \(lastCommand)
            Output: \(output.isEmpty ? "none" : output)
            Error: \(error.isEmpty ? "none" : error)
            """

            return false
        }
    }

    private func parseTicList(_ output: String) -> [TicDevice] {
        output
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .enumerated()
            .map { index, line in
                let serial = extractSerialNumber(from: line) ?? "tic-\(index)"
                return TicDevice(
                    id: serial,
                    serialNumber: serial,
                    description: line
                )
            }
    }

    private func extractSerialNumber(from line: String) -> String? {
        let parts = line.split { character in
            character == " " || character == "\t" || character == "," || character == ":"
        }

        return parts.first { part in
            part.allSatisfy { $0.isNumber } && part.count >= 6
        }.map(String.init)
    }

    private func findTiccmdURL() -> URL? {
        let possiblePaths = [
            ticcmdPath,
            "/opt/homebrew/bin/ticcmd",
            "/usr/local/bin/ticcmd"
        ]

        for path in possiblePaths {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }

        return nil
    }

    private nonisolated func runProcess(
        executableURL: URL,
        arguments: [String]
    ) async -> (exitCode: Int32, output: String, error: String) {
        await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = executableURL
            process.arguments = arguments

            let outputPipe = Pipe()
            let errorPipe = Pipe()

            process.standardOutput = outputPipe
            process.standardError = errorPipe

            do {
                try process.run()
                process.waitUntilExit()

                let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
                let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()

                return (
                    process.terminationStatus,
                    String(data: outputData, encoding: .utf8) ?? "",
                    String(data: errorData, encoding: .utf8) ?? ""
                )
            } catch {
                return (
                    -1,
                    "",
                    error.localizedDescription
                )
            }
        }.value
    }
}
//MARK: data structs

struct TicDevice: Identifiable {
    let id: String
    let serialNumber: String
    let description: String
}


struct MotorControlSettings: Identifiable {
    let id = UUID()
    var name: String
    var serialNumber: String
    var motorNum: Int
    var accel: Double = 100000
    var deccel: Double = 100000
    var maxSpeed: Double = 12000000
    var threshold: Double = 5
    var currentIndex: Double = 3
    var shouldMoveForward: Bool = true
    var isEnergized: Bool = false
    var isChangingEnergizedState: Bool = false

    let supportedCurrentLimitsMA: [Int] = [
        343, 445, 506, 634, 762, 880, 1007, 1115, 1241, 1352, 1500
    ]

    var selectedCurrentLimitMA: Int {
        let safeIndex = min(
            max(Int(currentIndex.rounded()), 0),
            supportedCurrentLimitsMA.count - 1
        )

        return supportedCurrentLimitsMA[safeIndex]
    }
}
