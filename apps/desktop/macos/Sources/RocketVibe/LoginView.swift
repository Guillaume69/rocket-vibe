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
            Text("rocket-vibe")
                .font(.largeTitle.weight(.semibold))
            Text(L("login.slogan"))
                .foregroundStyle(.secondary)

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
                } else if app.chat != nil {
                    Button(L("login.cancel_add")) { app.cancelLogin() }
                }
                Button(login.busy ? L("login.signing_in") : (login.method == nil ? L("login.sign_in") : L("login.confirm")), action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(login.busy)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focus = login.user.isEmpty ? .user : .password }
        .onChange(of: login.method) { _, method in if method != nil { focus = .code } }
    }

    func submit() {
        Task { await app.submitLogin() }
    }
}
