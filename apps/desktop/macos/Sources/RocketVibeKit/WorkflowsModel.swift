import Foundation
import Observation
import RocketVibeCore

/// A workflow refusal (`RvError` carries the server's code), as rv-core words
/// it for both desktop apps.
public func workflowFailure(_ error: Error) -> String {
    if case let RvError.Server(status, _, code, _, _, _) = error {
        return L(workflowErrorKey(code: code ?? "", status: status))
    }
    return L("workflows.failed")
}

/// The answer sent needs a recent sign-in: the view points to Security.
func needsReauthentication(_ error: Error) -> Bool {
    if case let RvError.Server(_, _, code, _, _, _) = error { return code == "reauthentication_required" }
    return false
}

/// What saving an edited workflow came to.
public enum WorkflowSaveResult {
    case saved(NativeWorkflow)
    /// Someone saved it meanwhile: the editor starts over from this version.
    case conflict(NativeWorkflow)
    case failed
}

/// The workflows of the open RocketVibe account (RFC 0004): mine, whether I
/// may create one, my bots to act through, the rooms a trigger or a step may
/// name, and each opened workflow's runs. A webhook URL goes to
/// `AppModel.workflowWebhook`, in memory only, until its sheet closes.
@MainActor @Observable
public final class WorkflowsModel {
    public private(set) var workflows: [NativeWorkflow] = []
    public private(set) var canCreate = false
    /// My bots, for the bot picker.
    public private(set) var bots: [NativeBot] = []
    /// The plaintext rooms a trigger or a step may name.
    public private(set) var rooms: [NativeRoomChoice] = []
    /// Each opened workflow's last runs, by workflow id.
    public private(set) var runs: [String: [NativeWorkflowRun]] = [:]
    /// The workflows whose runs are being read.
    public private(set) var runsLoading: Set<String> = []
    public private(set) var loaded = false
    public private(set) var busy = false
    public private(set) var error: String?
    /// "Workflow saved", or what went wrong with an action.
    public var notice: String?
    /// The last action needs a recent sign-in (Security's verification).
    public private(set) var needsReauth = false
    /// The people a person field may list (no bots, no deleted accounts), read
    /// when an editor opens.
    public private(set) var people: [NativeWorkflowUser] = []
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let accountId: UUID

    public init(app: AppModel) {
        self.app = app
        chat = app.native
        accountId = app.sessionId
    }
    private var active: Bool { app?.sessionId == accountId && app?.native === chat && chat != nil }

    /// The bots a workflow may act through: mine, not deactivated.
    public var liveBots: [NativeBot] { bots.filter { !$0.disabled } }

    public func workflow(_ id: String) -> NativeWorkflow? { workflows.first { $0.id == id } }

    /// A room id in words: its label, "the trigger's room", or "no room chosen".
    public func roomLabel(_ id: String) -> String { chat?.workflowRoomLabel(id: id) ?? id }
    public func stepSummary(_ step: NativeWorkflowStep) -> String { chat?.workflowStepSummary(step: step) ?? "" }

    public func load() async {
        guard active, !busy, let chat else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let fresh = try await chat.workflows()
            let can = (try? await chat.canCreateWorkflow()) ?? false
            let mine = (try? await chat.bots()) ?? bots
            guard active else { return }
            workflows = fresh
            canCreate = can
            bots = mine
            rooms = chat.workflowRooms()
            loaded = true
        } catch {
            guard active else { return }
            self.error = workflowFailure(error)
            loaded = true
        }
    }

    /// The new workflow, or nil with `notice` saying why.
    public func create(_ editor: WorkflowDraftEditor) async -> NativeWorkflow? {
        let draft = editor.draft
        let made = await act { try await $0.createWorkflow(draft: draft) }
        if made != nil { notice = L("workflows.created") }
        return made
    }

    /// Saves the whole definition at the revision it was read at. On a
    /// conflict the workflow is read again and handed back for the editor to
    /// start over from, `notice` saying why.
    public func save(_ workflow: NativeWorkflow, _ editor: WorkflowDraftEditor) async -> WorkflowSaveResult {
        guard active, !busy, let chat else { return .failed }
        let draft = editor.draft
        busy = true
        notice = nil
        needsReauth = false
        do {
            let saved = try await chat.updateWorkflow(id: workflow.id, revision: workflow.revision, draft: draft)
            busy = false
            guard active else { return .failed }
            await load()
            notice = L("workflows.saved")
            return .saved(saved)
        } catch {
            let conflict: Bool
            if case let RvError.Server(_, _, code, _, _, _) = error { conflict = code == "revision_conflict" } else { conflict = false }
            let words = workflowFailure(error)
            guard conflict, active else {
                busy = false
                if active { notice = words }
                return .failed
            }
            let fresh = try? await chat.getWorkflow(id: workflow.id)
            busy = false
            guard active else { return .failed }
            await load()
            notice = words
            if let fresh { return .conflict(fresh) }
            return .failed
        }
    }

    /// Starts a run now, then reads the runs again.
    public func test(_ workflow: NativeWorkflow) async {
        let id = workflow.id
        let started: String? = await act { try await $0.testWorkflow(id: id) }
        if started != nil {
            notice = L("workflows.tested")
            await loadRuns(workflow)
        }
    }

    /// Turns it off and cancels its unfinished runs.
    public func disable(_ workflow: NativeWorkflow) async -> NativeWorkflow? {
        let id = workflow.id
        let off = await act { try await $0.disableWorkflow(id: id) }
        if off != nil { notice = L("workflows.disabled") }
        return off
    }

    public func delete(_ workflow: NativeWorkflow) async -> Bool {
        let id = workflow.id
        let done: Void? = await act { try await $0.deleteWorkflow(id: id) }
        if done != nil { runs[id] = nil }
        return done != nil
    }

    /// The people a person field may list, read again for each editor.
    public func loadPeople() async {
        guard active, let chat else { return }
        do {
            let fresh = try await chat.workflowPeople()
            guard active else { return }
            people = fresh
        } catch {
            guard active else { return }
            notice = workflowFailure(error)
        }
    }

    public func loadRuns(_ workflow: NativeWorkflow) async {
        guard active, let chat else { return }
        runsLoading.insert(workflow.id)
        defer { runsLoading.remove(workflow.id) }
        do {
            let fresh = try await chat.workflowRuns(id: workflow.id)
            guard active else { return }
            runs[workflow.id] = fresh
        } catch {
            guard active else { return }
            notice = workflowFailure(error)
        }
    }

    /// A new webhook secret; the URL lands in `AppModel.workflowWebhook`,
    /// shown once by the window: the server never shows it again. A stale
    /// sign-in sets `needsReauth`. True once made.
    public func generateWebhook(_ workflow: NativeWorkflow) async -> Bool {
        guard active, !busy, let chat else { return false }
        busy = true
        notice = nil
        needsReauth = false
        do {
            let url = try await chat.workflowWebhook(id: workflow.id)
            busy = false
            guard let app, app.sessionId == accountId else { return false }
            app.workflowWebhook = url
            guard active else { return true }
            await load()
            return true
        } catch {
            busy = false
            guard active else { return false }
            notice = workflowFailure(error)
            needsReauth = needsReauthentication(error)
            return false
        }
    }

    /// Runs one action, then reads the list again (last run, next fire, webhook).
    private func act<T>(_ action: (NativeChat) async throws -> T) async -> T? {
        guard active, !busy, let chat else { return nil }
        busy = true
        notice = nil
        needsReauth = false
        do {
            let result = try await action(chat)
            busy = false
            guard active else { return nil }
            await load()
            return result
        } catch {
            busy = false
            guard active else { return nil }
            notice = workflowFailure(error)
            needsReauth = needsReauthentication(error)
            return nil
        }
    }
}

extension RoomModel {
    /// Answers the form `message` carries (field id to its values). Nil once
    /// sent, else what went wrong, worded.
    public func answerForm(message: String, answers: [String: [String]]) async -> String? {
        guard active, membershipIsCurrent, let native = provider.native else { return L("workflows.failed") }
        do {
            try await native.answerForm(message: message, answers: answers)
            return nil
        } catch {
            return workflowFailure(error)
        }
    }

    /// The members of `rid` who may be named in answer to a person field
    /// listing nobody (no bots, deleted or disabled accounts), or the
    /// failure worded.
    public func formMembers(rid: String) async -> Result<[NativeWorkflowUser], WorkflowFailure> {
        guard active, let native = provider.native else { return .failure(WorkflowFailure(text: L("workflows.failed"))) }
        do {
            return .success(try await native.formMembers(room: rid))
        } catch {
            return .failure(WorkflowFailure(text: workflowFailure(error)))
        }
    }
}

/// A workflow call's failure, worded.
public struct WorkflowFailure: Error, Equatable {
    public let text: String
}

// MARK: - The editor's state

/// A trigger as the editor shows it: every kind's settings flattened, so the
/// fields bind directly; `trigger` gives the definition back.
public struct WorkflowTriggerForm: Equatable {
    /// Every kind's wire name, in the order the picker offers them.
    public static var kinds: [String] { workflowTriggerKinds() }
    public static let everyKinds = ["hour", "day", "week"]
    /// 1 Monday to 7 Sunday.
    public static let weekdays: [UInt8] = [1, 2, 3, 4, 5, 6, 7]

    public var kind: String
    /// The command's name, without its slash.
    public var name = ""
    public var every = "day"
    /// `HH:MM`.
    public var time = "09:00"
    public var days: [UInt8] = []
    public var timezone = ""
    /// A room id; empty: none chosen.
    public var room = ""
    /// The reaction a `reaction_added` waits for, without colons; empty: any.
    public var emoji = ""
    /// The text a `message_posted` looks for, case-insensitive.
    public var contains = ""

    public init(_ trigger: NativeWorkflowTrigger) {
        switch trigger {
        case let .command(name):
            kind = "command"; self.name = name
        case let .schedule(every, time, days, timezone, room):
            kind = "schedule"; self.every = every; self.time = time; self.days = Array(days)
            self.timezone = timezone; self.room = room
        case let .memberJoined(room):
            kind = "member_joined"; self.room = room
        case let .reactionAdded(room, emoji):
            kind = "reaction_added"; self.room = room; self.emoji = emoji ?? ""
        case let .messagePosted(room, contains):
            kind = "message_posted"; self.room = room; self.contains = contains
        case .webhook:
            kind = "webhook"
        }
    }

    public var trigger: NativeWorkflowTrigger {
        switch kind {
        case "command": return .command(name: name.trimmingCharacters(in: .whitespaces))
        case "schedule":
            return .schedule(every: every, time: time, days: Data(every == "week" ? days : []),
                             timezone: timezone.trimmingCharacters(in: .whitespaces), room: room)
        case "member_joined": return .memberJoined(room: room)
        case "reaction_added":
            let chosen = emoji.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return .reactionAdded(room: room, emoji: chosen.isEmpty ? nil : chosen)
        case "message_posted": return .messagePosted(room: room, contains: contains.trimmingCharacters(in: .whitespaces))
        default: return .webhook
        }
    }

    /// A step may name "the trigger's room" (every kind but the webhook).
    public var hasRoom: Bool { kind != "webhook" }
    /// A message may reply in the trigger's thread (a reaction's or a message's).
    public var hasThread: Bool { workflowTriggerHasThread(trigger: trigger) }
    /// A form may be for "the person who triggered it".
    public var hasUser: Bool { workflowTriggerHasPerson(trigger: trigger) }

    /// Another kind, keeping the room the current one names.
    public mutating func setKind(_ kind: String) {
        guard kind != self.kind, let fresh = workflowNewTrigger(kind: kind, current: trigger) else { return }
        self = WorkflowTriggerForm(fresh)
    }

    public var hour: Int {
        get { Self.timeParts(time).hour }
        set { time = Self.time(hour: newValue, minute: minute) }
    }
    public var minute: Int {
        get { Self.timeParts(time).minute }
        set { time = Self.time(hour: hour, minute: newValue) }
    }

    /// `HH:MM`, each part kept in its range.
    public static func time(hour: Int, minute: Int) -> String {
        func two(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
        return two(min(max(hour, 0), 23)) + ":" + two(min(max(minute, 0), 59))
    }
    public static func timeParts(_ time: String) -> (hour: Int, minute: Int) {
        let parts = time.split(separator: ":")
        let hour = parts.first.flatMap { Int($0) } ?? 0
        let minute = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        return (min(max(hour, 0), 23), min(max(minute, 0), 59))
    }

    public mutating func toggleDay(_ day: UInt8) {
        var chosen = Set(days)
        if chosen.contains(day) { chosen.remove(day) } else { chosen.insert(day) }
        days = Self.weekdays.filter(chosen.contains)
    }

    /// A weekday's short name, 1 Monday to 7 Sunday.
    public static func dayName(_ day: UInt8) -> String { L(workflowDayKey(day: day)) }
}

/// A form's field as the editor shows it: its options as typed (comma
/// separated). A new field's id follows its label; a saved one keeps its id,
/// which later steps may name.
public struct WorkflowFieldForm: Equatable {
    public static let kinds = ["text", "long_text", "number", "choice", "person"]
    /// The most people a person field may list (rv-core's limit).
    public static var peopleLimit: Int { Int(workflowLimits().people) }

    public var id: String
    public var label: String
    public var kind: String
    public var options: String
    /// A person field's people, by user id, in the order they were added.
    public var people: [String]
    /// A person field lists `people` ("These people"); off: any member of the room.
    public var choosesPeople: Bool
    /// A choice or person field takes several answers (checkboxes), not one.
    public var multiple: Bool
    public var required: Bool
    public var followsLabel: Bool

    public init(_ field: NativeFormField, followsLabel: Bool = false) {
        id = field.id
        label = field.label
        kind = field.kind
        options = Self.optionsText(field.options)
        people = field.people
        choosesPeople = !field.people.isEmpty
        multiple = field.multiple
        required = field.required
        self.followsLabel = followsLabel
    }

    public var field: NativeFormField {
        NativeFormField(id: id, label: label.trimmingCharacters(in: .whitespaces), kind: kind,
                        options: kind == "choice" ? Self.options(options) : [],
                        people: kind == "person" && choosesPeople ? people : [],
                        multiple: allowsMultiple && multiple, required: required)
    }

    /// Only a choice or a person may take several answers.
    public var allowsMultiple: Bool { kind == "choice" || kind == "person" }

    /// Another kind; leaving `person` forgets its people, a kind that takes
    /// one answer turns "Several answers" off.
    public mutating func setKind(_ kind: String) {
        self.kind = kind
        if kind != "person" {
            people = []
            choosesPeople = false
        }
        if !allowsMultiple { multiple = false }
    }

    /// "Any member of the room" (false) or "These people" (true); any member forgets the list.
    public mutating func setChoosesPeople(_ chooses: Bool) {
        choosesPeople = chooses
        if !chooses { people = [] }
    }

    public var peopleFull: Bool { people.count >= Self.peopleLimit }

    /// Adds a person by user id; false when already listed or the list is full.
    @discardableResult
    public mutating func addPerson(_ id: String) -> Bool {
        guard !id.isEmpty, !people.contains(id), !peopleFull else { return false }
        people.append(id)
        choosesPeople = true
        return true
    }

    public mutating func removePerson(_ id: String) { people.removeAll { $0 == id } }

    /// `a, b, c` into its options, trimmed, empty ones dropped.
    public static func options(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    public static func optionsText(_ options: [String]) -> String { options.joined(separator: ", ") }
}

/// A step as the editor shows it: every kind's settings flattened, so the
/// fields bind directly; `step` gives the definition back. A wait is typed as
/// a value and a unit.
public struct WorkflowStepForm: Equatable, Identifiable {
    public static let kinds = ["message", "wait", "http", "form"]
    public static let methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    public static let recipients = ["trigger_user", "anyone"]

    public let id: UUID
    public var kind: String
    /// `trigger` or a room id.
    public var room = ""
    public var text = ""
    public var inThread = false
    /// The result's name; empty: not kept (a form's is required).
    public var saveAs = ""
    /// A message's integration cards, as JSON, kept as they are.
    public var cards = ""
    public var waitValue: UInt64 = 1
    public var waitUnit = "minutes"
    public var method = "GET"
    public var url = ""
    public var headers: [NativeHttpHeader] = []
    public var body = ""
    public var continueOnError = false
    public var recipient = "anyone"
    public var title = ""
    public var fields: [WorkflowFieldForm] = []

    public init(_ step: NativeWorkflowStep, id: UUID = UUID()) {
        self.id = id
        switch step {
        case let .message(room, text, inThread, saveAs, cards):
            kind = "message"; self.room = room; self.text = text; self.inThread = inThread
            self.saveAs = saveAs ?? ""; self.cards = cards
        case let .wait(seconds):
            kind = "wait"
            let parts = workflowWaitParts(seconds: seconds)
            waitValue = parts.value; waitUnit = parts.unit
        case let .http(method, url, headers, body, saveAs, continueOnError):
            kind = "http"; self.method = method; self.url = url; self.headers = headers; self.body = body ?? ""
            self.saveAs = saveAs ?? ""; self.continueOnError = continueOnError
        case let .form(room, recipient, title, fields, saveAs):
            kind = "form"; self.room = room; self.recipient = recipient; self.title = title
            self.fields = fields.map { WorkflowFieldForm($0) }; self.saveAs = saveAs
        }
    }

    public var seconds: UInt64 { workflowWaitSeconds(value: waitValue, unit: waitUnit) }

    public var step: NativeWorkflowStep {
        let kept = saveAs.trimmingCharacters(in: .whitespaces)
        switch kind {
        case "wait":
            return .wait(seconds: seconds)
        case "http":
            return .http(method: method, url: url, headers: headers, body: body.isEmpty ? nil : body,
                         saveAs: kept.isEmpty ? nil : kept, continueOnError: continueOnError)
        case "form":
            return .form(room: room, recipient: recipient, title: title, fields: fields.map(\.field), saveAs: kept)
        default:
            return .message(room: room, text: text, inThread: inThread, saveAs: kept.isEmpty ? nil : kept, cards: cards)
        }
    }

    /// Where the Variables menu writes: the text of a message, the body of a
    /// request that has one, else its URL. A wait and a form have none (the
    /// engine never renders a form's title).
    public var template: WritableKeyPath<WorkflowStepForm, String>? {
        switch kind {
        case "message": return \.text
        case "http": return method == "GET" || method == "DELETE" ? \.url : \.body
        default: return nil
        }
    }

    /// A field whose label changed: a new field's id follows it, unique in this form.
    public mutating func setFieldLabel(_ index: Int, _ label: String) {
        guard fields.indices.contains(index) else { return }
        fields[index].label = label
        guard fields[index].followsLabel else { return }
        let taken = fields.indices.filter { $0 != index }.map { fields[$0].id }
        fields[index].id = workflowIdentifier(label: label, taken: taken)
    }

    public mutating func addField() {
        guard canAddField else { return }
        let taken = fields.map(\.id)
        let field = NativeFormField(id: workflowIdentifier(label: "", taken: taken), label: "", kind: "text",
                                    options: [], people: [], multiple: false, required: false)
        fields.append(WorkflowFieldForm(field, followsLabel: true))
    }

    public mutating func removeField(_ index: Int) {
        if fields.indices.contains(index) { fields.remove(at: index) }
    }

    public var canAddField: Bool { fields.count < Int(WorkflowDraftEditor.limits.fields) }
    public var canAddHeader: Bool { headers.count < Int(WorkflowDraftEditor.limits.headers) }

    public mutating func addHeader() {
        guard canAddHeader else { return }
        headers.append(NativeHttpHeader(name: "", value: ""))
    }

    public mutating func removeHeader(_ index: Int) {
        if headers.indices.contains(index) { headers.remove(at: index) }
    }

    /// Every wait unit's name and words, smallest first.
    public static var waitUnits: [String] { workflowWaitUnits() }
    public static func unitName(_ unit: String) -> String { L(workflowWaitUnitKey(unit: unit)) }
}

/// The whole definition being edited, and the pure edits the editor makes on
/// it: steps added, moved and removed, the trigger's kind switched, the
/// variables each step may use.
public struct WorkflowDraftEditor: Equatable {
    public var name: String
    public var description: String
    public var botId: String
    public var enabled: Bool
    public var trigger: WorkflowTriggerForm
    public var steps: [WorkflowStepForm]

    public init(draft: NativeWorkflowDraft) {
        name = draft.name
        description = draft.description
        botId = draft.botId
        enabled = draft.enabled
        trigger = WorkflowTriggerForm(draft.trigger)
        steps = draft.steps.map { WorkflowStepForm($0) }
    }

    public init(workflow: NativeWorkflow) {
        self.init(draft: NativeWorkflowDraft(name: workflow.name, description: workflow.description, botId: workflow.bot.id,
                                             enabled: workflow.enabled, trigger: workflow.trigger, steps: workflow.steps))
    }

    /// A new workflow: a command, no step yet, acting through `botId`.
    public static func blank(botId: String) -> WorkflowDraftEditor {
        WorkflowDraftEditor(draft: NativeWorkflowDraft(name: "", description: "", botId: botId, enabled: true,
                                                       trigger: .command(name: ""), steps: []))
    }

    public var draft: NativeWorkflowDraft {
        NativeWorkflowDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), description: description,
                            botId: botId, enabled: enabled, trigger: trigger.trigger, steps: steps.map(\.step))
    }

    /// Another trigger kind, keeping its room. The steps stay as they are:
    /// one the new trigger cannot serve is named by `problem`, not changed.
    public mutating func setTriggerKind(_ kind: String) {
        trigger.setKind(kind)
    }

    /// What the server would refuse in the definition as it is (its error
    /// code, rv-core checking the draft as a save would); nil when it may be saved.
    public var problemCode: String? { workflowDraftProblem(draft: draft) }

    /// `problemCode`, worded.
    public var problem: String? { problemCode.map { L(workflowErrorKey(code: $0, status: 0)) } }

    /// The limits a definition stays within, as the server enforces them.
    public static var limits: NativeWorkflowLimits { workflowLimits() }

    /// Another step may be added.
    public var canAddStep: Bool { steps.count < Int(Self.limits.steps) }

    /// A step of `kind` at the end, as rv-core starts one; its index.
    @discardableResult
    public mutating func addStep(_ kind: String) -> Int? {
        guard canAddStep else { return nil }
        guard let step = workflowNewStep(kind: kind, trigger: trigger.trigger, steps: steps.map(\.step)) else { return nil }
        steps.append(WorkflowStepForm(step))
        return steps.count - 1
    }

    public mutating func removeStep(_ index: Int) {
        if steps.indices.contains(index) { steps.remove(at: index) }
    }

    public func canMoveStep(_ index: Int, by offset: Int) -> Bool {
        steps.indices.contains(index) && steps.indices.contains(index + offset)
    }

    /// The step moved by `offset` (-1 up, 1 down); unchanged at an end.
    public mutating func moveStep(_ index: Int, by offset: Int) {
        guard canMoveStep(index, by: offset) else { return }
        steps.swapAt(index, index + offset)
    }

    /// The variables the step at `index` may use, without their braces.
    public func variables(_ index: Int) -> [String] {
        workflowVariables(trigger: trigger.trigger, steps: steps.map(\.step), index: UInt32(max(index, 0)))
    }

    /// `{{variable}}` put into the step's template (`WorkflowStepForm.template`):
    /// over `range` (the editor's selection) when it lies in that text, else
    /// at its end. Where the text's cursor goes next; nil when the step has
    /// no template.
    @discardableResult
    public mutating func insertVariable(_ variable: String, step index: Int,
                                        at range: Range<String.Index>? = nil) -> String.Index? {
        guard steps.indices.contains(index), let path = steps[index].template else { return nil }
        return workflowInsert(workflowPlaceholder(variable: variable), into: &steps[index][keyPath: path], replacing: range)
    }
}

/// `inserted` put into `text` over `range` when it lies within the text,
/// else at its end; the index just past it.
@discardableResult
public func workflowInsert(_ inserted: String, into text: inout String, replacing range: Range<String.Index>?) -> String.Index {
    guard let range, range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex else {
        text += inserted
        return text.endIndex
    }
    let start = text.distance(from: text.startIndex, to: range.lowerBound)
    text.replaceSubrange(range, with: inserted)
    return text.index(text.startIndex, offsetBy: start + inserted.count)
}

/// A person as a list shows them: "Display Name (@username)", the username
/// alone when they have no display name.
public func workflowPersonName(_ user: NativeWorkflowUser) -> String {
    let name = user.displayName.trimmingCharacters(in: .whitespaces)
    return name.isEmpty || name == user.username ? "@" + user.username : "\(name) (@\(user.username))"
}

/// A user id in words from `people`; an id they do not name shows as itself.
public func workflowPersonName(_ id: String, in people: [NativeWorkflowUser]) -> String {
    people.first { $0.id == id }.map(workflowPersonName) ?? id
}

/// The people whose name or username contains `search` (case-insensitive),
/// those in `excluding` left out, in the order given.
public func workflowPeopleMatching(_ people: [NativeWorkflowUser], _ search: String,
                                   excluding: [String] = []) -> [NativeWorkflowUser] {
    let query = search.trimmingCharacters(in: .whitespaces).lowercased()
    return people.filter { person in
        !excluding.contains(person.id) && (query.isEmpty
            || person.displayName.lowercased().contains(query) || person.username.lowercased().contains(query))
    }
}

/// The answers a form card sends, or the first field the server would refuse.
public enum WorkflowAnswers: Equatable {
    /// Each field's values as a list, the fields with nothing picked left out.
    case ready([String: [String]])
    /// A required field with nothing in it (`form_required`).
    case missing(field: String)
    /// Several values for a field that takes one, a short text on several
    /// lines (`form_value`).
    case invalid(field: String)

    /// Why it cannot be sent, worded; nil when it can.
    public var problem: String? {
        switch self {
        case .ready: return nil
        case .missing: return L("workflows.error_form_required")
        case .invalid: return L("workflows.error_form_value")
        }
    }
}

/// The answers a form card sends: trimmed, empty and repeated values dropped.
public func workflowFormAnswers(_ fields: [NativeFormField], _ values: [String: [String]]) -> WorkflowAnswers {
    var answers: [String: [String]] = [:]
    for field in fields {
        var picked: [String] = []
        for value in values[field.id] ?? [] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && !picked.contains(trimmed) { picked.append(trimmed) }
        }
        if picked.isEmpty {
            if field.required { return .missing(field: field.id) }
            continue
        }
        if !field.multiple && picked.count > 1 { return .invalid(field: field.id) }
        if field.kind == "text" && picked.contains(where: { $0.contains(where: \.isNewline) }) {
            return .invalid(field: field.id)
        }
        answers[field.id] = picked
    }
    return .ready(answers)
}

/// A multiple field's values with `value` ticked or unticked, in the order
/// they were ticked.
public func workflowTick(_ values: [String], _ value: String, _ on: Bool) -> [String] {
    var ticked = values.filter { $0 != value }
    if on { ticked.append(value) }
    return ticked
}
