import RocketVibeKit
import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) var app
    @FocusState var focus: Field?

    enum Field {
        case server, user, password, code
    }

    var body: some View {
        @Bindable var login = app.login
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 88, height: 88)
                .shadow(color: Vibe.pink.opacity(0.45), radius: 24, y: 8)
            Wordmark(size: 40, twinkles: true)
            Text(L("login.slogan"))
                .font(.vibe(15, .semibold))
                .foregroundStyle(Vibe.muted)

            Form {
                if let method = login.method {
                    Text(L("login.intro_\(method)"))
                        .fixedSize(horizontal: false, vertical: true)
                    SecureField(L("login.code_\(method)"), text: $login.code)
                        .focused($focus, equals: .code)
                        .onSubmit(submit)
                } else {
                    TextField(L("login.server"), text: $login.server)
                        .focused($focus, equals: .server)
                        .textContentType(.URL)
                    if let probe = login.probeLine {
                        Text(probe)
                            .font(.caption)
                            .foregroundStyle(login.probeBad ? .red : .secondary)
                    }
                    if !login.knownServers.isEmpty {
                        Picker("", selection: $login.server) {
                            ForEach(login.knownServers, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                    }
                    TextField(L("login.user"), text: $login.user)
                        .focused($focus, equals: .user)
                        .textContentType(.username)
                    SecureField(L("login.password"), text: $login.password)
                        .focused($focus, equals: .password)
                        .textContentType(.password)
                        .onSubmit(submit)
                }
            }
            .formStyle(.grouped)
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
                } else if app.signedIn {
                    Button(L("login.cancel_add")) { app.cancelLogin() }
                }
                Button(login.busy ? L("login.signing_in") : (login.method == nil ? L("login.sign_in") : L("login.confirm")), action: submit)
                    .buttonStyle(VibeButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(login.busy)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { LoginSky() }
        .onAppear { focus = login.user.isEmpty ? .user : .password }
        .onChange(of: login.method) { _, method in if method != nil { focus = .code } }
        .task(id: login.server) {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if !Task.isCancelled { await login.probe(client: app.client) }
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
