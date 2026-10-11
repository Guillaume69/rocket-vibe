import AppKit
import RocketVibeCore
import WebKit

/// Infomaniak's sign-in page for kChat in a window of the app: it catches the
/// `com.infomaniak.chat://` redirect no browser would hand back, shows only
/// Infomaniak's pages and never grants the camera or the microphone. Closing
/// it is a cancel.
@MainActor
final class SignInWindow: NSObject, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    private static var windows: [SignInWindow] = []
    private let window: NSWindow
    private let web: WKWebView
    private let caught: (String) -> Void
    private var done = false

    static func show(_ url: String, title: String, caught: @escaping (String) -> Void) {
        guard let address = URL(string: url) else { return }
        let signIn = SignInWindow(url: address, title: title, caught: caught)
        windows.append(signIn)
        signIn.window.makeKeyAndOrderFront(nil)
    }

    private init(url: URL, title: String, caught: @escaping (String) -> Void) {
        self.caught = caught
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
        if kchatIsRedirect(url: target) {
            if !done {
                done = true
                window.close()
                caught(target)
            }
            return .cancel
        }
        if target == "about:blank" || kchatIsSignInPage(url: target)
            || navigationAction.targetFrame?.isMainFrame == false {
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
