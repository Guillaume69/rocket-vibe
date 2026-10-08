import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The workflow the editor opens: a saved one, or a new one.
struct WorkflowTarget: Identifiable {
    let id: String
    let workflow: NativeWorkflow?

    static let new = WorkflowTarget(id: "", workflow: nil)
}

/// The Workflows category (RFC 0004): my workflows, each opening its editor
/// (trigger, steps, test, disable, deletion, runs); "Create a workflow" when
/// the server lets me and I have a bot for it to act through.
struct WorkflowsSection: View {
    @Environment(AppModel.self) var app
    @State private var model: WorkflowsModel?
    @State private var editing: WorkflowTarget?

    var body: some View {
        Section(L("workflows.title")) {
            Text(L("workflows.intro")).foregroundStyle(.secondary)
            if let model {
                if model.busy && !model.loaded { ProgressView(L("workflows.loading")) }
                if model.loaded && model.workflows.isEmpty && model.error == nil {
                    Text(L("workflows.empty")).foregroundStyle(.secondary)
                }
                ForEach(model.workflows, id: \.id) { workflow in
                    Button { editing = WorkflowTarget(id: workflow.id, workflow: workflow) } label: {
                        WorkflowRow(workflow: workflow)
                    }
                    .buttonStyle(.plain)
                }
                if model.loaded {
                    if !model.canCreate {
                        Text(L("workflows.closed")).foregroundStyle(.secondary)
                    } else if model.liveBots.isEmpty {
                        Text(L("workflows.no_bot")).foregroundStyle(.secondary)
                        Button(L("settings.cat.bots")) { app.settingsCategory = .bots }
                    } else {
                        Button(L("workflows.create")) { editing = .new }.disabled(model.busy)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                if editing == nil, let notice = model.notice { Text(notice).foregroundStyle(.secondary) }
                Button(L("security.refresh")) { Task { await model.load() } }.disabled(model.busy)
            }
        }
        .task(id: app.native.map(ObjectIdentifier.init)) {
            editing = nil
            let fresh = WorkflowsModel(app: app); model = fresh; await fresh.load()
        }
        .modalOverlay(item: $editing, style: .sheet(width: 820, height: 860)) { target in
            if let model { WorkflowEditor(model: model, workflow: target.workflow) }
        }
    }
}

/// A workflow in the list: its name, its trigger in words, on or off, its last run.
struct WorkflowRow: View {
    let workflow: NativeWorkflow

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(workflow.enabled ? Vibe.mint : Vibe.muted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(workflow.name).bold()
                    AdminBadge(text: L(workflow.enabled ? "workflows.on" : "workflows.off"),
                               color: workflow.enabled ? Vibe.mint : Vibe.muted)
                }
                Text(workflow.summary).foregroundStyle(.secondary)
                Text(workflow.lastRun.map { L("workflows.last_run", ["run": $0.text]) } ?? L("workflows.never_run"))
                    .font(.caption).foregroundStyle(.secondary)
                if workflow.enabled, let next = workflow.nextFireAt {
                    Text(L("workflows.next_fire", ["at": workflowDate(next)])).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

/// One workflow's editor, as a sheet: its name and bot, its trigger, its
/// steps, then Save, Test, Disable, Delete and its runs. Saving sends the
/// whole definition at the revision it was read at; a conflict starts the
/// editor over from the version saved meanwhile.
struct WorkflowEditor: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    let model: WorkflowsModel
    /// The saved version; nil until a new one is created.
    @State private var workflow: NativeWorkflow?
    @State private var editor: WorkflowDraftEditor
    @State private var removing: Int?
    @State private var deleting = false

    init(model: WorkflowsModel, workflow: NativeWorkflow?) {
        self.model = model
        _workflow = State(initialValue: workflow)
        _editor = State(initialValue: workflow.map { WorkflowDraftEditor(workflow: $0) }
            ?? .blank(botId: model.liveBots.first?.id ?? ""))
    }

    /// Something to save: a new workflow, or a definition that differs from the saved one.
    private var changed: Bool {
        guard let workflow else { return true }
        return editor.draft != WorkflowDraftEditor(workflow: workflow).draft
    }

    private var savable: Bool {
        !model.busy && changed && !editor.name.trimmingCharacters(in: .whitespaces).isEmpty && !editor.botId.isEmpty
            && (editor.trigger.kind != "message_posted" || !editor.trigger.contains.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        SheetFrame(title: workflow?.name ?? L("workflows.new")) {
            Form {
                general
                trigger
                steps
                actions
                if let workflow { runs(workflow) }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .task { await model.loadPeople() }
        .confirmOverlay(
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            title: L("workflows.step_remove_confirm", ["n": String((removing ?? 0) + 1)]),
            message: L("workflows.step_remove_body"),
            actions: [ModalAction(title: L("workflows.step_remove"), role: .destructive) {
                if let index = removing { editor.removeStep(index) }
                removing = nil
            }]
        )
        .confirmOverlay(
            isPresented: $deleting,
            title: L("workflows.delete_confirm", ["name": workflow?.name ?? ""]),
            message: L("workflows.delete_body"),
            actions: [ModalAction(title: L("workflows.delete"), role: .destructive) {
                guard let workflow else { return }
                Task { if await model.delete(workflow) { dismiss() } }
            }]
        )
    }

    // MARK: General

    @ViewBuilder var general: some View {
        Section {
            TextField(L("workflows.name"), text: $editor.name).firstModalField()
            TextField(L("workflows.description"), text: $editor.description, axis: .vertical).lineLimit(1 ... 4)
            Picker(L("workflows.bot"), selection: $editor.botId) {
                if editor.botId.isEmpty { Text("").tag("") }
                ForEach(model.liveBots, id: \.id) { bot in
                    Text("\(bot.displayName) (@\(bot.username))").tag(bot.id)
                }
                // Its bot, deactivated meanwhile: still shown, so the picker says which.
                if let bot = workflow?.bot, bot.id == editor.botId, !model.liveBots.contains(where: { $0.id == bot.id }) {
                    Text("\(bot.displayName) (@\(bot.username))").tag(bot.id)
                }
            }
            Toggle(L("workflows.enabled"), isOn: $editor.enabled)
        }
    }

    // MARK: Trigger

    @ViewBuilder var trigger: some View {
        Section(L("workflows.trigger")) {
            Picker(L("workflows.trigger_kind"), selection: Binding(get: { editor.trigger.kind }, set: { editor.setTriggerKind($0) })) {
                ForEach(WorkflowTriggerForm.kinds, id: \.self) { kind in
                    Text(L("workflows.trigger_kind.\(kind)")).tag(kind)
                }
            }
            switch editor.trigger.kind {
            case "command":
                HStack(spacing: 2) {
                    Text("/").foregroundStyle(.secondary)
                    TextField(L("workflows.command_name"), text: $editor.trigger.name)
                }
                Text(L("workflows.command_hint")).font(.caption).foregroundStyle(.secondary)
            case "schedule":
                schedule
            case "member_joined":
                WorkflowRoomPicker(title: L("workflows.room"), selection: $editor.trigger.room, model: model, allowTrigger: false)
                Text(L("workflows.room_hint")).font(.caption).foregroundStyle(.secondary)
            case "reaction_added":
                WorkflowRoomPicker(title: L("workflows.room"), selection: $editor.trigger.room, model: model, allowTrigger: false)
                Text(L("workflows.room_hint")).font(.caption).foregroundStyle(.secondary)
                TextField(L("workflows.emoji"), text: $editor.trigger.emoji)
                Text(L("workflows.emoji_hint")).font(.caption).foregroundStyle(.secondary)
            case "message_posted":
                WorkflowRoomPicker(title: L("workflows.room"), selection: $editor.trigger.room, model: model, allowTrigger: false)
                Text(L("workflows.room_hint")).font(.caption).foregroundStyle(.secondary)
                TextField(L("workflows.contains"), text: $editor.trigger.contains)
                Text(L("workflows.contains_hint")).font(.caption).foregroundStyle(.secondary)
            default:
                webhook
            }
        }
    }

    @ViewBuilder var schedule: some View {
        Picker(L("workflows.every"), selection: $editor.trigger.every) {
            ForEach(WorkflowTriggerForm.everyKinds, id: \.self) { every in
                Text(L("workflows.every.\(every)")).tag(every)
            }
        }
        if editor.trigger.every == "hour" {
            Picker(L("workflows.minute"), selection: $editor.trigger.minute) {
                ForEach(0 ..< 60, id: \.self) { minute in Text(minute < 10 ? "0\(minute)" : "\(minute)").tag(minute) }
            }
        } else {
            LabeledContent(L("workflows.time")) {
                HStack(spacing: 4) {
                    Picker("", selection: $editor.trigger.hour) {
                        ForEach(0 ..< 24, id: \.self) { hour in Text(hour < 10 ? "0\(hour)" : "\(hour)").tag(hour) }
                    }
                    .labelsHidden()
                    .frame(width: 70)
                    Text(":")
                    Picker("", selection: $editor.trigger.minute) {
                        ForEach(0 ..< 60, id: \.self) { minute in Text(minute < 10 ? "0\(minute)" : "\(minute)").tag(minute) }
                    }
                    .labelsHidden()
                    .frame(width: 70)
                }
            }
        }
        if editor.trigger.every == "week" {
            LabeledContent(L("workflows.days")) {
                HStack(spacing: 4) {
                    ForEach(WorkflowTriggerForm.weekdays, id: \.self) { day in
                        Toggle(WorkflowTriggerForm.dayName(day), isOn: Binding(
                            get: { editor.trigger.days.contains(day) },
                            set: { _ in editor.trigger.toggleDay(day) }
                        ))
                        .toggleStyle(.button)
                    }
                }
            }
        }
        TextField(L("workflows.timezone"), text: $editor.trigger.timezone)
        Text(L("workflows.timezone_hint")).font(.caption).foregroundStyle(.secondary)
        WorkflowRoomPicker(title: L("workflows.room"), selection: $editor.trigger.room, model: model, allowTrigger: false)
        Text(L("workflows.room_hint")).font(.caption).foregroundStyle(.secondary)
    }

    /// A webhook's URL is made once the workflow is saved, and shown once.
    @ViewBuilder var webhook: some View {
        if let workflow {
            if workflow.hasWebhook { Text(L("workflows.webhook_exists")).foregroundStyle(.secondary) }
            HStack {
                Button(L(workflow.hasWebhook ? "workflows.webhook_regenerate" : "workflows.webhook_generate")) {
                    Task {
                        if await model.generateWebhook(workflow), let fresh = model.workflow(workflow.id) {
                            self.workflow = fresh
                        }
                    }
                }
                .disabled(model.busy)
                if model.needsReauth && app.native?.securitySupported() == true {
                    Button(L("security.verify")) { app.settingsCategory = .security; dismiss() }
                }
            }
        } else {
            Text(L("workflows.webhook_save_first")).foregroundStyle(.secondary)
        }
    }

    // MARK: Steps

    @ViewBuilder var steps: some View {
        Section(L("workflows.steps")) {
            if editor.steps.isEmpty { Text(L("workflows.no_steps")).foregroundStyle(.secondary) }
            ForEach(Array(editor.steps.enumerated()), id: \.element.id) { index, step in
                WorkflowStepEditor(
                    index: index,
                    count: editor.steps.count,
                    step: stepBinding(step.id),
                    trigger: editor.trigger,
                    variables: editor.variables(index),
                    model: model,
                    insert: { variable in
                        if let at = editor.steps.firstIndex(where: { $0.id == step.id }) {
                            editor.insertVariable(variable, step: at)
                        }
                    },
                    move: { offset in
                        if let at = editor.steps.firstIndex(where: { $0.id == step.id }) { editor.moveStep(at, by: offset) }
                    },
                    remove: { removing = editor.steps.firstIndex(where: { $0.id == step.id }) }
                )
            }
            Menu(L("workflows.add_step")) {
                ForEach(WorkflowStepForm.kinds, id: \.self) { kind in
                    Button(L("workflows.step.\(kind)")) { editor.addStep(kind) }
                }
            }
            .fixedSize()
            Text(L("workflows.variables_hint")).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// A step by its identity, so a binding never points at another one once
    /// the steps moved or one was removed.
    private func stepBinding(_ id: UUID) -> Binding<WorkflowStepForm> {
        Binding(
            get: { editor.steps.first { $0.id == id } ?? WorkflowStepForm(.wait(seconds: 60), id: id) },
            set: { fresh in
                if let at = editor.steps.firstIndex(where: { $0.id == id }) { editor.steps[at] = fresh }
            }
        )
    }

    // MARK: Actions

    @ViewBuilder var actions: some View {
        Section {
            if let notice = model.notice { Text(notice).foregroundStyle(.secondary) }
            HStack {
                Button(L("workflows.save"), action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!savable)
                if let workflow {
                    Button(L("workflows.test")) {
                        Task { await model.test(workflow) }
                    }
                    .disabled(model.busy || changed)
                    if workflow.enabled {
                        Button(L("workflows.disable")) {
                            Task {
                                if let off = await model.disable(workflow) {
                                    self.workflow = off
                                    editor.enabled = off.enabled
                                }
                            }
                        }
                        .disabled(model.busy)
                    }
                    Spacer()
                    Button(L("workflows.delete"), role: .destructive) { deleting = true }
                        .foregroundStyle(.red)
                        .disabled(model.busy)
                }
            }
        }
    }

    func save() {
        let current = editor
        Task {
            if let workflow {
                switch await model.save(workflow, current) {
                case let .saved(fresh), let .conflict(fresh):
                    self.workflow = fresh
                    editor = WorkflowDraftEditor(workflow: fresh)
                case .failed:
                    break
                }
            } else if let made = await model.create(current) {
                workflow = made
                editor = WorkflowDraftEditor(workflow: made)
            }
        }
    }

    // MARK: Runs

    @ViewBuilder func runs(_ workflow: NativeWorkflow) -> some View {
        Section {
            if let runs = model.runs[workflow.id] {
                if runs.isEmpty { Text(L("workflows.no_runs")).foregroundStyle(.secondary) }
                ForEach(runs, id: \.id) { run in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(run.text).foregroundStyle(run.state == "failed" ? Color.red : Vibe.text)
                        Text(workflowDate(run.createdAt)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            HStack {
                Text(L("workflows.runs"))
                Spacer()
                Button(L("security.refresh")) { Task { await model.loadRuns(workflow) } }
                    .buttonStyle(.borderless)
            }
        }
        .task(id: workflow.id) { await model.loadRuns(workflow) }
    }
}

/// A room a trigger or a step names: the plaintext rooms the bot may reach,
/// "the trigger's room" where the trigger has one, or none chosen.
struct WorkflowRoomPicker: View {
    let title: String
    @Binding var selection: String
    let model: WorkflowsModel
    let allowTrigger: Bool

    var body: some View {
        Picker(title, selection: $selection) {
            Text(L("workflows.room_none")).tag("")
            if allowTrigger || selection == "trigger" {
                Text(L("workflows.room_trigger")).tag("trigger")
            }
            ForEach(model.rooms, id: \.id) { room in
                Text(room.label).tag(room.id)
            }
            // A room no longer offered (left, encrypted since): still named.
            if !selection.isEmpty, selection != "trigger", !model.rooms.contains(where: { $0.id == selection }) {
                Text(model.roomLabel(selection)).tag(selection)
            }
        }
    }
}

/// One step: its number and kind, its variables, moving and removing it,
/// then its kind's settings.
struct WorkflowStepEditor: View {
    let index: Int
    let count: Int
    @Binding var step: WorkflowStepForm
    let trigger: WorkflowTriggerForm
    let variables: [String]
    let model: WorkflowsModel
    let insert: (String) -> Void
    let move: (Int) -> Void
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(L("workflows.step_number", ["n": String(index + 1)])).font(.headline)
                Text(L("workflows.step.\(step.kind)")).foregroundStyle(.secondary)
                Spacer()
                if step.template != nil {
                    Menu(L("workflows.variables")) {
                        if variables.isEmpty { Text(L("workflows.no_variables")) }
                        ForEach(variables, id: \.self) { variable in
                            Button(variable) { insert(variable) }
                        }
                    }
                    .fixedSize()
                }
                Button { move(-1) } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(.borderless)
                    .help(L("workflows.move_up"))
                    .disabled(index == 0)
                Button { move(1) } label: { Image(systemName: "arrow.down") }
                    .buttonStyle(.borderless)
                    .help(L("workflows.move_down"))
                    .disabled(index >= count - 1)
                Button(action: remove) { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
                    .help(L("workflows.step_remove"))
            }
            switch step.kind {
            case "message": message
            case "wait": wait
            case "http": http
            default: form
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder var message: some View {
        WorkflowRoomPicker(title: L("workflows.room"), selection: $step.room, model: model, allowTrigger: trigger.hasRoom)
        Text(L("workflows.text"))
        WorkflowTextEditor(text: $step.text)
        Toggle(L("workflows.in_thread"), isOn: $step.inThread)
        saveAs
    }

    @ViewBuilder var wait: some View {
        LabeledContent(L("workflows.wait_for")) {
            HStack(spacing: 6) {
                TextField("", value: $step.waitValue, format: IntegerFormatStyle<UInt64>())
                    .labelsHidden()
                    .frame(width: 80)
                Picker("", selection: $step.waitUnit) {
                    ForEach(WorkflowStepForm.waitUnits, id: \.self) { unit in
                        Text(WorkflowStepForm.unitName(unit)).tag(unit)
                    }
                }
                .labelsHidden()
                .frame(width: 140)
            }
        }
    }

    @ViewBuilder var http: some View {
        Picker(L("workflows.method"), selection: $step.method) {
            ForEach(WorkflowStepForm.methods, id: \.self) { method in Text(method).tag(method) }
        }
        TextField(L("workflows.url"), text: $step.url)
        Text(L("workflows.headers"))
        ForEach(Array(step.headers.indices), id: \.self) { header in
            HStack {
                TextField(L("workflows.header_name"), text: headerBinding(header, \.name))
                TextField(L("workflows.header_value"), text: headerBinding(header, \.value))
                Button { step.removeHeader(header) } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.borderless)
                    .help(L("workflows.header_remove"))
            }
        }
        Button(L("workflows.header_add")) { step.addHeader() }
            .disabled(step.headers.count >= 10)
        Text(L("workflows.body"))
        WorkflowTextEditor(text: $step.body)
        saveAs
        Toggle(L("workflows.continue_on_error"), isOn: $step.continueOnError)
    }

    @ViewBuilder var form: some View {
        WorkflowRoomPicker(title: L("workflows.room"), selection: $step.room, model: model, allowTrigger: trigger.hasRoom)
        Picker(L("workflows.recipient"), selection: $step.recipient) {
            ForEach(WorkflowStepForm.recipients, id: \.self) { recipient in
                if recipient != "trigger_user" || trigger.hasUser || step.recipient == recipient {
                    Text(L("workflows.recipient.\(recipient)")).tag(recipient)
                }
            }
        }
        TextField(L("workflows.form_title"), text: $step.title)
        Text(L("workflows.fields"))
        ForEach(Array(step.fields.indices), id: \.self) { field in
            WorkflowFieldEditor(step: $step, index: field, people: model.people)
        }
        Button(L("workflows.field_add")) { step.addField() }
            .disabled(step.fields.count >= 10)
        saveAs
    }

    @ViewBuilder var saveAs: some View {
        TextField(L("workflows.save_as"), text: $step.saveAs)
        Text(L("workflows.save_as_hint")).font(.caption).foregroundStyle(.secondary)
    }

    private func headerBinding(_ index: Int, _ path: WritableKeyPath<NativeHttpHeader, String>) -> Binding<String> {
        Binding(
            get: { step.headers.indices.contains(index) ? step.headers[index][keyPath: path] : "" },
            set: { value in if step.headers.indices.contains(index) { step.headers[index][keyPath: path] = value } }
        )
    }
}

/// A form's field: its label (a new field's id follows it), kind, options, whether required.
struct WorkflowFieldEditor: View {
    @Binding var step: WorkflowStepForm
    let index: Int
    /// The people a person field may list, for their names and the picker.
    let people: [NativeWorkflowUser]

    var body: some View {
        if step.fields.indices.contains(index) {
            let field = step.fields[index]
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    TextField(L("workflows.field_label"), text: Binding(
                        get: { step.fields.indices.contains(index) ? step.fields[index].label : "" },
                        set: { step.setFieldLabel(index, $0) }
                    ))
                    Picker("", selection: Binding(
                        get: { step.fields.indices.contains(index) ? step.fields[index].kind : "text" },
                        set: { kind in if step.fields.indices.contains(index) { step.fields[index].setKind(kind) } }
                    )) {
                        ForEach(WorkflowFieldForm.kinds, id: \.self) { kind in Text(L("workflows.field.\(kind)")).tag(kind) }
                    }
                    .labelsHidden()
                    .frame(width: 150)
                    Toggle(L("workflows.field_required"), isOn: fieldBinding(\.required))
                    Button { step.removeField(index) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .help(L("workflows.field_remove"))
                        .disabled(step.fields.count <= 1)
                }
                if field.kind == "choice" {
                    TextField(L("workflows.field_options"), text: fieldBinding(\.options))
                }
                if field.kind == "person" {
                    WorkflowPeopleEditor(field: Binding(
                        get: { step.fields.indices.contains(index) ? step.fields[index] : Self.gone },
                        set: { value in if step.fields.indices.contains(index) { step.fields[index] = value } }
                    ), people: people)
                }
                Text(L("workflows.field_id", ["id": field.id]))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 12)
        }
    }

    /// What a binding reads once its field was removed, until the row goes.
    private static let gone = WorkflowFieldForm(NativeFormField(id: "", label: "", kind: "text", options: [], people: [], required: false))

    private func fieldBinding<T>(_ path: WritableKeyPath<WorkflowFieldForm, T>) -> Binding<T> {
        Binding(
            get: { (step.fields.indices.contains(index) ? step.fields[index] : Self.gone)[keyPath: path] },
            set: { value in if step.fields.indices.contains(index) { step.fields[index][keyPath: path] = value } }
        )
    }
}

/// A person field's people: any member of the form's room, or these people,
/// each removable, and a search to add one more (50 at most).
struct WorkflowPeopleEditor: View {
    @Binding var field: WorkflowFieldForm
    let people: [NativeWorkflowUser]
    @State private var search = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("", selection: Binding(get: { field.choosesPeople }, set: { field.setChoosesPeople($0) })) {
                Text(L("workflows.people_any")).tag(false)
                Text(L("workflows.people_these")).tag(true)
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            if field.choosesPeople {
                ForEach(field.people, id: \.self) { id in
                    HStack {
                        Image(systemName: "person").foregroundStyle(.secondary)
                        Text(workflowPersonName(id, in: people))
                        Spacer()
                        Button { field.removePerson(id) } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless)
                            .help(L("workflows.people_remove"))
                    }
                }
                if field.peopleFull {
                    Text(L("workflows.people_limit")).font(.caption).foregroundStyle(.secondary)
                } else {
                    let matching = workflowPeopleMatching(people, search, excluding: field.people)
                    HStack {
                        TextField(L("workflows.people_search"), text: $search)
                        Menu(L("workflows.people_add")) {
                            if matching.isEmpty { Text(L("workflows.people_none")) }
                            ForEach(matching.prefix(50), id: \.id) { person in
                                Button(workflowPersonName(person)) {
                                    if field.addPerson(person.id) { search = "" }
                                }
                            }
                        }
                        .fixedSize()
                    }
                }
            }
        }
    }
}

/// A template's text: a few lines, monospaced, growing with it.
struct WorkflowTextEditor: View {
    @Binding var text: String

    var body: some View {
        TextEditor(text: $text)
            .font(.system(.body, design: .monospaced))
            .frame(minHeight: 70, maxHeight: 180)
            .scrollContentBackground(.hidden)
            .padding(4)
            .background(Vibe.deep, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Vibe.line))
    }
}

/// The webhook URL, once: copy it now. It lives only in
/// `AppModel.workflowWebhook` until this closes; the window shows it
/// (`RootView`), the settings closed or not.
struct WorkflowWebhookSheet: View {
    let url: String
    @State private var copied = false

    var body: some View {
        SheetFrame(title: L("workflows.webhook_title")) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L("workflows.webhook_once")).bold().foregroundStyle(Vibe.sun)
                HStack(alignment: .top) {
                    Text(url).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(L(copied ? "actions.copied" : "actions.copy")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(url, forType: .string)
                        copied = true
                    }
                }
            }
            .padding(18)
        }
    }
}

/// An RFC 3339 date as the runs list shows one.
func workflowDate(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let parsed = formatter.date(from: value)
    formatter.formatOptions = [.withInternetDateTime]
    return (parsed ?? formatter.date(from: value))?.formatted(date: .abbreviated, time: .shortened) ?? value
}
