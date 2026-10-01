import AppKit
import RocketVibeCore
import SwiftUI
import WebKit

/// A YouTube, Dailymotion or Vimeo link: the thumbnail plays the video in the
/// card, the title opens it in the browser.
struct VideoCard: View {
    @Environment(\.openURL) var openURL
    let card: Card
    let page: String
    @State var playing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if let url = URL(string: card.url) { openURL(url) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    if let site = card.site { Text(site).font(.vibe(11.5, .bold)).foregroundStyle(Vibe.muted) }
                    if let title = card.title { Text(title).font(.vibe(13.5, .heavy)).lineLimit(2) }
                }
                .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .help(card.url)
            if playing {
                InlinePlayer(page: page)
                    .frame(width: 480, height: 270)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                Button { playing = true } label: {
                    ZStack {
                        if let image = card.image {
                            RemoteImage(path: image, width: 320, height: 180)
                        } else {
                            Color.black.frame(width: 320, height: 180)
                        }
                        Image(systemName: "play.circle.fill").font(.largeTitle).foregroundStyle(.white)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .vibeCard()
    }
}

/// The player page in WKWebView, loaded at rv-core's player origin so the
/// embed gets a Referer. It keeps to the video (`playerNavigation`) and
/// stores nothing.
struct InlinePlayer: NSViewRepresentable {
    let page: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.loadHTMLString(page, baseURL: URL(string: playerOrigin()))
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {}

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        web.stopLoading()
        web.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            let target = navigationAction.request.url?.absoluteString ?? ""
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            let clicked = navigationAction.navigationType == .linkActivated
            switch playerNavigation(target: target, mainFrame: mainFrame, clicked: clicked) {
            case .allow:
                return .allow
            case .browser:
                if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
                return .cancel
            case .block:
                return .cancel
            }
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
    }
}
