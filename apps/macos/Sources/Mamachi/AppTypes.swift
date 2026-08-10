import CoreGraphics
import Foundation

struct TranscriptEntry: Codable, Identifiable, Equatable {
    enum Speaker: String, Codable {
        case user
        case mamachi
    }

    let id: UUID
    let speaker: Speaker
    let text: String
    let at: Date
}

struct TaskViewState: Identifiable, Equatable {
    let id: String
    var state: String
    var revision: Int
    var objective: String
    var terminalSummary: String?
    var recentActivity: String?
    // Display-only facts populated as richer domain events land. Defaulted so
    // existing initializers stay source-compatible.
    /// Which repository this task runs in -- shown so concurrent task cards
    /// (multiple repos can be active at once) are distinguishable.
    var repositoryId: String = ""
    var phase: String? = nil
    var currentStep: String? = nil
    /// Grounded progress in percent (0–100) from the daemon fact projector.
    var progress: Double? = nil
    var verificationState: String? = nil
    var pendingQuestion: String? = nil
    var createdAt: Date? = nil
    var specHistory: [SpecRevisionViewState] = []
    var observerSummary: String? = nil
    var observerRisks: [String] = []
    var observerNextStep: String? = nil
    var blockers: [BlockerViewState] = []
    var changedFiles: [ChangedFileViewState] = []
    var evidence: [EvidenceViewState] = []
    var runBoundaries: [RunBoundaryViewState] = []

    var isTerminal: Bool {
        ["completed", "failed", "cancelled"].contains(state)
    }

    /// Short, human-readable repository name for distinguishing concurrent
    /// task cards -- the folder name, not the full path.
    var repositoryLabel: String {
        repositoryId.isEmpty ? "" : URL(fileURLWithPath: repositoryId).lastPathComponent
    }

    var stateLabel: String {
        state.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var phaseLabel: String? {
        switch phase {
        case "understanding": "Understanding"
        case "execution": "Executing"
        case "implementation": "Implementing"
        case "verification": "Verifying"
        case "awaiting_user": "Needs you"
        case "complete": "Complete"
        case let .some(other): other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: nil
        }
    }
}

struct CapturedContextViewState: Identifiable, Equatable {
    let id: String
    let kind: String
    let summary: String
}

/// One immutable revision of the task specification, oldest first.
struct SpecRevisionViewState: Identifiable, Equatable {
    let revision: Int
    let objective: String
    var revisedAt: Date? = nil

    var id: Int { revision }
}

/// Spoken updates queued while the microphone sleeps (PRD 8.1).
struct PendingBriefViewState: Equatable {
    var count = 0
    var latestSummary = ""
}

/// A blocker or conflict the coder surfaced while working a task.
struct BlockerViewState: Identifiable, Equatable {
    let id: String
    var summary: String
    /// "blocker" for missing prerequisites, "conflict" for merge/revision conflicts.
    var kind: String = "blocker"
}

/// A file the coder created, edited, or deleted for the current task.
struct ChangedFileViewState: Identifiable, Equatable {
    /// Workspace-relative (or absolute) path; doubles as the identity.
    let path: String
    /// "modified", "added", "deleted", or "renamed".
    var kind: String = "modified"
    var summary: String? = nil
    /// Optional 1-based range for editor deep links.
    var line: Int? = nil
    var endLine: Int? = nil

    var id: String { path }
}

/// Verification evidence the coder produced: test runs, builds, manual checks.
struct EvidenceViewState: Identifiable, Equatable {
    let id: String
    var summary: String
    /// "test", "build", "lint", "run", or "manual".
    var kind: String = "check"
    /// nil while pending or informational; true/false once judged.
    var passed: Bool? = nil
    var detail: String? = nil
    /// Optional source location backing the evidence.
    var file: String? = nil
    var line: Int? = nil
}

/// A run or recovery boundary in the task's execution timeline.
struct RunBoundaryViewState: Identifiable, Equatable {
    let id: String
    var label: String
    /// "run" for a fresh run, "recovery" for resume-after-interruption.
    var kind: String = "run"
    var at: Date? = nil
}

/// One line of live coder activity shown in the task activity ticker.
struct CoderFeedEntry: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let at: Date
}

struct ConfirmationViewState: Identifiable, Equatable {
    let id: String
    let taskId: String
    let taskRevision: Int
    let category: String
    let summary: String
    let toolName: String
    let state: String
}


enum OverlaySizePreset: String, CaseIterable, Identifiable {
    case small
    case medium
    case large

    var id: String { rawValue }

    var label: String {
        switch self {
        case .small: "Small"
        case .medium: "Medium"
        case .large: "Large"
        }
    }

    var collapsedSize: CGSize {
        switch self {
        case .small: CGSize(width: 116, height: 28)
        case .medium: CGSize(width: 152, height: 32)
        case .large: CGSize(width: 192, height: 38)
        }
    }

    var expandedSize: CGSize {
        switch self {
        case .small: CGSize(width: 440, height: 540)
        case .medium: CGSize(width: 512, height: 652)
        case .large: CGSize(width: 640, height: 800)
        }
    }

    var collapsedDimensions: String {
        "\(Int(collapsedSize.width)) × \(Int(collapsedSize.height))"
    }

    var expandedDimensions: String {
        "\(Int(expandedSize.width)) × \(Int(expandedSize.height))"
    }
}

enum InteractionMode: String, CaseIterable, Identifiable {
    case voice
    case text

    var id: String { rawValue }
    var label: String { self == .voice ? "Voice" : "Chat" }
    var systemImage: String { self == .voice ? "waveform" : "text.bubble" }
}

/// Which pipeline serves voice sessions. `realtime` is OpenAI's native
/// speech-to-speech model; `cascade` chains dedicated STT, LLM, and TTS
/// providers for lower cost and swappable voices.
enum VoiceEngine: String, CaseIterable, Identifiable {
    case realtime
    case cascade

    var id: String { rawValue }

    var label: String {
        switch self {
        case .realtime: "Speech-to-speech (OpenAI Realtime)"
        case .cascade: "Cascaded (Scribe v2 → GPT-5.5 → ElevenLabs)"
        }
    }

    var detail: String {
        switch self {
        case .realtime: "One OpenAI Realtime model listens and speaks over a single WebSocket."
        case .cascade: "ElevenLabs Scribe v2 Realtime → GPT-5.5 (reasoning: none) → ElevenLabs Flash v2.5 · voice: Rachel"
        }
    }
}

enum ComputerCapability: String, CaseIterable, Identifiable {
    case applications
    case screenObservation = "screen_observation"
    case windows
    case keyboard
    case pointer
    case clipboardRead = "clipboard_read"
    case clipboardWrite = "clipboard_write"
    case system
    case appleScript = "apple_script"
    case shell

    var id: String { rawValue }

    var label: String {
        switch self {
        case .applications: "Applications and media"
        case .screenObservation: "Screen and UI inspection"
        case .windows: "Window management"
        case .keyboard: "Keyboard and text entry"
        case .pointer: "Pointer, clicks, and scrolling"
        case .clipboardRead: "Read clipboard"
        case .clipboardWrite: "Write clipboard"
        case .system: "System controls"
        case .appleScript: "Raw AppleScript"
        case .shell: "Raw shell commands"
        }
    }

    var detail: String {
        switch self {
        case .applications: "Open, activate, hide, quit, and control supported media apps."
        case .screenObservation: "List apps and windows, inspect accessibility UI, and take screenshots."
        case .windows: "Move, resize, minimize, maximize, fullscreen, and close windows."
        case .keyboard: "Type text and send keys or shortcuts to the active app."
        case .pointer: "Move, click, drag, right-click, and scroll by screen coordinate."
        case .clipboardRead: "Allows clipboard contents to enter the voice model's tool context."
        case .clipboardWrite: "Replace the current clipboard contents."
        case .system: "Volume, lock screen, display sleep, Mission Control, and Show Desktop."
        case .appleScript: "Execute unrestricted AppleScript. This can control other applications."
        case .shell: "Execute unrestricted zsh commands outside the coding agent sandbox."
        }
    }

    var isElevated: Bool {
        self == .clipboardRead || self == .appleScript || self == .shell
    }

    static let basic: Set<Self> = [.applications, .screenObservation, .system]
    static let assistive: Set<Self> = [
        .applications,
        .screenObservation,
        .windows,
        .keyboard,
        .pointer,
        .clipboardWrite,
        .system,
    ]
    static let full = Set(allCases)
}

enum ComputerControlProfile: String, CaseIterable, Identifiable {
    case off
    case basic
    case assistive
    case full
    case custom

    var id: String { rawValue }
    static let selectable: [Self] = [.off, .basic, .assistive, .full]

    var label: String {
        switch self {
        case .off: "Off"
        case .basic: "Basic"
        case .assistive: "Assistive"
        case .full: "Full"
        case .custom: "Custom"
        }
    }

    var capabilities: Set<ComputerCapability>? {
        switch self {
        case .off: []
        case .basic: ComputerCapability.basic
        case .assistive: ComputerCapability.assistive
        case .full: ComputerCapability.full
        case .custom: nil
        }
    }

    static func matching(_ capabilities: Set<ComputerCapability>) -> Self {
        selectable.first(where: { $0.capabilities == capabilities }) ?? .custom
    }
}

enum ComputerConfirmationMode: String, CaseIterable, Identifiable {
    case always
    case sensitive
    case never

    var id: String { rawValue }

    var label: String {
        switch self {
        case .always: "Always ask"
        case .sensitive: "Ask for sensitive actions"
        case .never: "Never ask"
        }
    }
}

enum VoiceConnectionState: String {
    case disconnected
    case connecting
    case connected
    case listening
    case thinking
    case speaking
    case error

    var label: String {
        switch self {
        case .disconnected: "Offline"
        case .connecting: "Connecting"
        case .connected: "Ready"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .error: "Needs attention"
        }
    }
}

enum ProtocolID {
    static func makeV7(now: Date = Date()) -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let milliseconds = UInt64(max(0, now.timeIntervalSince1970 * 1_000))
        bytes[0] = UInt8(truncatingIfNeeded: milliseconds >> 40)
        bytes[1] = UInt8(truncatingIfNeeded: milliseconds >> 32)
        bytes[2] = UInt8(truncatingIfNeeded: milliseconds >> 24)
        bytes[3] = UInt8(truncatingIfNeeded: milliseconds >> 16)
        bytes[4] = UInt8(truncatingIfNeeded: milliseconds >> 8)
        bytes[5] = UInt8(truncatingIfNeeded: milliseconds)
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(
            uuid: (
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
                bytes[8], bytes[9], bytes[10], bytes[11],
                bytes[12], bytes[13], bytes[14], bytes[15]
            )
        ).uuidString.lowercased()
    }
}
