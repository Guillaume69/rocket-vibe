import AppKit
import RocketVibeCore
import WebKit

/// A call in a window of the app, not a browser tab: the meeting page in
/// WKWebView. It stays on the call's origin (rv-core's rule, through
/// `callAllowed`): only that origin gets the camera and the microphone, and
/// any other address opens in the browser.
@MainActor
final class CallWindow: NSObject, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    private static var windows: [CallWindow] = []
    private let window: NSWindow
    private let web: WKWebView
    private let callURL: String

    static func show(_ url: URL, title: String) {
        let call = CallWindow(url: url, title: title)
        windows.append(call)
        call.window.makeKeyAndOrderFront(nil)
    }

    private init(url: URL, title: String) {
        callURL = url.absoluteString
        web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
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
        web.load(URLRequest(url: url))
    }

    func windowWillClose(_ notification: Notification) {
        web.stopLoading()
        web.loadHTMLString("", baseURL: nil)
        CallWindow.windows.removeAll { $0 === self }
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        let address = origin.port > 0
            ? "\(origin.protocol)://\(origin.host):\(origin.port)"
            : "\(origin.protocol)://\(origin.host)"
        return callAllowed(url: address, callUrl: callURL) ? .grant : .deny
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        let target = navigationAction.request.url?.absoluteString ?? ""
        if callAllowed(url: target, callUrl: callURL) {
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
