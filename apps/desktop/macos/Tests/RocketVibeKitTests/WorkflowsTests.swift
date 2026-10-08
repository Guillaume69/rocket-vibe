import Foundation
import RocketVibeCore
import XCTest

@testable import RocketVibeKit

/// The workflow editor's pure edits (RFC 0004), over rv-core's helpers: no
/// server needed.
final class WorkflowsTests: XCTestCase {
    private func editor(_ trigger: NativeWorkflowTrigger = .command(name: "standup")) -> WorkflowDraftEditor {
        var editor = WorkflowDraftEditor.blank(botId: "bot-1")
        editor.name = " Standup "
        editor.trigger = WorkflowTriggerForm(trigger)
        return editor
    }

    func testANewWorkflowIsACommandWithoutSteps() {
        let blank = WorkflowDraftEditor.blank(botId: "bot-1")
        XCTAssertEqual(blank.draft, NativeWorkflowDraft(name: "", description: "", botId: "bot-1", enabled: true,
                                                         trigger: .command(name: ""), steps: []))
        XCTAssertEqual(editor().draft.name, "Standup", "the name is sent trimmed")
    }

    func testStepsAreAddedMovedAndRemoved() {
        var editor = editor()
        XCTAssertEqual(editor.addStep("form"), 0)
        XCTAssertEqual(editor.addStep("message"), 1)
        XCTAssertEqual(editor.addStep("wait"), 2)
        XCTAssertNil(editor.addStep("nonsense"))
        XCTAssertEqual(editor.steps.map(\.kind), ["form", "message", "wait"])
        guard case let .form(room, recipient, _, fields, saveAs) = editor.steps[0].step else { return XCTFail() }
        XCTAssertEqual(room, "trigger", "a command has a room")
        XCTAssertEqual(recipient, "trigger_user", "and a person who typed it")
        XCTAssertEqual(fields.map(\.id), ["answer"])
        XCTAssertEqual(saveAs, "form")
        guard case let .wait(seconds) = editor.steps[2].step else { return XCTFail() }
        XCTAssertEqual(seconds, 60)

        let ids = editor.steps.map(\.id)
        XCTAssertFalse(editor.canMoveStep(0, by: -1))
        XCTAssertFalse(editor.canMoveStep(2, by: 1))
        editor.moveStep(0, by: -1)
        XCTAssertEqual(editor.steps.map(\.id), ids, "unchanged at an end")
        editor.moveStep(2, by: -1)
        XCTAssertEqual(editor.steps.map(\.kind), ["form", "wait", "message"])
        editor.moveStep(0, by: 1)
        XCTAssertEqual(editor.steps.map(\.id), [ids[2], ids[0], ids[1]], "a step keeps its identity as it moves")
        editor.removeStep(1)
        XCTAssertEqual(editor.steps.map(\.kind), ["wait", "message"])
        editor.removeStep(7)
        XCTAssertEqual(editor.steps.count, 2)

        // A second form's result name does not take the first one's.
        var two = self.editor()
        two.addStep("form")
        two.addStep("form")
        XCTAssertEqual(two.steps.map(\.saveAs), ["form", "form_2"])
    }

    func testAWebhookStepNamesNoTriggerRoom() {
        var editor = editor(.webhook)
        editor.addStep("message")
        editor.addStep("form")
        XCTAssertEqual(editor.steps.map(\.room), ["", ""])
        XCTAssertEqual(editor.steps[1].recipient, "anyone")
    }

    func testFieldIdsFollowTheirLabelUniquely() {
        var editor = editor()
        editor.addStep("form")
        var form = editor.steps[0]
        XCTAssertFalse(form.fields[0].followsLabel, "a field rv-core made keeps its id")
        form.setFieldLabel(0, "Today")
        XCTAssertEqual(form.fields[0].id, "answer")
        XCTAssertEqual(form.fields[0].label, "Today")

        form.addField()
        form.addField()
        XCTAssertEqual(form.fields.map(\.id), ["answer", "field", "field_2"])
        form.setFieldLabel(1, "Answer")
        XCTAssertEqual(form.fields[1].id, "answer_2", "unique in the form")
        form.setFieldLabel(2, "Blockers, if any?")
        XCTAssertEqual(form.fields[2].id, "blockers_if_any")
        form.setFieldLabel(1, "Mood")
        XCTAssertEqual(form.fields[1].id, "mood", "it follows each new label")
        form.removeField(0)
        XCTAssertEqual(form.fields.map(\.id), ["mood", "blockers_if_any"])

        form.fields[0].kind = "choice"
        form.fields[0].options = " good,  , meh ,bad"
        form.fields[1].options = "kept, out"
        XCTAssertEqual(form.step, .form(room: "trigger", recipient: "trigger_user", title: "", fields: [
            NativeFormField(id: "mood", label: "Mood", kind: "choice", options: ["good", "meh", "bad"], people: [], multiple: false, required: false),
            NativeFormField(id: "blockers_if_any", label: "Blockers, if any?", kind: "text", options: [], people: [], multiple: false, required: false),
        ], saveAs: "form"), "only a choice has options")
        XCTAssertEqual(WorkflowFieldForm.optionsText(["a", "b"]), "a, b")
    }

    func testPersonFields() {
        XCTAssertTrue(WorkflowFieldForm.kinds.contains("person"))
        var editor = editor()
        editor.addStep("form")
        editor.steps[0].addField()
        var field = editor.steps[0].fields[1]
        field.setKind("person")
        XCTAssertFalse(field.choosesPeople, "any member of the room at first")
        XCTAssertEqual(field.field.people, [])
        XCTAssertTrue(field.addPerson("u1"))
        XCTAssertTrue(field.choosesPeople)
        XCTAssertFalse(field.addPerson("u1"), "listed once")
        XCTAssertFalse(field.addPerson(""))
        XCTAssertTrue(field.addPerson("u2"))
        XCTAssertEqual(field.field.people, ["u1", "u2"])
        field.removePerson("u1")
        XCTAssertEqual(field.field.people, ["u2"])

        for n in 0 ..< 60 { field.addPerson("p\(n)") }
        XCTAssertEqual(field.people.count, WorkflowFieldForm.peopleLimit, "50 at most")
        XCTAssertTrue(field.peopleFull)
        XCTAssertFalse(field.addPerson("one-more"))

        field.setKind("choice")
        XCTAssertEqual(field.people, [], "leaving person forgets its people")
        XCTAssertFalse(field.choosesPeople)
        XCTAssertEqual(field.field.people, [])
        field.setKind("person")
        field.addPerson("u3")
        field.setChoosesPeople(false)
        XCTAssertEqual(field.field.people, [], "any member again")
        field.setChoosesPeople(true)
        XCTAssertTrue(field.people.isEmpty)
        XCTAssertEqual(field.field.people, [], "nobody chosen yet: sent as any member")
        field.addPerson("u4")
        field.kind = "text"
        XCTAssertEqual(field.field.people, [], "only a person field sends people")

        field.setKind("choice")
        field.multiple = true
        XCTAssertTrue(field.field.multiple)
        field.setKind("person")
        XCTAssertTrue(field.multiple, "a person may take several answers too")
        field.setKind("number")
        XCTAssertFalse(field.multiple, "a kind that takes one answer turns it off")
        XCTAssertFalse(field.field.multiple)
        field.setKind("choice")
        XCTAssertFalse(field.field.multiple, "and it stays off")
        field.multiple = true
        field.kind = "long_text"
        XCTAssertFalse(field.field.multiple, "only a choice or a person sends it")

        let saved = WorkflowFieldForm(NativeFormField(id: "who", label: "Who", kind: "person", options: [], people: ["u9"], multiple: false, required: true))
        XCTAssertTrue(saved.choosesPeople)
        XCTAssertEqual(saved.field.people, ["u9"])

        let people = [
            NativeWorkflowUser(id: "u1", username: "alice", displayName: "Alice Martin"),
            NativeWorkflowUser(id: "u2", username: "bob", displayName: ""),
            NativeWorkflowUser(id: "u3", username: "carol", displayName: "Carol"),
        ]
        XCTAssertEqual(workflowPersonName(people[0]), "Alice Martin (@alice)")
        XCTAssertEqual(workflowPersonName(people[1]), "@bob")
        XCTAssertEqual(workflowPersonName("u3", in: people), "Carol (@carol)")
        XCTAssertEqual(workflowPersonName("gone", in: people), "gone", "an id nobody names shows as itself")
        XCTAssertEqual(workflowPeopleMatching(people, "").map(\.id), ["u1", "u2", "u3"])
        XCTAssertEqual(workflowPeopleMatching(people, " MAR").map(\.id), ["u1"], "by name, case-insensitive")
        XCTAssertEqual(workflowPeopleMatching(people, "bo").map(\.id), ["u2"], "by username")
        XCTAssertEqual(workflowPeopleMatching(people, "", excluding: ["u1", "u3"]).map(\.id), ["u2"])

        let fields = [NativeFormField(id: "who", label: "Who", kind: "person", options: [], people: [], multiple: false, required: true)]
        XCTAssertNil(workflowFormAnswers(fields, [:]), "a required person")
        XCTAssertEqual(workflowFormAnswers(fields, ["who": ["u2"]]), ["who": ["u2"]], "the answer is the user id")
    }

    func testHeadersAreAddedAndRemoved() {
        var editor = editor()
        editor.addStep("http")
        editor.steps[0].addHeader()
        editor.steps[0].addHeader()
        editor.steps[0].headers[1] = NativeHttpHeader(name: "Authorization", value: "Bearer x")
        editor.steps[0].removeHeader(0)
        editor.steps[0].removeHeader(5)
        editor.steps[0].method = "POST"
        editor.steps[0].saveAs = " "
        guard case let .http(method, url, headers, body, saveAs, _) = editor.steps[0].step else { return XCTFail() }
        XCTAssertEqual(method, "POST")
        XCTAssertEqual(url, "https://")
        XCTAssertEqual(headers, [NativeHttpHeader(name: "Authorization", value: "Bearer x")])
        XCTAssertNil(body, "an empty body is not sent")
        XCTAssertNil(saveAs, "nor an empty result name")
    }

    func testVariablesAvailableAtAStep() {
        var editor = editor()
        editor.addStep("form")
        editor.steps[0].saveAs = "standup"
        editor.steps[0].setFieldLabel(0, "Today")
        editor.addStep("http")
        editor.steps[1].saveAs = "call"
        editor.addStep("message")

        let first = editor.variables(0)
        XCTAssertTrue(first.contains("trigger.user.username"))
        XCTAssertTrue(first.contains("now"))
        XCTAssertFalse(first.contains { $0.hasPrefix("standup.") }, "nothing saved before the first step")
        let second = editor.variables(1)
        XCTAssertTrue(second.contains("standup.answers.answer"))
        XCTAssertTrue(second.contains("standup.by.display_name"))
        XCTAssertFalse(second.contains("call.status"), "a step does not see its own result")
        let third = editor.variables(2)
        XCTAssertTrue(third.contains("call.status"))
        XCTAssertTrue(third.contains("call.body"))
        XCTAssertEqual(WorkflowDraftEditor.blank(botId: "b").trigger.kind, "command")
        XCTAssertEqual(self.editor(.webhook).variables(0), ["webhook", "now"])
    }

    func testAVariableGoesIntoTheStepsTemplate() {
        var editor = editor()
        editor.addStep("message")
        editor.addStep("http")
        editor.addStep("wait")
        editor.addStep("form")
        editor.steps[0].text = "Hi "
        editor.insertVariable("trigger.user.username", step: 0)
        XCTAssertEqual(editor.steps[0].text, "Hi {{trigger.user.username}}")
        editor.insertVariable("now", step: 1)
        XCTAssertEqual(editor.steps[1].url, "https://{{now}}", "a GET has no body: its URL")
        editor.steps[1].method = "POST"
        editor.insertVariable("now", step: 1)
        XCTAssertEqual(editor.steps[1].body, "{{now}}")
        let wait = editor.steps[2]
        editor.insertVariable("now", step: 2)
        XCTAssertEqual(editor.steps[2], wait, "a wait has no template")
        editor.insertVariable("trigger.text", step: 3)
        XCTAssertEqual(editor.steps[3].title, "{{trigger.text}}")
        XCTAssertNil(editor.insertVariable("now", step: 9))
        XCTAssertNil(editor.insertVariable("now", step: 2), "a wait has no template")

        // At the cursor, or over the selection; the cursor then goes after it.
        editor.steps[0].text = "Hello world"
        let text = editor.steps[0].text
        let space = text.firstIndex(of: " ")!
        let cursor = editor.insertVariable("now", step: 0, at: space ..< space)
        XCTAssertEqual(editor.steps[0].text, "Hello{{now}} world")
        XCTAssertEqual(cursor.map { editor.steps[0].text[..<$0] }, "Hello{{now}}")
        let all = editor.steps[0].text.startIndex ..< editor.steps[0].text.endIndex
        editor.insertVariable("trigger.text", step: 0, at: all)
        XCTAssertEqual(editor.steps[0].text, "{{trigger.text}}", "the selection is replaced")
        var short = "ab"
        let far = "abcdef".index("abcdef".startIndex, offsetBy: 5)
        XCTAssertEqual(workflowInsert("x", into: &short, replacing: far ..< far), short.endIndex)
        XCTAssertEqual(short, "abx", "a range past the text: at its end")
    }

    func testWaitsConvertBetweenValueAndSeconds() {
        XCTAssertEqual(WorkflowStepForm.waitUnits, ["seconds", "minutes", "hours", "days"])
        var editor = editor()
        editor.addStep("wait")
        XCTAssertEqual(editor.steps[0].waitValue, 1)
        XCTAssertEqual(editor.steps[0].waitUnit, "minutes")
        editor.steps[0].waitValue = 2
        editor.steps[0].waitUnit = "hours"
        XCTAssertEqual(editor.draft.steps, [.wait(seconds: 7200)])
        editor.steps[0].waitValue = 0
        XCTAssertEqual(editor.steps[0].seconds, 1, "at least a second")
        editor.steps[0].waitValue = 90
        editor.steps[0].waitUnit = "days"
        XCTAssertEqual(editor.steps[0].seconds, 2_592_000, "at most 30 days")

        let back = WorkflowStepForm(.wait(seconds: 90))
        XCTAssertEqual(back.waitValue, 90)
        XCTAssertEqual(back.waitUnit, "seconds")
        let day = WorkflowStepForm(.wait(seconds: 86_400))
        XCTAssertEqual(day.waitValue, 1)
        XCTAssertEqual(day.waitUnit, "days")
        setFrench(french: false)
        XCTAssertEqual(WorkflowStepForm.unitName("minutes"), "minutes")
    }

    func testSwitchingTheTriggerKeepsItsRoom() {
        var editor = editor(.memberJoined(room: "room-1"))
        editor.addStep("message")
        editor.addStep("form")
        editor.setTriggerKind("schedule")
        XCTAssertEqual(editor.trigger.kind, "schedule")
        XCTAssertEqual(editor.trigger.room, "room-1", "the room is kept")
        XCTAssertEqual(editor.trigger.every, "day")
        XCTAssertEqual(editor.trigger.time, "09:00")
        XCTAssertFalse(editor.trigger.timezone.isEmpty, "the machine's zone")
        XCTAssertEqual(editor.trigger.timezone, workflowSystemTimeZone())
        XCTAssertEqual(editor.steps[1].recipient, "trigger_user", "kept as it was")
        XCTAssertEqual(editor.problem, L("workflows.error_form"), "but a schedule has no triggering person")
        XCTAssertEqual(editor.steps[0].room, "trigger", "it has a room")

        editor.setTriggerKind("member_joined")
        XCTAssertEqual(editor.trigger.trigger, .memberJoined(room: "room-1"))
        XCTAssertNil(editor.problem, "the person is back")
        editor.setTriggerKind("webhook")
        XCTAssertEqual(editor.trigger.trigger, .webhook)
        XCTAssertEqual(editor.steps.map(\.room), ["trigger", "trigger"], "the steps are kept as they are")
        XCTAssertEqual(editor.steps.count, 2)
        XCTAssertEqual(editor.problem, L("workflows.error_room"), "a webhook has no room for them to name")
        editor.steps[0].room = "room-2"
        XCTAssertEqual(editor.problem, L("workflows.error_room"), "the form still names it")
        editor.steps[1].room = "room-2"
        XCTAssertEqual(editor.problem, L("workflows.error_form"), "nor a person to answer it")
        editor.steps[1].recipient = "anyone"
        XCTAssertNil(editor.problem)
        editor.steps[1].recipient = "trigger_user"
        editor.setTriggerKind("command")
        XCTAssertNil(editor.problem)
        XCTAssertEqual(editor.trigger.trigger, .command(name: ""))
        editor.trigger.name = " deploy "
        XCTAssertEqual(editor.draft.trigger, .command(name: "deploy"))
        editor.setTriggerKind("nonsense")
        XCTAssertEqual(editor.trigger.kind, "command")
    }

    func testReactionAndMessageTriggers() {
        XCTAssertEqual(WorkflowTriggerForm.kinds,
                       ["command", "schedule", "member_joined", "reaction_added", "message_posted", "webhook"])
        var editor = editor(.memberJoined(room: "room-1"))
        editor.addStep("form")
        editor.setTriggerKind("reaction_added")
        XCTAssertEqual(editor.trigger.trigger, .reactionAdded(room: "room-1", emoji: nil), "the room is kept, any reaction")
        XCTAssertTrue(editor.trigger.hasUser, "the person who reacted")
        XCTAssertTrue(editor.trigger.hasRoom)
        XCTAssertEqual(editor.steps[0].recipient, "trigger_user", "kept: they may answer a form")
        editor.trigger.emoji = "  "
        XCTAssertEqual(editor.draft.trigger, .reactionAdded(room: "room-1", emoji: nil), "empty: any reaction")
        editor.trigger.emoji = ":tada:"
        XCTAssertEqual(editor.draft.trigger, .reactionAdded(room: "room-1", emoji: "tada"), "sent without colons")
        XCTAssertEqual(WorkflowTriggerForm(.reactionAdded(room: "r", emoji: "+1")).emoji, "+1")
        XCTAssertTrue(editor.variables(0).contains("trigger.emoji"))

        editor.setTriggerKind("message_posted")
        XCTAssertEqual(editor.trigger.trigger, .messagePosted(room: "room-1", contains: ""), "the room is kept")
        XCTAssertTrue(editor.trigger.hasUser, "the person who posted")
        XCTAssertEqual(editor.steps[0].recipient, "trigger_user")
        editor.trigger.contains = " deploy please "
        XCTAssertEqual(editor.draft.trigger, .messagePosted(room: "room-1", contains: "deploy please"))
        XCTAssertTrue(editor.variables(0).contains("trigger.message.text"))
        XCTAssertEqual(WorkflowTriggerForm(.messagePosted(room: "r", contains: "hi")).contains, "hi")

        editor.setTriggerKind("reaction_added")
        XCTAssertEqual(editor.trigger.trigger, .reactionAdded(room: "room-1", emoji: nil), "back again, the room still kept")
        editor.setTriggerKind("schedule")
        XCTAssertFalse(editor.trigger.hasUser)
        XCTAssertEqual(editor.steps[0].recipient, "trigger_user", "kept, the save refused instead")
        XCTAssertEqual(editor.problem, L("workflows.error_form"))
        XCTAssertEqual(editor.trigger.room, "room-1")
    }

    func testAScheduleIsTypedAsHourMinuteAndDays() {
        var trigger = WorkflowTriggerForm(.schedule(every: "week", time: "07:05", days: Data([5, 1]), timezone: "Europe/Paris", room: ""))
        XCTAssertEqual(trigger.days, [5, 1])
        XCTAssertEqual(trigger.hour, 7)
        XCTAssertEqual(trigger.minute, 5)
        trigger.hour = 18
        trigger.minute = 30
        XCTAssertEqual(trigger.time, "18:30")
        trigger.hour = 31
        XCTAssertEqual(trigger.time, "23:30", "kept in range")
        trigger.toggleDay(3)
        trigger.toggleDay(5)
        XCTAssertEqual(trigger.days, [1, 3], "sorted, Monday first")
        XCTAssertEqual(trigger.trigger, .schedule(every: "week", time: "23:30", days: Data([1, 3]), timezone: "Europe/Paris", room: ""))
        trigger.every = "day"
        XCTAssertEqual(trigger.trigger, .schedule(every: "day", time: "23:30", days: Data(), timezone: "Europe/Paris", room: ""),
                       "days only for a weekly one")
        XCTAssertEqual(WorkflowTriggerForm.timeParts("nonsense").hour, 0)
        XCTAssertEqual(WorkflowTriggerForm.time(hour: 9, minute: 0), "09:00")
        setFrench(french: false)
        XCTAssertEqual(WorkflowTriggerForm.dayName(1), "Mon")
        XCTAssertEqual(WorkflowTriggerForm.dayName(7), "Sun")
    }

    func testAWorkflowComesBackAsItsDraft() {
        let user = NativeWorkflowUser(id: "bot-1", username: "standup_bot", displayName: "Standup")
        let steps: [NativeWorkflowStep] = [
            .form(room: "trigger", recipient: "trigger_user", title: "Standup", fields: [
                NativeFormField(id: "today", label: "Today", kind: "long_text", options: [], people: [], multiple: false, required: true),
            ], saveAs: "standup"),
            .message(room: "trigger", text: "{{standup.answers.today}}", inThread: true, saveAs: nil, cards: "[{\"title\":\"x\"}]"),
            .wait(seconds: 300),
            .http(method: "POST", url: "https://example.org", headers: [NativeHttpHeader(name: "X", value: "1")],
                  body: "{}", saveAs: "call", continueOnError: true),
        ]
        let workflow = NativeWorkflow(id: "w1", owner: user, bot: user, name: "Standup", description: "Daily", enabled: false,
                                      trigger: .command(name: "standup"), steps: steps, revision: "3", hasWebhook: false,
                                      nextFireAt: nil, lastRun: nil, summary: "/standup", createdAt: "", updatedAt: "")
        let editor = WorkflowDraftEditor(workflow: workflow)
        XCTAssertEqual(editor.draft, NativeWorkflowDraft(name: "Standup", description: "Daily", botId: "bot-1", enabled: false,
                                                         trigger: .command(name: "standup"), steps: steps),
                       "unchanged, the cards kept as they are")
    }

    func testFormAnswers() {
        let fields = [
            NativeFormField(id: "today", label: "Today", kind: "long_text", options: [], people: [], multiple: false, required: true),
            NativeFormField(id: "mood", label: "Mood", kind: "choice", options: ["good", "bad"], people: [], multiple: false, required: false),
        ]
        XCTAssertNil(workflowFormAnswers(fields, ["today": ["  "], "mood": ["good"]]), "a required field is empty")
        XCTAssertNil(workflowFormAnswers(fields, ["mood": ["good"]]), "or left out")
        XCTAssertEqual(workflowFormAnswers(fields, ["today": [" shipping \n"]]), ["today": ["shipping"]])
        XCTAssertEqual(workflowFormAnswers(fields, ["today": ["x"], "mood": [], "other": ["y"]]), ["today": ["x"]],
                       "an optional field with nothing picked is left out, an unknown one too")
        XCTAssertEqual(workflowFormAnswers(fields, ["today": ["x"], "mood": ["bad", "good"]]), ["today": ["x"], "mood": ["bad"]],
                       "one answer for a field that takes one")

        let several = [
            NativeFormField(id: "langs", label: "Languages", kind: "choice", options: ["rust", "swift", "kotlin"],
                            people: [], multiple: true, required: true),
            NativeFormField(id: "who", label: "Who", kind: "person", options: [], people: [], multiple: true, required: false),
        ]
        XCTAssertNil(workflowFormAnswers(several, ["langs": []]), "required: at least one")
        XCTAssertEqual(workflowFormAnswers(several, ["langs": ["swift", "rust", "swift"], "who": ["u1", "u2"]]),
                       ["langs": ["swift", "rust"], "who": ["u1", "u2"]], "every value, once each, in order")
        var ticked = workflowTick([], "swift", true)
        ticked = workflowTick(ticked, "rust", true)
        ticked = workflowTick(ticked, "swift", true)
        XCTAssertEqual(ticked, ["rust", "swift"])
        XCTAssertEqual(workflowTick(ticked, "rust", false), ["swift"])
    }

    func testRefusalsAreWorded() {
        setFrench(french: false)
        let conflict = RvError.Server(status: 409, message: "", error: "revision_conflict", twoFactor: nil, requestId: nil, retryAfter: nil)
        XCTAssertEqual(workflowFailure(conflict), L("workflows.error_conflict"))
        XCTAssertNotEqual(workflowFailure(conflict), "workflows.error_conflict", "a sentence, not a key")
        let reauth = RvError.Server(status: 403, message: "", error: "reauthentication_required", twoFactor: nil, requestId: nil, retryAfter: nil)
        XCTAssertEqual(workflowFailure(reauth), L("workflows.error_reauth"))
        XCTAssertTrue(needsReauthentication(reauth))
        XCTAssertFalse(needsReauthentication(conflict))
        XCTAssertEqual(workflowFailure(RvError.Local(message: "x")), L("workflows.failed"))
    }

    @MainActor
    func testTheWebhookURLIsDroppedWithTheAccount() {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-workflows-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let app = AppModel(home: home.path)
        app.workflowWebhook = "https://example.org/api/v1/hooks/w1/secret"
        app.dismissWorkflowWebhook()
        XCTAssertNil(app.workflowWebhook)
        app.workflowWebhook = "https://example.org/api/v1/hooks/w1/secret"
        app.end()
        XCTAssertNil(app.workflowWebhook, "never kept past the account")
        let model = WorkflowsModel(app: app)
        XCTAssertTrue(model.workflows.isEmpty)
        XCTAssertFalse(model.loaded)
    }
}
