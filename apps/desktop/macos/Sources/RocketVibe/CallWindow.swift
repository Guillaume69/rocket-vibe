import AppKit
import RocketVibeCore
import WebKit

/// A call in a window of the app, not a browser tab: the meeting page in
/// WKWebView. It stays on the call's origin (rv-core's rule, through
/// `callAllowed`): only that origin gets the camera and the microphone, and
/// any other address opens in the browser. A Teams call goes to the user's
/// own Teams, signed in there: Teams' app when one handles `msteams:` links,
/// else the browser; a window of ours would stop on Microsoft's sign-in.
@MainActor
final class CallWindow: NSObject, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    private static var windows: [CallWindow] = []
    private let window: NSWindow
    private let web: WKWebView
    private let callURL: String
    private let huddle: Bool

    /// A Slack huddle opens signed in with `slackCookie`, its store kept in
    /// memory; without the cookie it goes to the browser, signed in there.
    static func show(_ url: URL, title: String, slackCookie: String? = nil) {
        let slack = url.scheme == "https" && slackHuddleAllowed(url: url.absoluteString)
        if slack && slackCookie == nil {
            NSWorkspace.shared.open(url)
            return
        }
        if !slack && url.scheme == "https" && teamsCallAllowed(url: url.absoluteString) {
            if let link = teamsAppLink(url: url.absoluteString), let app = URL(string: link),
               NSWorkspace.shared.urlForApplication(toOpen: app) != nil {
                NSWorkspace.shared.open(app)
            } else {
                NSWorkspace.shared.open(url)
            }
            return
        }
        let call = CallWindow(url: url, title: title, slackCookie: slack ? slackCookie : nil)
        windows.append(call)
        call.window.makeKeyAndOrderFront(nil)
    }

    private init(url: URL, title: String, slackCookie: String?) {
        callURL = url.absoluteString
        huddle = slackCookie != nil
        let configuration = WKWebViewConfiguration()
        if slackCookie != nil { configuration.websiteDataStore = .nonPersistent() }
        web = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.title = title
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.delegate = self
        window.center()
        web.uiDelegate = self
        web.navigationDelegate = self
        let cookie = slackCookie.flatMap { value in
            HTTPCookie(properties: [
                .name: "d", .value: value, .domain: ".slack.com", .path: "/", .secure: "TRUE",
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            ])
        }
        if let cookie {
            web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [web] in
                web.load(URLRequest(url: url))
            }
        } else {
            web.load(URLRequest(url: url))
        }
    }

    private func allowed(_ address: String) -> Bool {
        if huddle { return slackHuddleAllowed(url: address) }
        return callAllowed(url: address, callUrl: callURL)
    }

    func windowWillClose(_ notification: Notification) {
        web.stopLoading()
        web.loadHTMLString("", baseURL: nil)
        CallWindow.windows.removeAll { $0 === self }
    }

    func webView(
        _ webView: WKWebView,
        decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
        initiatedBy frame: WKFrameInfo,
        type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        let address = origin.port > 0
            ? "\(origin.protocol)://\(origin.host):\(origin.port)"
            : "\(origin.protocol)://\(origin.host)"
        return allowed(address) ? .grant : .deny
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        let target = navigationAction.request.url?.absoluteString ?? ""
        if allowed(target) || (huddle && navigationAction.targetFrame?.isMainFrame == false) {
            return .allow
        }
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return .cancel
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        window.close()
    }
}
