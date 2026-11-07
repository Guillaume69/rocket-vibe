import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A room's notes beside its conversation: rendered like messages, edited as
/// markdown with a formatting bar, saved whole against the revision the edit
/// started from. An edit left unsaved comes back when the pane reopens.
struct NotesView: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State var base = ""
    @State var selection: TextSelection?
    @State var notes: RoomNotes?
    @State var failed = false
    @State var editing = false
    @State var draft = ""
    @State var saving = false
    @State var notice: String?

    var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(L("notes.title")).font(.headline)
                    Spacer()
                    Button { app.toggleNotes() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .help(L("notes.close"))
                }
                .padding(12)
                Divider()
                if editing {
                    NotesFormatBar(blocksOnly: notes?.blocksOnly == true) { apply($0) }
                    Divider()
                    TextEditor(text: $draft, selection: $selection)
                        .font(.system(.body, design: .monospaced))
                        .padding(8)
                } else if let notes {
                    ScrollView {
                        if notes.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(L("notes.empty")).foregroundStyle(.secondary).padding(16)
                        } else {
                            BodyView(blocks: notes.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                        }
                    }
                } else if failed {
                    Text(L("notes.load_failed")).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let notice {
                    Text(notice).font(.caption).foregroundStyle(.orange).padding(.horizontal, 14).padding(.top, 6)
                }
                Divider().padding(.top, 6)
                HStack {
                    if let notes, let by = notes.updatedBy, let at = notes.updatedAtMs, !editing {
                        Text(L("notes.edited", ["name": by, "time": Formatting.shortTime(at)]))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if editing {
                        Button(L("notes.cancel")) { editing = false; notice = nil }
                        Button(L("notes.save")) { Task { await save() } }
                            .keyboardShortcut(.defaultAction)
                            .disabled(saving)
                    } else if notes?.editable == true {
                        Button(L("notes.edit")) {
                            draft = notes?.markdown ?? ""
                            base = notes?.revision ?? ""
                            notice = nil
                            editing = true
                        }
                    }
                }
                .padding(12)
            }
        .onAppear {
            let key = app.notesDraftKey(model.rid)
            if let kept = app.notesDrafts.removeValue(forKey: key) {
                draft = kept.text
                base = kept.revision
                editing = true
            }
        }
        .onDisappear {
            if editing {
                app.notesDrafts[app.notesDraftKey(model.rid)] = NotesDraft(text: draft, revision: base)
            }
        }
        .task { await load() }
        // A save elsewhere publishes the room; while shown, read again now and then.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if !editing { await load() }
            }
        }
    }

    func load() async {
        do {
            notes = try await model.roomNotes()
            failed = false
        } catch {
            if notes == nil { failed = true }
        }
    }

    func save() async {
        saving = true
        defer { saving = false }
        do {
            notes = try await model.saveRoomNotes(markdown: draft, revision: base)
            editing = false
            notice = nil
        } catch let RvError.Server(_, _, code, _, _, _) where code == "revision_conflict" {
            // The draft stays; the next save goes over the newer version.
            await load()
            if let revision = notes?.revision { base = revision }
            notice = L("notes.conflict")
        } catch let RvError.Server(_, _, code, _, _, _) where code == "notes_structure" {
            notice = L("notes.structure")
        } catch {
            notice = L("notes.save_failed")
        }
    }

    /// Applies a format to the selection, which stays selected, in Unicode scalars like the core.
    func apply(_ format: NotesFormat) {
        let scalars = draft.unicodeScalars
        var start = scalars.count, end = scalars.count
        if case let .selection(range)? = selection?.indices {
            start = scalars.distance(from: scalars.startIndex, to: range.lowerBound)
            end = scalars.distance(from: scalars.startIndex, to: range.upperBound)
        }
        let edited = formatNotes(text: draft, start: UInt32(start), end: UInt32(end), format: format)
        draft = edited.text
        let out = draft.unicodeScalars
        let from = out.index(out.startIndex, offsetBy: Int(edited.start))
        let to = out.index(out.startIndex, offsetBy: Int(edited.end))
        selection = TextSelection(range: from..<to)
    }
}

/// The notes editor's bar, in the composer toolbars' order; a provider without
/// inline marks offers blocks only.
struct NotesFormatBar: View {
    let blocksOnly: Bool
    let apply: (NotesFormat) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                if !blocksOnly {
                    item("format.bold", .bold, Text("B").bold())
                    item("format.italic", .italic, Text("I").italic())
                    item("format.strike", .strike, Text("S").strikethrough())
                    Divider().frame(height: 16)
                }
                item("format.heading", .heading, Text("H"))
                if !blocksOnly {
                    item("format.link", .link, Text(Image(systemName: "link")))
                    item("format.code", .code, Text("</>"))
                }
                item("format.code_block", .codeBlock, Text("{ }"))
                Divider().frame(height: 16)
                item("format.quote", .quote, Text("“"))
                item("format.bullets", .bullets, Text(Image(systemName: "list.bullet")))
                item("format.numbers", .numbers, Text(Image(systemName: "list.number")))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
    }

    func item(_ key: String, _ format: NotesFormat, _ label: Text) -> some View {
        Button { apply(format) } label: { label.frame(minWidth: 24, minHeight: 22) }
            .buttonStyle(.borderless)
            .help(L(key))
            .accessibilityLabel(L(key))
    }
}
