import AppKit
import RocketVibeCore
import WebKit

/// A sign-in page in a window of the app, its store kept in memory only, never
/// granting the camera or the microphone. Infomaniak's for kChat catches the
/// `com.infomaniak.chat://` redirect no browser would hand back; Slack's stops
/// on its desktop handoff or web client and hands on the session's cookies.
/// Closing either is a cancel.
@MainActor
final class SignInWindow: NSObject, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    private enum Kind {
        case kchat((String) -> Void)
        case slack((String, [SlackCookie]) -> Void)
    }
    private static var windows: [SignInWindow] = []
    private let window: NSWindow
    private let web: WKWebView
    private let kind: Kind
    private var done = false

    static func show(_ url: String, title: String, caught: @escaping (String) -> Void) {
        open(url, title: title, kind: .kchat(caught))
    }

    static func showSlack(title: String, caught: @escaping (String, [SlackCookie]) -> Void) {
        open(slackWindowStart(), title: title, kind: .slack(caught))
    }

    private static func open(_ url: String, title: String, kind: Kind) {
        guard let address = URL(string: url) else { return }
        let signIn = SignInWindow(url: address, title: title, kind: kind)
        windows.append(signIn)
        signIn.window.makeKeyAndOrderFront(nil)
    }

    private init(url: URL, title: String, kind: Kind) {
        self.kind = kind
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 720),
            styleMask: [.titled, .closable, .resizable],
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
        web.load(URLRequest(url: url))
    }

    func windowWillClose(_ notification: Notification) {
        web.stopLoading()
        SignInWindow.windows.removeAll { $0 === self }
    }

    func webView(
        _ webView: WKWebView,
        decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
        initiatedBy frame: WKFrameInfo,
        type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        .deny
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        let target = navigationAction.request.url?.absoluteString ?? ""
        switch kind {
        case .kchat(let caught):
            if kchatIsRedirect(url: target) {
                if !done {
                    done = true
                    window.close()
                    caught(target)
                }
                return .cancel
            }
        case .slack(let caught):
            if slackWindowDone(url: target) {
                if !done {
                    done = true
                    await harvest(target, caught)
                }
                return .cancel
            }
        }
        let page = switch kind {
        case .kchat: kchatIsSignInPage(url: target)
        case .slack: slackWindowPage(url: target)
        }
        if target == "about:blank" || page || navigationAction.targetFrame?.isMainFrame == false {
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
        let target = navigationAction.request.url?.absoluteString ?? ""
        let stays = switch kind {
        case .kchat: kchatIsSignInPage(url: target) || kchatIsRedirect(url: target)
        case .slack: slackWindowPage(url: target) || slackWindowDone(url: target)
        }
        if stays {
            webView.load(navigationAction.request)
        } else if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        window.close()
    }

    /// The window's Slack cookies, then the window closes.
    private func harvest(_ reached: String, _ caught: (String, [SlackCookie]) -> Void) async {
        let host = URL(string: slackWindowCookieUrl())?.host?.lowercased() ?? ""
        let all = await web.configuration.websiteDataStore.httpCookieStore.allCookies()
        let cookies = all.compactMap { cookie -> SlackCookie? in
            let bare = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            guard host == bare || host.hasSuffix("." + bare) else { return nil }
            return SlackCookie(
                name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
                secure: cookie.isSecure, httpOnly: cookie.isHTTPOnly
            )
        }
        window.close()
        caught(reached, cookies)
    }
}
