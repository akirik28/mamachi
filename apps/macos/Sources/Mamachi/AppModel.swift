import AppKit
import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var workspace: String
    @Published var daemonConnected = false
    @Published var voiceState: VoiceConnectionState = .disconnected
    @Published var isEngaged = false
    @Published var microphoneLevel = 0.0
    @Published var primaryActiveTaskId: String?
    @Published var activeTaskIds: [String] = []
    @Published var focusedTaskId: String?
    @Published var queue: [String] = []
    @Published var tasks: [TaskViewState] = []
    @Published var confirmations: [ConfirmationViewState] = []
    @Published var pendingContexts: [CapturedContextViewState] = []
    @Published var transcripts: [TranscriptEntry] = []
    @Published var liveUserTranscript = ""
    @Published var liveAssistantTranscript = ""
    @Published var errorMessage: String?
    @Published var hasAPIKey = false
    @Published var needsAPIKey = false
    @Published var hasElevenLabsKey = false
    @Published var needsElevenLabsKey = false
    @Published var drawerExpanded = false
    @Published var collapsedOverlaySize: OverlaySizePreset
    @Published var expandedOverlaySize: OverlaySizePreset
    @Published var interactionMode: InteractionMode
    @Published var voiceEngine: VoiceEngine
    @Published var activationKey: ActivationKey
    @Published var activationMonitorActive = false
    @Published var codingAgentBackend: CodingAgentBackend
    @Published private(set) var codingAgentStatuses: [CodingAgentStatus]
    @Published private(set) var codingAgentSetupInProgress = false
    @Published var primaryCodingModel: String
    @Published var fastCodingModel: String
    @Published var codingThinkingLevel: String
    @Published var automaticModelRouting: Bool
    @Published var computerCapabilities: Set<ComputerCapability>
    @Published var computerConfirmationMode: ComputerConfirmationMode
    @Published var notifyOnAttention: Bool
    @Published var notifyOnCompletion: Bool
    @Published var reactionSoundsEnabled: Bool
    @Published var attentionMessage: String?
    @Published var pendingBrief: PendingBriefViewState?
    @Published var lastTaskCompletionAt: Date?
    @Published private(set) var coderFeed: [String: [CoderFeedEntry]] = [:]
    var onOpenSettings: (() -> Void)?
    var onShowOverlay: (() -> Void)?
    var onResetOverlayFrame: (() -> Void)?
    var onOverlaySizeChange: ((_ collapsed: OverlaySizePreset, _ expanded: OverlaySizePreset) -> Void)?
    var onHideOverlay: (() -> Void)?
    var onQuitApplication: (() -> Void)?
    var onActivationKeyChange: (() -> Void)?

    let inputLevels = AudioLevelHistory()
    let outputLevels = AudioLevelHistory()

    private let daemon = DaemonProcess()
    private let ipc = IpcClient()
    private let audio = AudioService()
    private let keychain = KeychainStore()
    private let transcriptStore: TranscriptStore?
    private let reactions = ReactionService()
    private var started = false
    private var pendingText: String?
    private var resumeEngagementAfterKey = false
    private var playbackItemId: String?
    private var playbackContentIndex: Int?
    private var errorDismissTask: Task<Void, Never>?
    private var codingAgentMonitorTask: Task<Void, Never>?

    /// The task the compact pill, menu bar, and drawer focus on: the user's
    /// explicit tap-to-focus choice if it's still active, else the daemon's
    /// primary (oldest-started) active task.
    var activeTaskId: String? {
        if let focusedTaskId, activeTaskIds.contains(focusedTaskId) {
            return focusedTaskId
        }
        return primaryActiveTaskId
    }

    var activeTask: TaskViewState? {
        guard let activeTaskId else { return nil }
        return tasks.first(where: { $0.id == activeTaskId })
    }

    /// Tap-to-focus: make `taskId` the one shown in the compact pill, the one
    /// `controlActiveTask` acts on, and the one highlighted in the drawer.
    /// Purely client-local — the daemon has no concept of "focus", only of
    /// which tasks are active (`activeTaskIds`).
    ///
    /// This does NOT reach the voice model: an ambiguous voice command (one
    /// that doesn't name a task explicitly) is resolved entirely server-side,
    /// against the daemon's own primary active task, not against whatever is
    /// focused here (`packages/core/src/voice-toolkit.ts`, `#resolveTask`,
    /// which falls back to `snapshot.activeTaskId` — the oldest-started
    /// active task — and never sees `focusedTaskId`). Concretely: if the user
    /// taps to focus a second running task and then says "pause this" with
    /// no task named, the daemon still targets the oldest task, not the one
    /// just focused. In practice this mostly affects `get_task_status`, the
    /// only mutating-or-not voice tool whose `taskId` argument is nullable;
    /// every voice tool that mutates a specific task's state requires an
    /// explicit, non-null `taskId` in its schema.
    func focusTask(_ taskId: String) {
        focusedTaskId = taskId
    }

    var pendingConfirmation: ConfirmationViewState? {
        confirmations.first(where: { $0.taskId == activeTaskId && $0.state == "pending" })
    }

    var pendingConfirmations: [ConfirmationViewState] {
        confirmations.filter { $0.state == "pending" }
    }

    var queuedTasks: [TaskViewState] {
        queue.compactMap { id in tasks.first(where: { $0.id == id }) }
    }

    var recentTasks: [TaskViewState] {
        Array(tasks.filter(\.isTerminal).suffix(6).reversed())
    }

    var selectedCodingAgentStatus: CodingAgentStatus {
        codingAgentStatuses.first(where: { $0.backend == codingAgentBackend })
            ?? .unavailable(codingAgentBackend)
    }
    var menuBarStatusText: String {
        if attentionMessage != nil || pendingConfirmation != nil || activeTask?.state == "awaiting_user" {
            return "Mamachi needs you"
        }
        if isEngaged { return voiceState.label }
        if let activeTask {
            return activeTask.state == "running" ? "Coding" : activeTask.stateLabel
        }
        return daemonConnected ? "Mamachi ready" : "Mamachi starting"
    }

    var menuBarSystemImage: String {
        if attentionMessage != nil || pendingConfirmation != nil || activeTask?.state == "awaiting_user" {
            return "exclamationmark.circle.fill"
        }
        if isEngaged { return "waveform" }
        if activeTask != nil { return "hammer.fill" }
        return daemonConnected ? "minus" : "ellipsis"
    }

    var pillState: VoicePillState {
        if !daemonConnected {
            return .dormant(text: errorMessage == nil ? "Starting…" : "Offline")
        }
        if attentionMessage != nil || pendingConfirmation != nil || activeTask?.state == "awaiting_user" {
            return .attention(text: "Needs you")
        }
        if voiceState == .error { return .attention(text: voiceState.label) }
        if isEngaged {
            switch voiceState {
            case .listening: return .listening
            case .thinking: return .thinking
            case .speaking: return .speaking
            default: break
            }
        }
        if voiceState == .connecting { return .connecting }
        return .dormant(text: dormantPillText)
    }

    private var dormantPillText: String {
        if activeTask != nil { return "Coding" }
        if isEngaged { return voiceState.label }
        if pendingBrief != nil { return "Update ready" }
        let microphoneSleeping = interactionMode == .voice && !isEngaged && voiceState == .connected
        return microphoneSleeping ? "Sleeping" : "Ready"
    }


    init() {
        let defaults = UserDefaults.standard
        collapsedOverlaySize = OverlaySizePreset(
            rawValue: defaults.string(forKey: "collapsedOverlaySizePreset") ?? ""
        ) ?? .medium
        expandedOverlaySize = OverlaySizePreset(
            rawValue: defaults.string(forKey: "expandedOverlaySizePreset") ?? ""
        ) ?? .medium
        defaults.removeObject(forKey: "overlayCompactSize")
        interactionMode = InteractionMode(rawValue: defaults.string(forKey: "interactionMode") ?? "") ?? .voice
        voiceEngine = VoiceEngine(rawValue: defaults.string(forKey: "voiceEngine") ?? "") ?? .realtime
        activationKey = ActivationKey(
            rawValue: defaults.string(forKey: "activationKey") ?? ""
        ) ?? .fn
        codingAgentBackend = CodingAgentBackend(
            rawValue: defaults.string(forKey: "codingAgentBackend") ?? ""
        ) ?? .omp
        codingAgentStatuses = CodingAgentBackend.allCases.map(CodingAgentStatus.unavailable)
        primaryCodingModel = defaults.string(forKey: "primaryCodingModel") ?? ""
        fastCodingModel = defaults.string(forKey: "fastCodingModel") ?? "openai-codex/gpt-5.4-mini"
        codingThinkingLevel = defaults.string(forKey: "codingThinkingLevel") ?? "inherit"
        automaticModelRouting = defaults.object(forKey: "automaticModelRouting") == nil
            ? true
            : defaults.bool(forKey: "automaticModelRouting")
        if let storedCapabilities = defaults.stringArray(forKey: "computerCapabilities") {
            computerCapabilities = Set(storedCapabilities.compactMap(ComputerCapability.init(rawValue:)))
        } else {
            computerCapabilities = ComputerCapability.assistive
        }
        computerConfirmationMode = ComputerConfirmationMode(
            rawValue: defaults.string(forKey: "computerConfirmationMode") ?? ""
        ) ?? .sensitive
        notifyOnAttention = defaults.object(forKey: "notifyOnAttention") == nil
            ? true
            : defaults.bool(forKey: "notifyOnAttention")
        notifyOnCompletion = defaults.object(forKey: "notifyOnCompletion") == nil
            ? true
            : defaults.bool(forKey: "notifyOnCompletion")
        reactionSoundsEnabled = defaults.object(forKey: "reactionSoundsEnabled") == nil
            ? true
            : defaults.bool(forKey: "reactionSoundsEnabled")
        attentionMessage = nil
        transcriptStore = try? TranscriptStore()
        transcripts = (try? transcriptStore?.load()) ?? []
        hasAPIKey = ((try? keychain.loadAPIKey()) ?? nil) != nil
        hasElevenLabsKey = ((try? keychain.loadElevenLabsKey()) ?? nil) != nil
        workspace = UserDefaults.standard.string(forKey: "workspace")
            ?? ProcessInfo.processInfo.environment["MAMACHI_WORKSPACE"]
            ?? (try? DaemonProcess.projectRoot().path)
            ?? FileManager.default.homeDirectoryForCurrentUser.path

        daemon.onRestart = { [weak self] ready in
            guard let self else { return }
            daemonConnected = false
            voiceState = .disconnected
            workspace = ready.workspace
            ipc.connect(port: ready.port, token: ready.token)
        }
        daemon.onTerminalFailure = { [weak self] error in
            guard let self else { return }
            daemonConnected = false
            voiceState = .error
            isEngaged = false
            errorMessage = "Mamachi daemon could not be restarted: \(error.localizedDescription)"
        }
        ipc.onEvent = { [weak self] event in self?.handle(event) }
        ipc.onAudio = { [weak self] data in self?.handleAudioOutput(data) }
        ipc.onDisconnect = { [weak self] error in
            guard let self else { return }
            daemonConnected = false
            voiceState = .disconnected
            if let error { errorMessage = error.localizedDescription }
        }
        audio.onMicrophonePCM = { [weak self] data in
            guard
                let self,
                isEngaged,
                voiceState != .speaking,
                !audio.hasPendingPlayback
            else { return }
            ipc.sendAudio(data)
        }
        audio.onLevel = { [weak self] level in self?.handleMicrophoneLevel(level) }
        audio.onPlaybackLevel = { [weak self] level in self?.outputLevels.append(level) }
        audio.onError = { [weak self] error in self?.errorMessage = "Audio playback failed: \(error.localizedDescription)" }
        audio.onPlaybackDrained = { [weak self] in self?.resumeMicrophoneIfReady() }
        reactions.onOpen = { [weak self] in
            self?.drawerExpanded = true
            self?.onShowOverlay?()
        }
    }

    func start() {
        guard !started else { return }
        started = true
        Task {
            do {
                let ready = try await daemon.start(workspace: workspace, codingBackend: codingAgentBackend)
                workspace = ready.workspace
                ipc.connect(port: ready.port, token: ready.token)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        if notifyOnAttention || notifyOnCompletion { reactions.requestAuthorization() }
    }

    func stop() {
        isEngaged = false
        audio.stop()
        if daemonConnected { ipc.sendRequest(type: "voice.disconnect", payload: [:]) }
        ipc.disconnect()
        daemon.stop()
    }

    func setInteractionMode(_ mode: InteractionMode) {
        interactionMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "interactionMode")
        if mode == .text {
            let playback = currentPlaybackPosition()
            isEngaged = false
            audio.stopCapture()
            audio.clearPlayback()
            ipc.reportVoiceEngagement(false, playback: playback)
            if voiceState == .listening || voiceState == .speaking { voiceState = .connected }
        }
        if daemonConnected {
            ipc.sendRequest(type: "voice.mode", payload: ["mode": mode.rawValue])
        }
    }

    func updateRuntimeSettings(
        primaryModel: String,
        fastModel: String,
        thinkingLevel: String,
        automaticRouting: Bool
    ) {
        primaryCodingModel = primaryModel.trimmingCharacters(in: .whitespacesAndNewlines)
        fastCodingModel = fastModel.trimmingCharacters(in: .whitespacesAndNewlines)
        codingThinkingLevel = thinkingLevel
        automaticModelRouting = automaticRouting
        let defaults = UserDefaults.standard
        defaults.set(primaryCodingModel, forKey: "primaryCodingModel")
        defaults.set(fastCodingModel, forKey: "fastCodingModel")
        defaults.set(codingThinkingLevel, forKey: "codingThinkingLevel")
        defaults.set(automaticModelRouting, forKey: "automaticModelRouting")
        syncRuntimeSettings()
    }

    func selectCodingBackend(_ backend: CodingAgentBackend) {
        codingAgentBackend = backend
        UserDefaults.standard.set(backend.rawValue, forKey: "codingAgentBackend")
        syncRuntimeSettings()
    }

    func refreshCodingAgentStatuses() async {
        codingAgentStatuses = await CodingAgentDiscovery.statuses()
        if selectedCodingAgentStatus.ready {
            codingAgentSetupInProgress = false
            codingAgentMonitorTask?.cancel()
            codingAgentMonitorTask = nil
        }
    }

    func openCodingAgentSetup(_ backend: CodingAgentBackend) {
        do {
            try CodingAgentDiscovery.openSetupTerminal(
                for: backend,
                executablePath: codingAgentStatuses.first(where: { $0.backend == backend })?.executablePath
            )
            codingAgentSetupInProgress = true
            codingAgentMonitorTask?.cancel()
            codingAgentMonitorTask = Task { [weak self] in
                for _ in 0..<90 {
                    guard let self, !Task.isCancelled else { return }
                    try? await Task.sleep(for: .seconds(2))
                    await refreshCodingAgentStatuses()
                    if codingAgentStatuses.first(where: { $0.backend == backend })?.ready == true {
                        return
                    }
                }
                self?.codingAgentSetupInProgress = false
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func saveCodingProviderCredential(_ credential: String, for provider: CodingProvider) -> Bool {
        let value = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        do {
            try keychain.saveCodingCredential(value, for: provider)
            Task { await refreshCodingAgentStatuses() }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateComputerControlSettings(
        capabilities: Set<ComputerCapability>,
        confirmationMode: ComputerConfirmationMode
    ) {
        computerCapabilities = capabilities
        computerConfirmationMode = confirmationMode
        let defaults = UserDefaults.standard
        defaults.set(capabilities.map(\.rawValue).sorted(), forKey: "computerCapabilities")
        defaults.set(confirmationMode.rawValue, forKey: "computerConfirmationMode")
        syncRuntimeSettings()
    }

    func openAccessibilitySettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    func updateReactionSettings(attention: Bool, completion: Bool, sounds: Bool) {
        notifyOnAttention = attention
        notifyOnCompletion = completion
        reactionSoundsEnabled = sounds
        let defaults = UserDefaults.standard
        defaults.set(attention, forKey: "notifyOnAttention")
        defaults.set(completion, forKey: "notifyOnCompletion")
        defaults.set(sounds, forKey: "reactionSoundsEnabled")
        if attention || completion { reactions.requestAuthorization() }
    }

    func setActivationKey(_ key: ActivationKey) {
        activationKey = key
        UserDefaults.standard.set(key.rawValue, forKey: "activationKey")
        onActivationKeyChange?()
    }

    func setVoiceEngine(_ engine: VoiceEngine) {
        let changed = engine != voiceEngine
        voiceEngine = engine
        UserDefaults.standard.set(engine.rawValue, forKey: "voiceEngine")
        syncRuntimeSettings()
        // The daemon swaps bridges on settings.update; drop the live session
        // so the next engagement reconnects on the newly selected engine.
        if changed && voiceState != .disconnected { disconnectVoice() }
    }

    /// Maps recognizer verdicts onto engagement transitions. Wake gestures
    /// also raise the overlay, mirroring the legacy `⌥Space` behavior.
    func handleActivation(_ verdict: ActivationVerdict) {
        switch verdict {
        case .engageHandsFree, .beginPushToTalk:
            onShowOverlay?()
            if !isEngaged { toggleEngagement() }
        case .endPushToTalk:
            if isEngaged { muteMicrophone() }
        case .tapWhileEngaged:
            guard isEngaged else { return }
            if voiceState == .speaking {
                bargeIn()
            } else {
                muteMicrophone()
            }
        }
    }

    func toggleEngagement() {
        if interactionMode == .text { setInteractionMode(.voice) }
        if isEngaged && voiceState == .speaking {
            bargeIn()
            return
        }
        if isEngaged {
            muteMicrophone()
            return
        }
        isEngaged = true
        errorMessage = nil
        if daemonConnected { ipc.reportVoiceEngagement(true, playback: nil) }
        if voiceState == .connected || voiceState == .listening || voiceState == .thinking || voiceState == .speaking {
            startMicrophone()
        } else {
            connectVoice()
        }
    }

    func muteMicrophone() {
        let playback = currentPlaybackPosition()
        isEngaged = false
        audio.stopCapture()
        microphoneLevel = 0
        inputLevels.clear()
        audio.clearPlayback()
        if daemonConnected { ipc.reportVoiceEngagement(false, playback: playback) }
        if voiceState != .disconnected && voiceState != .error {
            voiceState = .connected
        }
    }

    func connectVoice() {
        guard daemonConnected else {
            isEngaged = false
            errorMessage = "Mamachi daemon is not connected."
            return
        }
        do {
            guard let apiKey = try keychain.loadAPIKey(), !apiKey.isEmpty else {
                resumeEngagementAfterKey = isEngaged
                isEngaged = false
                ipc.reportVoiceEngagement(false, playback: nil)
                needsAPIKey = true
                errorMessage = "Add an OpenAI API key to connect."
                openSettings()
                return
            }
            needsAPIKey = false
            var payload: [String: Any] = ["apiKey": apiKey]
            if voiceEngine == .cascade {
                guard let elevenLabsKey = try keychain.loadElevenLabsKey(), !elevenLabsKey.isEmpty else {
                    resumeEngagementAfterKey = isEngaged
                    isEngaged = false
                    ipc.reportVoiceEngagement(false, playback: nil)
                    needsElevenLabsKey = true
                    errorMessage = "Add an ElevenLabs API key to use the cascaded voice."
                    openSettings()
                    return
                }
                needsElevenLabsKey = false
                payload["elevenLabsApiKey"] = elevenLabsKey
            }
            voiceState = .connecting
            ipc.reportVoiceEngagement(isEngaged, playback: nil)
            ipc.sendRequest(type: "voice.connect", payload: payload)
        } catch {
            isEngaged = false
            ipc.reportVoiceEngagement(false, playback: nil)
            errorMessage = error.localizedDescription
        }
    }

    func disconnectVoice() {
        let playback = currentPlaybackPosition()
        isEngaged = false
        audio.stopCapture()
        audio.clearPlayback()
        ipc.reportVoiceEngagement(false, playback: playback)
        ipc.sendRequest(type: "voice.disconnect", payload: [:])
        voiceState = .disconnected
    }

    func sendText(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        appendTranscript(speaker: .user, text: text)
        if voiceState == .connected || voiceState == .listening || voiceState == .thinking || voiceState == .speaking {
            ipc.sendRequest(type: "voice.text", payload: ["text": text])
        } else {
            pendingText = text
            connectVoice()
        }
    }

    func saveAPIKey(_ rawKey: String) {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if key.isEmpty {
                try keychain.deleteAPIKey()
                hasAPIKey = false
                disconnectVoice()
            } else {
                try keychain.saveAPIKey(key)
                hasAPIKey = true
                needsAPIKey = false
                let shouldEngage = resumeEngagementAfterKey
                resumeEngagementAfterKey = false
                if shouldEngage { isEngaged = true }
                if shouldEngage || pendingText != nil { connectVoice() }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveElevenLabsKey(_ rawKey: String) {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            removeElevenLabsKey()
            return
        }
        do {
            try keychain.saveElevenLabsKey(key)
            hasElevenLabsKey = true
            needsElevenLabsKey = false
            let shouldEngage = resumeEngagementAfterKey
            resumeEngagementAfterKey = false
            if shouldEngage { isEngaged = true }
            if shouldEngage || pendingText != nil { connectVoice() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeElevenLabsKey() {
        do {
            try keychain.deleteElevenLabsKey()
            hasElevenLabsKey = false
            if voiceEngine == .cascade { disconnectVoice() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.title = "Select a coding workspace"
        panel.prompt = "Use Workspace"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(filePath: workspace, directoryHint: .isDirectory)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        workspace = url.path
        UserDefaults.standard.set(workspace, forKey: "workspace")
        ipc.sendRequest(type: "workspace.select", payload: ["path": workspace])
    }

    func controlActiveTask(_ action: String) {
        guard let task = activeTask else { return }
        switch action {
        case "pause":
            sendCommand(
                type: "task.requestPause",
                expectedRevision: task.revision,
                payload: ["taskId": task.id, "reason": "Paused from the Mamachi task drawer"]
            )
        case "resume":
            sendCommand(type: "task.resume", expectedRevision: task.revision, payload: ["taskId": task.id])
        case "cancel":
            sendCommand(
                type: "task.cancel",
                expectedRevision: task.revision,
                payload: ["taskId": task.id, "reason": "Cancelled from the Mamachi task drawer"]
            )
        default:
            return
        }
    }

    func resolveConfirmation(_ confirmation: ConfirmationViewState, decision: String) {
        guard decision == "approve" || decision == "reject" else { return }
        sendCommand(
            type: "approval.resolve",
            expectedRevision: confirmation.taskRevision,
            payload: ["confirmationId": confirmation.id, "decision": decision]
        )
    }

    func moveQueuedTask(_ taskId: String, up: Bool) {
        guard let index = queue.firstIndex(of: taskId) else { return }
        let target = up ? index - 1 : index + 1
        guard queue.indices.contains(target) else { return }
        sendCommand(
            type: "queue.move",
            expectedRevision: nil,
            payload: [
                "taskId": taskId,
                "operation": up ? "move_before" : "move_after",
                "anchorTaskId": queue[target],
            ]
        )
    }

    func cancelQueuedTask(_ task: TaskViewState) {
        sendCommand(
            type: "task.cancel",
            expectedRevision: task.revision,
            payload: ["taskId": task.id, "reason": "Removed from the queue in the Mamachi drawer"]
        )
    }

    func removeContext(_ id: String) {
        pendingContexts.removeAll(where: { $0.id == id })
        ipc.sendRequest(type: "context.remove", payload: ["id": id])
    }

    func resetOverlayFrame() {
        onResetOverlayFrame?()
    }

    func hideOverlay() {
        onHideOverlay?()
    }

    func quitApplication() {
        onQuitApplication?()
    }

    func setCollapsedOverlaySize(_ size: OverlaySizePreset) {
        guard size != collapsedOverlaySize else { return }
        collapsedOverlaySize = size
        UserDefaults.standard.set(size.rawValue, forKey: "collapsedOverlaySizePreset")
        onOverlaySizeChange?(collapsedOverlaySize, expandedOverlaySize)
    }

    func setExpandedOverlaySize(_ size: OverlaySizePreset) {
        guard size != expandedOverlaySize else { return }
        expandedOverlaySize = size
        UserDefaults.standard.set(size.rawValue, forKey: "expandedOverlaySizePreset")
        onOverlaySizeChange?(collapsedOverlaySize, expandedOverlaySize)
    }

    private func sendCommand(type: String, expectedRevision: Int?, payload: [String: Any]) {
        ipc.sendRequest(
            type: "command.execute",
            payload: [
                "command": [
                    "id": ProtocolID.makeV7(),
                    "type": type,
                    "actor": "ui",
                    "expectedRevision": expectedRevision.map { $0 as Any } ?? NSNull(),
                    "payload": payload,
                ],
            ]
        )
    }

    func clearTranscripts() {
        do {
            try transcriptStore?.clear()
            transcripts = []
            liveUserTranscript = ""
            liveAssistantTranscript = ""
        } catch {
            presentError(error.localizedDescription)
        }
    }

    func presentError(_ message: String, sticky: Bool = false) {
        errorMessage = message
        errorDismissTask?.cancel()
        errorDismissTask = nil
        guard !sticky else { return }
        errorDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(7))
            guard !Task.isCancelled else { return }
            self?.errorMessage = nil
        }
    }

    func dismissError() {
        errorDismissTask?.cancel()
        errorDismissTask = nil
        errorMessage = nil
    }
    func openSettings() {
        onOpenSettings?()
    }


    private func handleAudioOutput(_ data: Data) {
        guard isEngaged, playbackItemId != nil, playbackContentIndex != nil else { return }
        audio.play(pcm: data)
    }

    private func handleMicrophoneLevel(_ level: Double) {
        microphoneLevel = level
        inputLevels.append(level)
    }


    private func currentPlaybackPosition() -> VoicePlaybackPosition? {
        guard
            voiceState == .speaking,
            let playbackItemId,
            let playbackContentIndex,
            audio.hasPendingPlayback || audio.isPlaying
        else { return nil }
        return VoicePlaybackPosition(
            itemId: playbackItemId,
            contentIndex: playbackContentIndex,
            audioEndMs: audio.playbackPositionMilliseconds
        )
    }

    private func resumeMicrophoneIfReady() {
        guard isEngaged, voiceState == .connected, !audio.hasPendingPlayback else { return }
        startMicrophone()
    }

    private func bargeIn() {
        let playback = currentPlaybackPosition()
        audio.clearPlayback()
        ipc.interruptVoice(playback: playback)
        voiceState = .listening
        startMicrophone()
    }

    private func startMicrophone() {
        Task {
            do {
                try await audio.startCapture()
                if isEngaged { voiceState = .listening }
            } catch {
                isEngaged = false
                ipc.reportVoiceEngagement(false, playback: nil)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func handle(_ envelope: [String: Any]) {
        guard let type = envelope["type"] as? String else { return }
        let payload = envelope["payload"] as? [String: Any] ?? [:]
        switch type {
        case "server.ready":
            daemonConnected = true
            errorMessage = nil
            syncRuntimeSettings()
            ipc.reportVoiceEngagement(isEngaged, playback: nil)
            applySnapshot(payload["snapshot"] as? [String: Any])
            applyFacts(payload["facts"] as? [String: Any])
        case "response":
            if payload["ok"] as? Bool == false {
                errorMessage = payload["error"] as? String ?? "Mamachi request failed."
                if voiceState == .connecting {
                    voiceState = .error
                    isEngaged = false
                    ipc.reportVoiceEngagement(false, playback: nil)
                }
            }
        case "domain.event":
            handleDomainEvent(payload)
        case "state.snapshot":
            applySnapshot(payload["snapshot"] as? [String: Any])
            applyFacts(payload["facts"] as? [String: Any])
        case "workspace.changed":
            if let path = payload["path"] as? String { workspace = path }
        case "context.captured":
            if
                let id = payload["id"] as? String,
                let kind = payload["kind"] as? String,
                let summary = payload["summary"] as? String,
                !pendingContexts.contains(where: { $0.id == id })
            {
                pendingContexts.append(CapturedContextViewState(id: id, kind: kind, summary: summary))
            }
        case "context.consumed", "context.removed":
            if let ids = payload["ids"] as? [String] {
                pendingContexts.removeAll(where: { ids.contains($0.id) })
            }
        case "brief.queued":
            pendingBrief = PendingBriefViewState(
                count: payload["pending"] as? Int ?? ((pendingBrief?.count ?? 0) + 1),
                latestSummary: payload["summary"] as? String ?? ""
            )
        case "brief.delivered":
            pendingBrief = nil
        case "voice.audio":
            if
                let itemId = payload["itemId"] as? String,
                let contentIndex = payload["contentIndex"] as? Int
            {
                if playbackItemId != itemId || playbackContentIndex != contentIndex {
                    audio.beginPlaybackItem()
                }
                playbackItemId = itemId
                playbackContentIndex = contentIndex
            }
        case "voice.state":
            applyVoiceState(payload["state"] as? String)
        case "voice.mode":
            if let mode = payload["mode"] as? String, let interactionMode = InteractionMode(rawValue: mode) {
                self.interactionMode = interactionMode
            }
        case "ui.overlay":
            if let expanded = payload["expanded"] as? Bool {
                drawerExpanded = expanded
                if expanded { onShowOverlay?() }
            }
        case "computer.confirmation_required":
            attentionMessage = payload["summary"] as? String ?? "A computer action needs confirmation."
        case "computer.confirmation_resolved",
             "computer.confirmation_cleared",
             "computer.confirmation_expired":
            attentionMessage = nil
        case "ui.mute":
            muteMicrophone()
        case "voice.interrupt":
            audio.clearPlayback()
        case "voice.error":
            voiceState = .error
            presentError(payload["error"] as? String ?? "OpenAI Realtime returned an error.")
        case "voice.transcript.user_delta":
            if let text = payload["text"] as? String { liveUserTranscript += text }
        case "voice.transcript.user":
            if let text = payload["text"] as? String {
                liveUserTranscript = ""
                appendTranscript(speaker: .user, text: text)
            }
        case "voice.transcript.assistant_delta":
            if let text = payload["text"] as? String { liveAssistantTranscript += text }
        case "voice.transcript.user_pending":
            if let text = payload["text"] as? String { liveUserTranscript = text }
        case "voice.transcript.user_discarded":
            liveUserTranscript = ""
        case "voice.transcript.assistant":
            if let text = payload["text"] as? String {
                liveAssistantTranscript = ""
                appendTranscript(speaker: .mamachi, text: text)
            }
        case "coder.initializing", "coder.routed", "coder.ready", "coder.running", "coder.tool_started", "coder.tool_finished", "coder.message", "coder.needs_attention":
            applyCoderActivity(type: type, payload: payload)
        default:
            break
        }
    }

    private func syncRuntimeSettings() {
        guard daemonConnected else { return }
        ipc.sendRequest(
            type: "settings.update",
            payload: [
                "codingBackend": codingAgentBackend.rawValue,
                "primaryModel": primaryCodingModel,
                "fastModel": fastCodingModel,
                "thinkingLevel": codingThinkingLevel,
                "automaticRouting": automaticModelRouting,
                "computerCapabilities": computerCapabilities.map(\.rawValue).sorted(),
                "computerConfirmationMode": computerConfirmationMode.rawValue,
                "voiceEngine": voiceEngine.rawValue,
                "cascadeReasoningEffort": "none",
                "cascadeVoiceId": "",
            ]
        )
        ipc.sendRequest(type: "voice.mode", payload: ["mode": interactionMode.rawValue])
    }

    private func handleDomainEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        let taskId = event["taskId"] as? String
        let detail = event["payload"] as? [String: Any] ?? [:]
        let objective = taskId.flatMap { id in tasks.first(where: { $0.id == id })?.objective } ?? "Coding task"
        switch type {
        case "task.awaitingUser", "task.questionAsked":
            guard let question = detail["question"] as? String else { return }
            attentionMessage = question
            reactions.notify(
                id: "attention-\(taskId ?? ProtocolID.makeV7())",
                title: "Coder needs your input",
                body: question,
                notificationsEnabled: notifyOnAttention,
                soundEnabled: reactionSoundsEnabled
            )
        case "task.completed":
            attentionMessage = nil
            lastTaskCompletionAt = Date()
            let summary = detail["summary"] as? String ?? objective
            reactions.notify(
                id: "completed-\(taskId ?? ProtocolID.makeV7())",
                title: "Coding task finished",
                body: String(summary.prefix(220)),
                notificationsEnabled: notifyOnCompletion,
                soundEnabled: reactionSoundsEnabled
            )
        case "task.failed":
            attentionMessage = nil
            let error = detail["error"] as? String ?? objective
            reactions.notify(
                id: "failed-\(taskId ?? ProtocolID.makeV7())",
                title: "Coding task failed",
                body: String(error.prefix(220)),
                notificationsEnabled: notifyOnCompletion,
                soundEnabled: reactionSoundsEnabled
            )
        case "task.resumed", "task.cancelled":
            attentionMessage = nil
        case "approval.requested":
            let summary = detail["summary"] as? String ?? "A consequential action needs your approval"
            reactions.notify(
                id: "approval-\(taskId ?? ProtocolID.makeV7())",
                title: "Approval needed",
                body: String(summary.prefix(220)),
                notificationsEnabled: notifyOnAttention,
                soundEnabled: reactionSoundsEnabled
            )
        default:
            break
        }
    }

    private func applyVoiceState(_ state: String?) {
        switch state {
        case "connecting": voiceState = .connecting
        case "connected", "idle":
            voiceState = .connected
            if let pendingText {
                self.pendingText = nil
                ipc.sendRequest(type: "voice.text", payload: ["text": pendingText])
            }
            resumeMicrophoneIfReady()
        case "listening": voiceState = .listening
        case "thinking": voiceState = .thinking
        case "speaking": voiceState = .speaking
        case "disconnected":
            voiceState = .disconnected
        default: break
        }
    }

    private func applySnapshot(_ rawSnapshot: [String: Any]?) {
        guard let rawSnapshot else { return }
        primaryActiveTaskId = rawSnapshot["activeTaskId"] as? String
        activeTaskIds = rawSnapshot["activeTaskIds"] as? [String] ?? []
        if let focusedTaskId, !activeTaskIds.contains(focusedTaskId) {
            self.focusedTaskId = nil
        }
        queue = rawSnapshot["queue"] as? [String] ?? []
        guard let rawTasks = rawSnapshot["tasks"] as? [[String: Any]] else { return }
        let previousByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        let rawRuns = rawSnapshot["runs"] as? [[String: Any]] ?? []
        tasks = rawTasks.compactMap { rawTask in
            guard
                let id = rawTask["id"] as? String,
                let state = rawTask["state"] as? String,
                let revision = rawTask["revision"] as? Int,
                let spec = rawTask["spec"] as? [String: Any],
                let objective = spec["objective"] as? String
            else { return nil }
            let previous = previousByID[id]
            var task = TaskViewState(
                id: id,
                state: state,
                revision: revision,
                objective: objective,
                terminalSummary: rawTask["terminalSummary"] as? String,
                recentActivity: previous?.recentActivity
            )
            task.pendingQuestion = rawTask["pendingQuestion"] as? String
            task.createdAt = Self.parseDate(rawTask["createdAt"])
            task.specHistory = (rawTask["specHistory"] as? [[String: Any]] ?? []).compactMap { entry in
                guard
                    let revision = entry["revision"] as? Int,
                    let objective = entry["objective"] as? String
                else { return nil }
                return SpecRevisionViewState(
                    revision: revision,
                    objective: objective,
                    revisedAt: Self.parseDate(entry["revisedAt"])
                )
            }
            if
                let conflict = rawTask["workspaceConflict"] as? [String: Any],
                let reason = conflict["reason"] as? String
            {
                let paths = conflict["paths"] as? [String] ?? []
                task.blockers = [
                    BlockerViewState(
                        id: "conflict-\(id)",
                        summary: paths.isEmpty ? reason : "\(reason): \(paths.joined(separator: ", "))",
                        kind: "conflict"
                    ),
                ]
            }
            task.runBoundaries = rawRuns
                .filter { $0["taskId"] as? String == id }
                .enumerated()
                .compactMap { index, run in
                    guard
                        let runId = run["id"] as? String,
                        let runState = run["state"] as? String
                    else { return nil }
                    return RunBoundaryViewState(
                        id: runId,
                        label: "Run \(index + 1) · \(runState.replacingOccurrences(of: "_", with: " ").capitalized)",
                        kind: runState == "interrupted" ? "recovery" : "run",
                        at: Self.parseDate(run["startedAt"])
                    )
                }
            // Grounded facts arrive in a sibling `facts` payload; carry the last
            // projection so the card never blanks between snapshots.
            task.phase = previous?.phase
            task.currentStep = previous?.currentStep
            task.progress = previous?.progress
            task.verificationState = previous?.verificationState
            task.changedFiles = previous?.changedFiles ?? []
            task.evidence = previous?.evidence ?? []
            task.observerSummary = previous?.observerSummary
            task.observerRisks = previous?.observerRisks ?? []
            task.observerNextStep = previous?.observerNextStep
            return task
        }
        let rawConfirmations = rawSnapshot["confirmations"] as? [[String: Any]] ?? []
        confirmations = rawConfirmations.compactMap { rawConfirmation in
            guard
                let id = rawConfirmation["id"] as? String,
                let taskId = rawConfirmation["taskId"] as? String,
                let taskRevision = rawConfirmation["taskRevision"] as? Int,
                let category = rawConfirmation["category"] as? String,
                let summary = rawConfirmation["summary"] as? String,
                let toolName = rawConfirmation["toolName"] as? String,
                let state = rawConfirmation["state"] as? String
            else { return nil }
            return ConfirmationViewState(
                id: id,
                taskId: taskId,
                taskRevision: taskRevision,
                category: category,
                summary: summary,
                toolName: toolName,
                state: state
            )
        }
        if
            let activeTaskId,
            let question = tasks.first(where: { $0.id == activeTaskId })?.pendingQuestion
        {
            attentionMessage = question
        }
    }

    /// Applies the daemon's evidence-grounded fact projection onto task rows.
    private func applyFacts(_ rawFacts: [String: Any]?) {
        guard let rawFacts, let rawTasks = rawFacts["tasks"] as? [[String: Any]] else { return }
        for rawTask in rawTasks {
            guard
                let taskId = rawTask["taskId"] as? String,
                let index = tasks.firstIndex(where: { $0.id == taskId })
            else { continue }
            tasks[index].phase = rawTask["phase"] as? String
            tasks[index].currentStep = rawTask["currentStep"] as? String
            if let progress = rawTask["progress"] as? Double {
                tasks[index].progress = min(100, max(0, progress))
            }
            tasks[index].verificationState = rawTask["verificationState"] as? String
            tasks[index].changedFiles = (rawTask["changedFiles"] as? [String] ?? [])
                .map { ChangedFileViewState(path: $0) }
            let activities = rawTask["recentActivity"] as? [[String: Any]] ?? []
            var evidence: [EvidenceViewState] = activities.compactMap { activity in
                guard
                    activity["kind"] as? String == "verification",
                    let id = activity["artifactId"] as? String,
                    let summary = activity["summary"] as? String
                else { return nil }
                return EvidenceViewState(
                    id: id,
                    summary: summary,
                    kind: "check",
                    passed: activity["successful"] as? Bool
                )
            }
            if evidence.isEmpty {
                let passed = rawTask["verificationState"] as? String == "passed"
                evidence = (rawTask["verificationSummaries"] as? [String] ?? []).enumerated().map { offset, summary in
                    EvidenceViewState(id: "\(taskId)-verification-\(offset)", summary: summary, kind: "check", passed: passed)
                }
            }
            tasks[index].evidence = evidence
            if let observer = rawTask["observerInterpretation"] as? [String: Any] {
                tasks[index].observerSummary = observer["summary"] as? String
                tasks[index].observerRisks = observer["risks"] as? [String] ?? []
                tasks[index].observerNextStep = observer["nextStep"] as? String
            }
        }
    }

    private static let isoDateParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoDateFallbackParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static func parseDate(_ value: Any?) -> Date? {
        guard let string = value as? String else { return nil }
        return isoDateParser.date(from: string) ?? isoDateFallbackParser.date(from: string)
    }

    private func applyCoderActivity(type: String, payload: [String: Any]) {
        guard let taskId = payload["taskId"] as? String, let index = tasks.firstIndex(where: { $0.id == taskId }) else { return }
        let summary: String
        if let question = payload["question"] as? String {
            tasks[index].recentActivity = "Needs input: \(String(question.prefix(450)))"
            return
        }
        if let tier = payload["tier"] as? String {
            let model = payload["model"] as? String ?? "OMP default"
            tasks[index].recentActivity = "\(tier.capitalized) route · \(model)"
            return
        }
        if let toolName = payload["toolName"] as? String {
            summary = type == "coder.tool_started" ? "Running \(toolName)" : "Finished \(toolName)"
        } else if let text = payload["text"] as? String {
            summary = text
        } else if let model = payload["model"] as? String {
            summary = "Coding with \(model)"
        } else {
            summary = type.replacingOccurrences(of: "coder.", with: "").replacingOccurrences(of: "_", with: " ").capitalized
        }
        tasks[index].recentActivity = String(summary.prefix(500))
        appendCoderFeed(taskId: taskId, text: summary)
    }

    private func appendCoderFeed(taskId: String, text: String) {
        let line = String(text.prefix(200))
        var feed = coderFeed[taskId] ?? []
        if feed.last?.text == line { return }
        feed.append(CoderFeedEntry(text: line, at: Date()))
        if feed.count > 14 { feed.removeFirst(feed.count - 14) }
        coderFeed[taskId] = feed
    }

    private func appendTranscript(speaker: TranscriptEntry.Speaker, text: String) {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        if let last = transcripts.last, last.speaker == speaker, last.text == normalized { return }
        transcripts.append(TranscriptEntry(id: UUID(), speaker: speaker, text: normalized, at: Date()))
        do {
            if let retained = try transcriptStore?.save(transcripts) { transcripts = retained }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
