import AppKit
import QuartzCore
import RocketVibeCore
import SwiftUI

/// `RV_SMOKE_SCROLL=1` with the gallery: a long room scrolled up to its top
/// and back down at a steady speed, three times, one step per display frame
/// on the window's own scroll view, as a trackpad moves it, and how long each
/// frame took while it moved: each pass, then all of them.
enum ScrollBench {
    static var requested: Bool { ProcessInfo.processInfo.environment["RV_SMOKE_SCROLL"] == "1" }

    /// Four hundred rows of every kind the gallery draws, each with an id of its own.
    static let messages: [MessageItem] = (0..<400).map { i in
        var message = gallerySamples[i % gallerySamples.count]
        message.id = "bench-\(i)"
        message.showHeader = i % 3 == 0
        message.showDay = i % 60 == 0
        message.gutterTime = i % 3 != 0
        return message
    }

    /// Points per second, the pace of a firm trackpad flick.
    static let speed: CGFloat = 1400
    static let passes = 3

    static func report(_ label: String, _ intervals: [CFTimeInterval]) -> String {
        guard !intervals.isEmpty else { return "smoke: scroll \(label) measured no frame" }
        let ms = intervals.map { $0 * 1000 }.sorted()
        func at(_ q: Double) -> Double { ms[min(ms.count - 1, Int(Double(ms.count - 1) * q))] }
        let slow = ms.filter { $0 > 25 }.count
        return String(
            format: "smoke: scroll %@ %d frames, p50 %.1f ms, p95 %.1f ms, p99 %.1f ms, max %.1f ms, over 25 ms %d (%.1f%%)",
            label, ms.count, at(0.5), at(0.95), at(0.99), ms.last ?? 0, slow, Double(slow) * 100 / Double(ms.count))
    }
}

/// Placed in the window, it finds the tallest scroll view there and drives it.
struct ScrollDriver: NSViewRepresentable {
    func makeNSView(context: Context) -> DriverView { DriverView() }
    func updateNSView(_ view: DriverView, context: Context) {}

    final class DriverView: NSView {
        var link: CADisplayLink?
        var last: CFTimeInterval?
        var intervals: [CFTimeInterval] = []
        var all: [CFTimeInterval] = []
        var pass = 1
        var goingUp = true
        var startAt: Date?
        var finished = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            link?.invalidate()
            link = nil
            guard window != nil, !finished else { return }
            startAt = Date().addingTimeInterval(3)
            let link = displayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        func scrollView() -> NSScrollView? {
            var best: NSScrollView?
            var queue = window?.contentView.map { [$0] } ?? []
            while let view = queue.popLast() {
                if let scroll = view as? NSScrollView,
                   (scroll.documentView?.frame.height ?? 0) > (best?.documentView?.frame.height ?? 0) {
                    best = scroll
                }
                queue.append(contentsOf: view.subviews)
            }
            return best
        }

        @objc func tick(_ link: CADisplayLink) {
            guard !finished, let startAt, Date() >= startAt, let scroll = scrollView(),
                  let document = scroll.documentView,
                  document.frame.height - scroll.contentView.bounds.height > 2000 else { return }
            let now = link.timestamp
            let dt = last.map { now - $0 } ?? 1.0 / 60
            if last != nil { intervals.append(dt) }
            last = now
            let clip = scroll.contentView
            let range = max(0, document.frame.height - clip.bounds.height)
            let step = ScrollBench.speed * CGFloat(min(dt, 0.05))
            let towardTop: CGFloat = document.isFlipped ? -1 : 1
            var y = clip.bounds.origin.y + (goingUp ? towardTop : -towardTop) * step
            y = min(max(y, 0), range)
            let atTop = document.isFlipped ? y <= 0 : y >= range
            let atBottom = document.isFlipped ? y >= range : y <= 0
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
            scroll.reflectScrolledClipView(clip)
            let timedOut = Date() > startAt.addingTimeInterval(150)
            if goingUp && atTop && !timedOut {
                goingUp = false
            } else if (!goingUp && atBottom) || timedOut {
                print(ScrollBench.report("pass \(pass)", intervals) + (timedOut ? " (timed out)" : ""))
                all += intervals
                intervals = []
                last = nil
                goingUp = true
                pass += 1
                if pass > ScrollBench.passes || timedOut {
                    finished = true
                    link.invalidate()
                    print(ScrollBench.report("total", all))
                }
                fflush(stdout)
            }
        }
    }
}
