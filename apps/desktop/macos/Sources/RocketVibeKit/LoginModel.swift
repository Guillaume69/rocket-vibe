import Foundation
import Observation
import RocketVibeCore

public let defaultServer = "https://chat.barrut.me"

/// The sign-in form: server, credentials, then a code when the server asks one.
@MainActor @Observable
public final class LoginModel {
    public var server = ""
    public var user = ""
    public var password = ""
    public var code = ""
    /// The 2FA method the server asked a code for: the form shows the code field.
    public private(set) var method: String?
    public private(set) var error: String?
    public private(set) var busy = false
    public private(set) var knownServers: [String] = []

    public init() {}

    func reset(known: [String], error: String?) {
        knownServers = known
        if server.isEmpty { server = known.first ?? defaultServer }
        password = ""
        code = ""
        method = nil
        self.error = error
    }

    public func cancelCode() {
        method = nil
        code = ""
        error = nil
    }

    /// Signs in, or asks for the code the server wants.
    func submit(client: Client) async -> Chat? {
        let asking = method != nil
        error = nil
        busy = true
        defer { busy = false }
        do {
            let chat = try await client.login(
                server: server, user: user.trimmingCharacters(in: .whitespaces), password: password,
                method: method, code: asking ? code : nil)
            method = nil
            code = ""
            password = ""
            return chat
        } catch let RvError.Server(status, message, _, twoFactor) {
            if let challenge = twoFactor {
                method = challenge.method
                if asking { error = L("login.bad_code") }
                if challenge.method == "email" && !challenge.codeGenerated {
                    await client.requestEmailCode(server: server, user: user)
                }
                return nil
            }
            error = Self.describe(status: status, message: message, askingCode: asking)
        } catch let RvError.Local(message) {
            error = message == "invalid server address" ? L("login.bad_server") : message
        } catch {
            self.error = error.localizedDescription
        }
        return nil
    }

    static func describe(status: UInt16, message: String, askingCode: Bool) -> String {
        switch status {
        case 0: return L("login.unreachable")
        case 401 where askingCode: return L("login.bad_code")
        case 401: return L("login.rejected")
        case 429: return L("login.too_many")
        default: return message
        }
    }
}
