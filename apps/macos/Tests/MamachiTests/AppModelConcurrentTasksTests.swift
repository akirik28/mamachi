import XCTest
@testable import Mamachi

final class AppModelConcurrentTasksTests: XCTestCase {
    @MainActor
    func testActiveTaskDefaultsToThePrimaryDaemonReportedTask() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
            TaskViewState(id: "b", state: "running", revision: 1, objective: "B", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"

        XCTAssertEqual(model.activeTaskId, "a")
        XCTAssertEqual(model.activeTask?.id, "a")
    }

    @MainActor
    func testFocusTaskOverridesThePrimaryTaskWhileStillActive() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
            TaskViewState(id: "b", state: "running", revision: 1, objective: "B", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"

        model.focusTask("b")

        XCTAssertEqual(model.activeTaskId, "b")
        XCTAssertEqual(model.activeTask?.id, "b")
    }

    @MainActor
    func testFocusFallsBackToPrimaryOnceTheFocusedTaskIsNoLongerActive() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"
        model.focusTask("b")
        XCTAssertEqual(model.activeTaskId, "b")

        // "b" finishes: the daemon's next snapshot no longer reports it as active.
        model.activeTaskIds = ["a"]

        XCTAssertEqual(model.activeTaskId, "a", "focus must not point at a task that's no longer active")
    }
}
