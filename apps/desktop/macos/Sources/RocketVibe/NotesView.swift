import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// A room's notes: rendered like messages, edited as markdown and saved whole
/// against the revision they were read at.
struct NotesView: View {
    let model: RoomModel
    @State var notes: RoomNotes?
    @State var failed = false
    @State var editing = false
    @State var draft = ""
    @State var saving = false
    @State var notice: String?

    var body: some View {
        SheetFrame(title: L("notes.title")) {
            VStack(alignment: .leading, spacing: 0) {
                if editing {
                    TextEditor(text: $draft)
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
                            notice = nil
                            editing = true
                        }
                    }
                }
                .padding(12)
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
        guard let revision = notes?.revision else { return }
        saving = true
        defer { saving = false }
        do {
            notes = try await model.saveRoomNotes(markdown: draft, revision: revision)
            editing = false
            notice = nil
        } catch let RvError.Server(_, _, code, _, _, _) where code == "revision_conflict" {
            // The draft stays; the next save goes over the newer version.
            await load()
            notice = L("notes.conflict")
        } catch {
            notice = L("notes.save_failed")
        }
    }
}
