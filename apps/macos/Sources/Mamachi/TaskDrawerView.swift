import SwiftUI

/// Operational task surface for the expanded overlay: current objective,
/// grounded progress, queue, captured context, and disclosed facts
/// (blockers, changed files, evidence, run history). View-only — every
/// mutation flows through an injected closure.
struct TaskDrawerView: View {
    let workspace: String
    let activeTask: TaskViewState?
    let tasks: [TaskViewState]
    let queue: [String]
    let activeTaskIds: [String]
    let pendingContexts: [CapturedContextViewState]
    let attentionMessage: String?
    let hasPendingApproval: Bool
    let onControlTask: (String) -> Void
    var onFocusTask: ((String) -> Void)?
    var onReorderQueue: ((_ taskId: String, _ offset: Int) -> Void)?
    var onRemoveQueued: ((_ taskId: String) -> Void)?
    var onRemoveContext: ((CapturedContextViewState) -> Void)?

    /// The task whose facts are shown: the active one, else the most recent.
    private var focusTask: TaskViewState? { activeTask ?? tasks.last }

    private var historyTasks: [TaskViewState] {
        tasks.filter { $0.isTerminal && $0.id != activeTask?.id }.reversed()
    }

    /// Tasks the daemon reports as active but which aren't the one currently
    /// focused — invisible before multi-agent, since activeTaskIds could
    /// only ever contain the one task rendered by activeTaskCard.
    private var otherRunningTasks: [TaskViewState] {
        tasks.filter { activeTaskIds.contains($0.id) && $0.id != activeTask?.id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let task = activeTask {
                    activeTaskCard(task)
                } else {
                    idleCard
                }
                if !pendingContexts.isEmpty {
                    contextSection
                }
                if !queue.isEmpty {
                    queueSection
                }
                if !otherRunningTasks.isEmpty {
                    otherRunningSection
                }
                if let task = focusTask {
                    factSections(task)
                }
                if !historyTasks.isEmpty {
                    historySection
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 4)
        }
        .frame(maxHeight: .infinity)
        .accessibilityLabel("Task drawer")
    }

    // MARK: - Current objective

    private func activeTaskCard(_ task: TaskViewState) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: task.state == "awaiting_user" ? "questionmark.bubble.fill" : "scope")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.brand)
                SectionLabel("Current objective")
                if !task.repositoryLabel.isEmpty {
                    Text(task.repositoryLabel)
                        .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(task.repositoryId)
                }
                Spacer()
                if let createdAt = task.createdAt, !task.isTerminal {
                    Text(createdAt, style: .relative)
                        .font(.system(size: 8.5, design: .rounded))
                        .foregroundStyle(.tertiary)
                        .help("Time since the task was created")
                }
                Text("REV \(task.revision)")
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(.tertiary)
                    .help("Specification revision \(task.revision)")
                    .accessibilityLabel("Specification revision \(task.revision)")
                StatusChip(state: task.state)
            }

            Text(task.objective)
                .font(.system(size: 12.5, weight: .medium))
                .lineSpacing(2)
                .lineLimit(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if let progress = progressLine(task) {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "point.bottomleft.forward.to.point.topright.scurvepath")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 1.5)
                    VStack(alignment: .leading, spacing: 1.5) {
                        if let phase = task.phase {
                            Text(phase.capitalized)
                                .font(.system(size: 9, weight: .semibold, design: .rounded))
                                .tracking(0.4)
                                .foregroundStyle(Theme.accentA)
                        }
                        Text(progress)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .contentTransition(.interpolate)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "Current step: \(progress)" + (task.phase.map { ", phase \($0)" } ?? "")
                )
            }

            if task.state == "awaiting_user", let question = task.pendingQuestion ?? attentionMessage {
                questionCallout(question)
            }

            if !task.blockers.isEmpty {
                blockerStrip(task.blockers)
            }

            controlRow(task)
        }
        .padding(12)
        .glassCard()
    }

    private func progressLine(_ task: TaskViewState) -> String? {
        if let step = task.currentStep, !step.isEmpty { return step }
        if let activity = task.recentActivity, !activity.isEmpty { return activity }
        return nil
    }

    private func questionCallout(_ question: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "person.wave.2.fill")
                .font(.system(size: 10))
                .foregroundStyle(.orange)
                .padding(.top, 1)
            Text(question)
                .font(.system(size: 11))
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(.orange.opacity(0.22), lineWidth: 1)
        }
        .accessibilityLabel("Coder question: \(question)")
    }

    private func blockerStrip(_ blockers: [BlockerViewState]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(blockers.prefix(2)) { blocker in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: blocker.kind == "conflict"
                        ? "arrow.triangle.2.circlepath.circle.fill"
                        : "exclamationmark.octagon.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(.orange)
                        .padding(.top, 1)
                    Text(blocker.summary)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .accessibilityLabel(
                    "\(blocker.kind == "conflict" ? "Conflict" : "Blocker"): \(blocker.summary)"
                )
            }
            if blockers.count > 2 {
                Text("\(blockers.count - 2) more below")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func controlRow(_ task: TaskViewState) -> some View {
        HStack(spacing: 8) {
            if task.state == "running" || task.state == "pause_requested" {
                PillButton(title: "Pause", systemImage: "pause.fill") { onControlTask("pause") }
            } else if (task.state == "paused" || task.state == "awaiting_user") && !hasPendingApproval {
                PillButton(title: "Resume", systemImage: "play.fill") { onControlTask("resume") }
            }
            if !task.isTerminal {
                PillButton(title: "Cancel", systemImage: "xmark") { onControlTask("cancel") }
            }
            Spacer()
        }
    }

    // MARK: - Idle

    private var idleCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                SectionLabel("No active task")
                Spacer()
            }
            if let last = tasks.last {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: last.state == "completed" ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(Theme.statusColor(last.state))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Last: \(last.state.replacingOccurrences(of: "_", with: " "))")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text(last.terminalSummary ?? last.objective)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }
            } else {
                Text("Ask Mamachi to start coding — by voice, or from the Chat tab — and the work will be tracked here.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .glassCard()
    }

    // MARK: - Captured context

    private var contextSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "paperclip")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                SectionLabel("Captured context")
                Spacer()
                Text("attached to the next task")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tertiary)
            }
            FlowingChips(contexts: pendingContexts, onRemove: onRemoveContext)
        }
        .padding(12)
        .glassCard()
    }

    // MARK: - Queue

    private var queueSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "list.number")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                SectionLabel("Up next")
                Spacer()
            }
            ForEach(Array(queue.enumerated()), id: \.element) { index, taskId in
                QueueRow(
                    position: index + 1,
                    total: queue.count,
                    objective: objective(for: taskId),
                    onMoveUp: onReorderQueue.map { reorder in { reorder(taskId, -1) } },
                    onMoveDown: onReorderQueue.map { reorder in { reorder(taskId, 1) } },
                    onRemove: onRemoveQueued.map { remove in { remove(taskId) } }
                )
                if index < queue.count - 1 {
                    Divider().opacity(0.4)
                }
            }
        }
        .padding(12)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task queue, \(queue.count) waiting")
    }

    private func objective(for taskId: String) -> String {
        tasks.first(where: { $0.id == taskId })?.objective ?? "Task \(taskId.prefix(8))"
    }

    // MARK: - Other running tasks

    private var otherRunningSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                SectionLabel("Also running")
                Spacer()
            }
            ForEach(otherRunningTasks) { task in
                Button {
                    onFocusTask?(task.id)
                } label: {
                    HStack(alignment: .top, spacing: 7) {
                        Circle()
                            .fill(Theme.statusColor(task.state))
                            .frame(width: 6, height: 6)
                            .padding(.top, 4)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.objective)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(task.repositoryLabel.isEmpty ? task.stateLabel : "\(task.stateLabel) · \(task.repositoryLabel)")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .help(task.repositoryId)
                if task.id != otherRunningTasks.last?.id {
                    Divider().opacity(0.4)
                }
            }
        }
        .padding(12)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Other running tasks, \(otherRunningTasks.count)")
    }

    // MARK: - Fact sections

    @ViewBuilder
    private func factSections(_ task: TaskViewState) -> some View {
        if !task.blockers.isEmpty {
            DrawerDisclosure(
                "Blockers & conflicts",
                systemImage: "exclamationmark.octagon",
                count: task.blockers.count,
                tint: .orange,
                initiallyExpanded: true
            ) {
                ForEach(task.blockers) { blocker in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: blocker.kind == "conflict"
                            ? "arrow.triangle.2.circlepath.circle.fill"
                            : "exclamationmark.octagon.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.orange)
                            .padding(.top, 1)
                        Text(blocker.summary)
                            .font(.system(size: 10.5))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }

        DrawerDisclosure(
            "Changed files",
            systemImage: "doc.badge.gearshape",
            count: task.changedFiles.count
        ) {
            if task.changedFiles.isEmpty {
                DrawerEmptyHint("Edits will appear here as the coder works. Click a file to open it in VS Code.")
            } else {
                ForEach(task.changedFiles) { file in
                    ChangedFileRow(file: file, workspace: workspace)
                }
            }
        }

        DrawerDisclosure(
            "Verification",
            systemImage: "checkmark.seal",
            count: task.evidence.count,
            tint: task.evidence.contains(where: { $0.passed == false }) ? .red : .secondary,
            initiallyExpanded: task.evidence.contains(where: { $0.passed == false })
        ) {
            if task.evidence.isEmpty {
                DrawerEmptyHint("Tests, builds, and checks the coder runs will be listed here as evidence.")
            } else {
                ForEach(task.evidence) { item in
                    EvidenceRow(evidence: item, workspace: workspace)
                }
            }
        }

        DrawerDisclosure(
            "Runs & recovery",
            systemImage: "flag.checkered",
            count: task.runBoundaries.count
        ) {
            if task.runBoundaries.isEmpty {
                DrawerEmptyHint("Each run of this task — and any recovery after an interruption — is recorded here.")
            } else {
                ForEach(task.runBoundaries) { boundary in
                    RunBoundaryRow(boundary: boundary)
                }
            }
        }

        if task.specHistory.count > 1 {
            DrawerDisclosure(
                "Revisions",
                systemImage: "clock.arrow.circlepath",
                count: task.specHistory.count
            ) {
                ForEach(task.specHistory.reversed()) { revision in
                    HStack(alignment: .top, spacing: 6) {
                        Text("r\(revision.revision)")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(
                                revision.revision == task.revision
                                    ? AnyShapeStyle(Theme.accentA)
                                    : AnyShapeStyle(.tertiary)
                            )
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 1.5) {
                            Text(revision.objective)
                                .font(.system(size: 10.5))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if let revisedAt = revision.revisedAt {
                                Text(revisedAt, format: .relative(presentation: .named))
                                    .font(.system(size: 8.5))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }

        if let observerSummary = task.observerSummary {
            DrawerDisclosure(
                "Observer notes",
                systemImage: "eye",
                count: task.observerRisks.count,
                tint: task.observerRisks.isEmpty ? .secondary : .orange
            ) {
                Text(observerSummary)
                    .font(.system(size: 10.5))
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(task.observerRisks, id: \.self) { risk in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 9))
                            .foregroundStyle(.orange)
                            .padding(.top, 1)
                        Text(risk)
                            .font(.system(size: 10))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let nextStep = task.observerNextStep {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .padding(.top, 1)
                        Text(nextStep)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    // MARK: - History

    private var historySection: some View {
        DrawerDisclosure(
            "Task history",
            systemImage: "clock.arrow.circlepath",
            count: historyTasks.count
        ) {
            ForEach(historyTasks) { task in
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: task.state == "completed" ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.statusColor(task.state))
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 1.5) {
                        Text(task.objective)
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                        if let summary = task.terminalSummary, !summary.isEmpty {
                            Text(summary)
                                .font(.system(size: 9.5))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(task.state.capitalized) task: \(task.objective)")
            }
        }
    }
}

/// Wrapping layout for context chips so several attachments stay scannable.
private struct FlowingChips: View {
    let contexts: [CapturedContextViewState]
    var onRemove: ((CapturedContextViewState) -> Void)?

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(contexts) { context in
                ContextChip(context: context, onRemove: onRemove)
            }
        }
    }
}

/// Minimal leading-aligned wrap layout for chips.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arrangement = arrange(proposal: proposal, subviews: subviews)
        let chipProposal = chipProposal(for: proposal)
        for (subview, position) in zip(subviews, arrangement.positions) {
            subview.place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: chipProposal
            )
        }
    }

    /// Chips are measured against the container width so oversized summaries
    /// truncate instead of overflowing the drawer.
    private func chipProposal(for proposal: ProposedViewSize) -> ProposedViewSize {
        guard let width = proposal.width, width.isFinite else { return .unspecified }
        return ProposedViewSize(width: width, height: nil)
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        let chipProposal = chipProposal(for: proposal)
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(chipProposal)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            totalWidth = max(totalWidth, x - spacing)
        }
        return (CGSize(width: totalWidth, height: y + rowHeight), positions)
    }
}
