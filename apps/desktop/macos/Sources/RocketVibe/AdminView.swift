import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The server administration over the window, in the settings' panel: the
/// Dashboard, the Moderation of reports (its count as a badge), the Rooms and
/// the Users (`AdminModel`, the GTK app's `admin.rs`).
struct AdminOverlay: View {
    @Environment(AppModel.self) var app
    let model: AdminModel

    var body: some View {
        PanelOverlay(close: { app.closeAdmin() }) { singlePane in
            AdminView(model: model, singlePane: singlePane)
        }
    }
}

extension AdminCategory {
    var symbol: String {
        switch self {
        case .dashboard: return "speedometer"
        case .moderation: return "exclamationmark.bubble"
        case .rooms: return "number"
        case .users: return "person.2"
        }
    }
}

/// An action asked before it is taken.
struct AdminConfirm: Identifiable {
    let id = UUID()
    let title: String
    let body: String
    let action: String
    let run: () async -> Void
}

struct AdminView: View {
    @Environment(AppModel.self) var app
    @Environment(ModalCenter.self) var modals
    let model: AdminModel
    let singlePane: Bool
    /// One pane: the page shows instead of the list.
    @State private var paging = false
    @State private var confirming: AdminConfirm?
    @FocusState private var listFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if model.detail != nil || (singlePane && paging) {
                    Button { back() } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(.borderless)
                        .help(L("nav.back"))
                }
                Text(singlePane && !paging && model.detail == nil ? L("admin.title") : model.category.title)
                    .font(.vibeTitle(18, .bold))
                Spacer()
                Button { app.closeAdmin() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    // Escape belongs to a modal opened over the panel, when there is one.
                    .keyboardShortcut(modals.isEmpty ? .cancelAction : nil)
            }
            .padding(14)
            Divider()
            HStack(spacing: 0) {
                if !singlePane {
                    sidebar.frame(width: 230)
                    Divider()
                    page
                } else if paging || model.detail != nil {
                    page
                } else {
                    sidebar
                }
            }
        }
        .overlay(alignment: .bottom) { toast }
        .onAppear { listFocused = true }
        // Rocket.Chat's second question (rooms a last owner leaves, a bulk delete).
        .confirmOverlay(
            isPresented: Binding(get: { model.followUp != nil }, set: { if !$0 { model.dismissFollowUp() } }),
            title: model.followUp?.title ?? "",
            message: model.followUp?.message,
            actions: model.followUp.map { followUp in
                [ModalAction(title: followUp.action, role: .destructive) { Task { await model.confirmFollowUp(followUp) } }]
            } ?? []
        )
        .confirmOverlay(
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            title: confirming?.title ?? "",
            message: confirming?.body,
            actions: confirming.map { confirm in
                [ModalAction(title: confirm.action, role: .destructive) { Task { await confirm.run() } }]
            } ?? []
        )
    }

    func back() {
        if model.detail != nil { model.closeDetail() } else { paging = false }
    }

    var sidebar: some View {
        // One pane: nothing selected, so a click on any category opens it.
        let selection = Binding<AdminCategory?>(get: { singlePane ? nil : model.category }, set: { picked in
            guard let picked else { return }
            model.show(picked)
            paging = true
        })
        return List(selection: selection) {
            ForEach(AdminCategory.allCases) { category in
                Label(category.title, systemImage: category.symbol)
                    .badge(category == .moderation ? Int(clamping: model.reportCount) : 0)
                    .tag(category)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .focused($listFocused)
        .background(Vibe.deep)
    }

    @ViewBuilder var page: some View {
        Group {
            if let detail = model.detail {
                Form { detailSections(detail) }
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
            } else {
                switch model.category {
                case .dashboard:
                    AdminDashboard(model: model)
                case .moderation:
                    Form { moderation }
                        .formStyle(.grouped)
                        .scrollContentBackground(.hidden)
                case .rooms:
                    AdminSearch(list: model.rooms, placeholder: L("admin.search_rooms")) { room in AdminRoomRow(room: room) }
                case .users:
                    AdminSearch(list: model.users, placeholder: L("admin.search_users")) { user in
                        Button { model.open(.user(user)) } label: { AdminUserRow(user: user) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder var moderation: some View {
        Section(L("admin.reported_messages")) {
            AdminListRows(list: model.reportedMessages, empty: L("admin.nothing_reported")) { item in
                Button { model.open(.message(item)) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.text(item)).lineLimit(2)
                            Text("\(item.author.shown) · \(L("admin.in_room", ["room": item.roomName])) · \(L("admin.reports_count", count: Int(clamping: item.count)))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(Vibe.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        Section(L("admin.reported_users")) {
            AdminListRows(list: model.reportedUsers, empty: L("admin.nothing_reported")) { item in
                Button { model.open(.reportedUser(item)) } label: {
                    HStack(spacing: 10) {
                        Avatar(path: item.user.avatar, name: item.user.username, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.user.name.isEmpty ? item.user.username : item.user.name)
                            Text("@\(item.user.username) · \(L("admin.reports_count", count: Int(clamping: item.count)))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(Vibe.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder func detailSections(_ detail: AdminDetail) -> some View {
        switch detail {
        case let .user(user):
            AdminPerson(user: user)
            Section {
                if model.isMe(user) {
                    Text(L("admin.yourself")).foregroundStyle(.secondary)
                } else {
                    Button(L(user.admin ? "admin.remove_admin" : "admin.make_admin")) {
                        Task { await model.setAdmin(user, !user.admin) }
                    }
                    Button(L(user.active ? "admin.deactivate" : "admin.activate"), role: user.active ? .destructive : nil) {
                        if user.active {
                            confirming = AdminConfirm(title: L("admin.deactivate"), body: L("admin.deactivate_body"), action: L("admin.deactivate")) {
                                await model.setActive(user, false)
                            }
                        } else {
                            Task { await model.setActive(user, true) }
                        }
                    }
                    Button(L("admin.delete_user"), role: .destructive) {
                        confirming = AdminConfirm(title: L("admin.delete_user"), body: model.deleteUserBody, action: L("actions.delete")) {
                            await model.delete(user)
                        }
                    }
                }
            }
            .disabled(model.busy)
        case let .message(item):
            Section(L("admin.message")) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.text(item)).textSelection(.enabled)
                    Text("\(item.author.shown) · \(L("admin.in_room", ["room": item.roomName])) · \(AdminText.date(item.createdAt))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            reasons
            Section {
                Button(L("admin.dismiss")) { Task { await model.dismiss(item) } }
                if model.canDeleteMessage(item) {
                    Button(L("admin.delete_message"), role: .destructive) {
                        confirming = AdminConfirm(title: L("admin.delete_message"), body: L("admin.delete_message_body"), action: L("actions.delete")) {
                            await model.delete(item)
                        }
                    }
                }
                if model.canDeactivateAuthor(item) {
                    Button(L("admin.deactivate_author"), role: .destructive) {
                        confirming = AdminConfirm(title: L("admin.deactivate_author"), body: L("admin.deactivate_body"), action: L("admin.deactivate")) {
                            await model.deactivateAuthor(item)
                        }
                    }
                }
            }
            .disabled(model.busy)
        case let .reportedUser(item):
            AdminPerson(user: item.user)
            reasons
            Section {
                Button(L("admin.dismiss")) { Task { await model.dismiss(item) } }
                if model.canDeactivate(item) {
                    Button(L("admin.deactivate"), role: .destructive) {
                        confirming = AdminConfirm(title: L("admin.deactivate"), body: L("admin.deactivate_body"), action: L("admin.deactivate")) {
                            await model.deactivate(item)
                        }
                    }
                }
            }
            .disabled(model.busy)
        }
    }

    /// Who reported and why, read when the item opened.
    var reasons: some View {
        Section(L("admin.reasons")) {
            if let reasons = model.reasons {
                ForEach(Array(reasons.enumerated()), id: \.offset) { _, report in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(report.reason).textSelection(.enabled)
                        Text("\(L("admin.reported_by", ["name": report.reporter.shown])) · \(AdminText.date(report.at))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if let error = model.reasonsError {
                Text(error).foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    /// The panel's toast: "Done", or why not.
    @ViewBuilder var toast: some View {
        if let notice = model.notice {
            Text(notice)
                .font(.vibe(13.5, .bold))
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(Vibe.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(Vibe.pink.opacity(0.45)))
                .padding(.bottom, 18)
                .task(id: notice) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if model.notice == notice { model.notice = nil }
                }
        }
    }
}

/// A list's rows, then its state: loading, empty, failed, or "Show more".
struct AdminListRows<Item, Row: View>: View {
    let list: AdminList<Item>
    let empty: String
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        ForEach(Array(list.items.enumerated()), id: \.offset) { _, item in
            row(item)
        }
        if let error = list.error {
            Text(error).foregroundStyle(.secondary)
        } else if list.loaded && list.items.isEmpty {
            Text(empty).foregroundStyle(.secondary)
        }
        if list.loading {
            ProgressView().controlSize(.small)
        } else if list.next != nil {
            Button(L("admin.load_more")) { list.more() }
        }
    }
}

/// A searchable list: the field, then the rows reloaded as one types.
struct AdminSearch<Item, Row: View>: View {
    let list: AdminList<Item>
    let placeholder: String
    @ViewBuilder let row: (Item) -> Row
    @State private var text = ""

    var body: some View {
        VStack(spacing: 0) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .onChange(of: text) { _, value in list.search(value) }
            Form {
                Section {
                    AdminListRows(list: list, empty: L("admin.empty"), row: row)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .onAppear { text = list.query }
    }
}

struct AdminBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.vibe(11, .heavy))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .overlay(Capsule().strokeBorder(color.opacity(0.7)))
    }
}

struct AdminUserRow: View {
    let user: AdminUser

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(path: user.avatar, name: user.username, size: 32)
                PresenceDot(presence: user.status)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(user.name.isEmpty ? user.username : user.name).font(.vibe(13.5, .bold))
                Text(details).font(.vibe(11.5)).foregroundStyle(Vibe.muted)
            }
            Spacer()
            if user.admin { AdminBadge(text: L("admin.badge_admin"), color: Vibe.pink) }
            if !user.active { AdminBadge(text: L("admin.badge_deactivated"), color: Vibe.muted) }
            if user.bot { AdminBadge(text: L("admin.badge_bot"), color: Vibe.sky) }
            Image(systemName: "chevron.right").foregroundStyle(Vibe.faint)
        }
        .contentShape(Rectangle())
    }

    var details: String {
        var parts = ["@\(user.username)", L("presence.\(PresenceDot(presence: user.status).key)")]
        if let seen = user.lastSeenAt { parts.append(L("admin.last_seen", ["date": AdminText.date(seen)])) }
        return parts.joined(separator: " · ")
    }
}

struct AdminRoomRow: View {
    let room: AdminRoom

    var body: some View {
        HStack(spacing: 10) {
            Text(glyph)
                .font(.vibeTitle(15, .bold))
                .foregroundStyle(Vibe.ink)
                .frame(width: 32, height: 32)
                .background(LinearGradient(colors: Vibe.tile(for: room.name), startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text(room.name).font(.vibe(13.5, .bold)).lineLimit(1)
                Text(details).font(.vibe(11.5)).foregroundStyle(Vibe.muted)
            }
            Spacer()
            if room.readOnly { AdminBadge(text: L("admin.badge_read_only"), color: Vibe.sun) }
            if room.encrypted { AdminBadge(text: L("admin.badge_encrypted"), color: Vibe.mint) }
        }
    }

    var glyph: String {
        switch room.kind {
        case .public: return "#"
        case .private: return "🔒"
        case .direct: return String(room.name.prefix(1)).uppercased()
        case .discussion: return "💬"
        }
    }

    var details: String {
        var parts = [L("admin.members", count: Int(clamping: room.members)), L("admin.message_count", count: Int(clamping: room.messages))]
        if let created = room.createdAt { parts.append(L("admin.created", ["date": AdminText.date(created)])) }
        return parts.joined(separator: " · ")
    }
}

/// Photo, name, @username, presence and dates of an account.
struct AdminPerson: View {
    let user: AdminUser

    var body: some View {
        Section {
            HStack(spacing: 12) {
                Avatar(path: user.avatar, name: user.username, size: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name.isEmpty ? user.username : user.name).font(.title3.bold())
                    Text("@\(user.username)").foregroundStyle(.secondary)
                }
            }
            LabeledContent(L("settings.presence")) {
                HStack(spacing: 6) {
                    PresenceDot(presence: user.status)
                    Text(L("presence.\(PresenceDot(presence: user.status).key)"))
                }
            }
            if let created = user.createdAt { LabeledContent(L("admin.created_label"), value: AdminText.date(created)) }
            if let seen = user.lastSeenAt { LabeledContent(L("admin.last_seen_label"), value: AdminText.date(seen)) }
        }
    }
}

/// The overview's cards, two abreast when the panel is wide enough.
struct AdminDashboard: View {
    let model: AdminModel

    var body: some View {
        ScrollView {
            if let o = model.overview {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 520), spacing: 20, alignment: .top)], alignment: .leading, spacing: 20) {
                    AdminCard(title: L("admin.deployment"), refresh: { Task { await model.refreshOverview(refresh: true) } }) {
                        // Rocket.Chat's figures are a snapshot; the button counts them again.
                        if let asOf = model.asOf { Text(asOf).font(.vibe(11.5)).foregroundStyle(Vibe.muted) }
                        AdminValue(title: L("admin.version"), value: o.version, note: model.updateNote)
                        if let uptime = o.uptimeSeconds { AdminValue(title: L("admin.uptime"), value: AdminText.duration(uptime)) }
                        AdminValue(title: L("admin.database"), value: o.database)
                        if let migration = o.migration { AdminValue(title: L("admin.migration"), value: migration) }
                        if let runtime = o.runtime { AdminValue(title: L("admin.runtime"), value: runtime) }
                        if let instance = o.instanceId { AdminValue(title: L("admin.instance"), value: instance) }
                    }
                    AdminCard(title: L("admin.cat.users")) {
                        AdminValue(title: L("admin.total"), value: String(o.users.total))
                        AdminValue(title: L("admin.active"), value: String(o.users.active))
                        AdminValue(title: L("admin.deactivated"), value: String(o.users.deactivated))
                        if let admins = o.users.admins { AdminValue(title: L("admin.admins"), value: String(admins)) }
                        let presences: [(Presence, UInt64)] = [(.online, o.users.online), (.away, o.users.away), (.busy, o.users.busy), (.offline, o.users.offline)]
                        ForEach(Array(presences.enumerated()), id: \.offset) { _, row in
                            HStack(spacing: 6) {
                                PresenceDot(presence: row.0)
                                AdminValue(title: L("presence.\(PresenceDot(presence: row.0).key)"), value: String(row.1))
                            }
                        }
                    }
                    AdminKinds(title: L("admin.cat.rooms"), counts: o.rooms)
                    AdminKinds(title: L("admin.messages"), counts: o.messages)
                    AdminCard(title: L("admin.uploads")) {
                        AdminValue(title: L("admin.uploads_count"), value: String(o.uploadsCount))
                        AdminValue(title: L("admin.uploads_size"), value: ByteCountFormatter.string(fromByteCount: Int64(clamping: o.uploadsBytes), countStyle: .file))
                    }
                    AdminCard(title: L("admin.reports")) {
                        AdminValue(title: L("admin.reported_messages"), value: AdminText.figure(o.reportedMessages))
                        AdminValue(title: L("admin.reported_users"), value: AdminText.figure(o.reportedUsers))
                        Button(L("admin.open_moderation")) { model.show(.moderation) }
                    }
                    // RocketVibe with bots only: the model leaves it nil elsewhere.
                    if let on = model.userBots {
                        AdminCard(title: L("admin.bots")) {
                            Toggle(isOn: Binding(get: { on }, set: { value in Task { await model.setUserBots(value) } })) {
                                Text(L("admin.user_bots"))
                                Text(L("admin.user_bots_hint"))
                            }
                            .disabled(model.settingUserBots)
                        }
                    }
                }
                .padding(20)
            } else if let error = model.overviewError {
                VStack(spacing: 10) {
                    Text(error).foregroundStyle(.secondary)
                    Button(L("security.refresh")) { Task { await model.refreshOverview(refresh: false) } }
                }
                .padding(40)
            } else {
                ProgressView().padding(40)
            }
        }
    }
}

struct AdminCard<Content: View>: View {
    let title: String
    var refresh: (() -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.vibe(11.5, .heavy)).textCase(.uppercase).foregroundStyle(Vibe.muted)
                Spacer()
                if let refresh {
                    Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help(L("admin.refresh_figures"))
                }
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vibeCard()
    }
}

struct AdminKinds: View {
    let title: String
    let counts: AdminKindCounts

    var body: some View {
        AdminCard(title: title) {
            AdminValue(title: L("admin.total"), value: String(counts.total))
            AdminValue(title: L("admin.public"), value: String(counts.public))
            AdminValue(title: L("admin.private"), value: String(counts.private))
            AdminValue(title: L("admin.direct"), value: String(counts.direct))
            if let discussions = counts.discussions { AdminValue(title: L("admin.discussions"), value: String(discussions)) }
            if let encrypted = counts.encrypted { AdminValue(title: L("admin.encrypted"), value: String(encrypted)) }
        }
    }
}

/// One line of a card: what, then how much; an optional note before the value.
struct AdminValue: View {
    let title: String
    let value: String
    var note: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            Text(title).foregroundStyle(Vibe.soft)
            Spacer()
            if let note {
                Text(note).font(.vibe(11, .bold)).foregroundStyle(Vibe.mint)
            }
            Text(value).monospacedDigit().textSelection(.enabled).lineLimit(1)
        }
        .font(.vibe(13))
    }
}

/// Asks the reason of a report (required, at most 1,000 characters) and sends it.
struct ReportSheet: View {
    @Environment(AppModel.self) var app
    let draft: ReportDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(draft.title).font(.headline)
            Text(draft.body).fixedSize(horizontal: false, vertical: true)
            TextField(L("report.reason"), text: Binding(get: { draft.reason }, set: { draft.edit($0) }), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
                .firstModalField()
            HStack {
                Spacer()
                Button(L("actions.cancel")) { app.cancelReport() }
                Button(L("report.send")) { Task { await app.sendReport() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!draft.canSend)
            }
        }
        .padding()
        .frame(width: 420)
    }
}
