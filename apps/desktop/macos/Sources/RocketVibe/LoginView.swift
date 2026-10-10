import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) var app
    @FocusState var focus: Field?
    @State private var experimental = false
    @State private var taps = 0
    @State private var lastTap: TimeInterval?
    @State private var unlockError: String?

    private func unlock() {
        guard !experimental else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if lastTap == nil || now - (lastTap ?? now) > 2 { taps = 0 }
        lastTap = now; taps += 1
        if taps == 9 {
            taps = 0; lastTap = nil
            do { try app.client.setExperimentalProviders(enabled: true); experimental = true; unlockError = nil }
            catch { unlockError = L("slack.unlockFailed") }
        }
    }

    enum Field {
        case server, user, password, code, invitation
    }

    var body: some View {
        @Bindable var login = app.login
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 88, height: 88)
                .shadow(color: Vibe.pink.opacity(0.45), radius: 24, y: 8)
                .onTapGesture { unlock() }
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("RocketVibe")
                .accessibilityAction { unlock() }
            Wordmark(size: 40, twinkles: true)
            Text(L("login.slogan"))
                .font(.vibe(15, .semibold))
                .foregroundStyle(Vibe.muted)

            Form {
                if experimental {
                    ExperimentalPreviewView(client: app.client) {
                        do { try app.client.setExperimentalProviders(enabled: false); experimental = false }
                        catch { unlockError = L("slack.unlockFailed") }
                    }
                }
                if let unlockError { Text(unlockError).foregroundStyle(.secondary) }
                if let method = login.method {
                    if login.nativeMethods.count > 1 {
                        Picker("", selection: Binding(get: { login.method ?? "totp" }, set: { login.selectNativeMethod($0) })) {
                            ForEach(login.nativeMethods, id: \.self) { offered in
                                Text(nativeFactorTitle(offered)).tag(offered)
                            }
                        }.labelsHidden()
                    }
                    Text(L("login.intro_\(method)"))
                        .fixedSize(horizontal: false, vertical: true)
                    if method == "email", let email = login.nativeEmail {
                        Text(factorEmailStatus(email)).font(.caption).foregroundStyle(.secondary)
                        Button(L(email.requested ? "email.resume_delivery" : "email.send_code")) {
                            Task { await login.sendNativeEmail(resend: false, revision: email.viewRevision) }
                        }.disabled(!email.requested && !email.canDeliver)
                        if email.delivery != nil {
                            Button(L("email.resend_code")) {
                                Task { await login.sendNativeEmail(resend: true, revision: email.viewRevision) }
                            }.disabled(!email.canDeliver)
                        }
                    }
                    SecureField(L("login.code_\(method)"), text: $login.code)
                        .focused($focus, equals: .code)
                        .onSubmit(submit)
                } else {
                    // kChat: the token names the account, its servers come from the kChat directory.
                    if login.kind != .kchat {
                        TextField(L("login.server"), text: $login.server)
                            .focused($focus, equals: .server)
                            .textContentType(.URL)
                    }
                    // Found by probing; forced when the probe gets it wrong.
                    Picker(L("login.kind"), selection: $login.kind) {
                        Text(L("login.kind_auto")).tag(ServerChoice.auto)
                        Text(L("login.kind_rocketchat")).tag(ServerChoice.rocketChat)
                        Text(L("login.kind_rocketvibe")).tag(ServerChoice.rocketVibe)
                        Text(L("login.kind_mattermost")).tag(ServerChoice.mattermost)
                        Text(L("login.kind_kchat")).tag(ServerChoice.kchat)
                    }
                    .pickerStyle(.segmented)
                    if let probe = login.probeLine {
                        Text(probe)
                            .font(.caption)
                            .foregroundStyle(login.probeBad ? .red : .secondary)
                    }
                    if login.kind == .kchat && !login.kchatServers.isEmpty {
                        Picker(L("login.kchat_server"), selection: $login.kchatServer) {
                            ForEach(login.kchatServers, id: \.url) { Text($0.name).tag($0.url) }
                        }
                    }
                    if !login.knownServers.isEmpty && login.kind != .kchat {
                        Picker("", selection: $login.server) {
                            ForEach(login.knownServers, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                    }
                    if login.kind != .kchat {
                        TextField(L("login.user"), text: $login.user)
                            .focused($focus, equals: .user)
                            .textContentType(.username)
                    }
                    SecureField(L(login.recovering ? "login.new_password" : login.tokenLogin ? "login.kchat_token" : "login.password"), text: $login.password)
                        .focused($focus, equals: .password)
                        .textContentType(.password)
                        .onSubmit(submit)
                    if login.pendingConfirmation { Text(L("login.factor_resume")).font(.caption) }
                    if login.canRegister {
                        Toggle(L("login.create_account"), isOn: $login.registering)
                            .onChange(of: login.registering) { _, active in if active { login.recovering = false }; login.invitation = "" }
                        if login.registering {
                            Text(L("login.invitation_help")).font(.caption)
                            SecureField(L("login.invitation"), text: $login.invitation)
                                .focused($focus, equals: .invitation)
                                .onSubmit(submit)
                        }
                    }
                    if login.canRecover {
                        Toggle(L("login.recover_account"), isOn: $login.recovering)
                            .onChange(of: login.recovering) { _, active in if active { login.registering = false }; login.invitation = "" }
                        if login.recovering {
                            Text(L("login.recovery_help")).font(.caption)
                            if login.canEmailRecover, let email = login.recoveryEmail {
                                Text(L(email.identityChanged ? "recovery_email.changed" : email.expired ? "recovery_email.expired"
                                    : email.accepted ? "recovery_email.accepted" : email.requested ? "recovery_email.pending" : "recovery_email.help"))
                                    .font(.caption).fixedSize(horizontal: false, vertical: true)
                                if email.retryAfterSeconds > 0 {
                                    Text(L("recovery_email.wait", ["seconds": String(email.retryAfterSeconds)])).font(.caption)
                                }
                                if !email.accepted && !email.expired && !email.identityChanged {
                                    Button(L(email.requested ? "recovery_email.retry" : "recovery_email.send")) {
                                        Task { await login.sendRecoveryEmail(forget: false, revision: email.viewRevision) }
                                    }.disabled(email.retryAfterSeconds > 0)
                                }
                                if email.requested {
                                    Button(L("recovery_email.forget")) {
                                        Task { await login.sendRecoveryEmail(forget: true, revision: email.viewRevision) }
                                    }
                                    Text(L("recovery_email.forget_help")).font(.caption)
                                }
                            }
                            SecureField(L("login.recovery_code"), text: $login.invitation)
                                .focused($focus, equals: .invitation)
                                .onSubmit(submit)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(login.busy)
            .scrollContentBackground(.hidden)
            .frame(maxWidth: 400)
            .fixedSize(horizontal: false, vertical: true)

            if let error = login.error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            HStack {
                if login.method != nil {
                    Button(L("actions.cancel")) { login.cancelCode() }
                        .disabled(login.busy)
                } else if app.signedIn {
                    Button(L("login.cancel_add")) { app.cancelLogin() }
                        .disabled(login.busy)
                }
                Button(login.busy ? L("login.signing_in") : (login.method == nil ? L(login.recovering && login.canRecover ? "login.reset_password" : login.registering && login.canRegister ? "login.create_account" : "login.sign_in") : L("login.confirm")), action: submit)
                    .buttonStyle(VibeButtonStyle())
                    .windowShortcut(.defaultAction)
                    .disabled(login.busy)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { LoginSky() }
        .onAppear { focus = login.user.isEmpty ? .user : .password }
        .onDisappear { login.leave() }
        .onChange(of: login.method) { _, method in if method != nil { focus = .code } }
        .onChange(of: login.server) { _, _ in login.registering = false; login.recovering = false; login.invitation = "" }
        .onAppear { experimental = app.client.experimentalProviders() }
        .task(id: "\(login.address)|\(login.kind)") {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if !Task.isCancelled { await login.probe(client: app.client) }
        }
        .task(id: "\(login.server)|\(login.user)|\(login.recovering)|\(login.canEmailRecover)") {
            try? await Task.sleep(nanoseconds: 350_000_000)
            if !Task.isCancelled { await login.loadRecoveryEmail(client: app.client) }
            while !Task.isCancelled && login.recovering && login.canEmailRecover {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if !Task.isCancelled { login.refreshRecoveryEmail() }
            }
        }
    }

    func submit() {
        Task { await app.submitLogin() }
    }
}

/// The sign-in backdrop: a soft glow of the brand colours and a few sparkles.
struct LoginSky: View {
    @State var glow = false

    var body: some View {
        ZStack {
            Vibe.night
            RadialGradient(colors: [Vibe.pink.opacity(0.22), .clear], center: .topLeading, startRadius: 0, endRadius: 520)
            RadialGradient(colors: [Vibe.violet.opacity(0.2), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 560)
            GeometryReader { geometry in
                ForEach(0..<9, id: \.self) { i in
                    let x = CGFloat((i * 37 + 11) % 100) / 100
                    let y = CGFloat((i * 53 + 23) % 100) / 100
                    Sparkle()
                        .fill([Vibe.pink, Vibe.violet, Vibe.mint][i % 3])
                        .frame(width: CGFloat(6 + i % 4 * 3), height: CGFloat(6 + i % 4 * 3))
                        .opacity(glow == (i % 2 == 0) ? 0.85 : 0.25)
                        .position(x: geometry.size.width * x, y: geometry.size.height * y)
                }
            }
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { glow = true }
        }
        .allowsHitTesting(false)
    }
}
