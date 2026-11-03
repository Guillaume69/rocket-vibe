import AppKit
import ImageIO
import RocketVibeKit

/// Photos, emoji and uploads decoded off the main thread at the size they are
/// drawn, and kept: a row scrolled back into view finds its picture ready
/// instead of decoding the whole file again while the list moves.
@MainActor
enum Pictures {
    static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 800
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    static func key(_ path: String, _ pixels: Int) -> NSString {
        "\(path)#\(pixels)" as NSString
    }

    static func cached(_ path: String, pixels: Int) -> NSImage? {
        if path.hasPrefix("rv-file:")||path.hasPrefix("rv-preview:"){return nil}
        return cache.object(forKey: key(path, pixels))
    }

    /// An animated GIF's frames and how long each shows, in seconds.
    final class Animation {
        let frames: [NSImage]
        let delays: [Double]
        let period: Double
        init(frames: [NSImage], delays: [Double]) {
            self.frames = frames
            self.delays = delays
            period = delays.reduce(0, +)
        }

        /// The frame shown at `date`, the animation looping from the epoch.
        func frame(at date: Date) -> NSImage {
            guard period > 0, frames.count > 1 else { return frames[0] }
            var at = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
            for (index, delay) in delays.enumerated() {
                if at < delay { return frames[index] }
                at -= delay
            }
            return frames[frames.count - 1]
        }
    }

    static let animations: NSCache<NSString, Animation> = {
        let cache = NSCache<NSString, Animation>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()

    static func animation(_ path: String, pixels: Int) -> Animation? {
        if path.hasPrefix("rv-file:")||path.hasPrefix("rv-preview:"){return nil}
        return animations.object(forKey: key(path, pixels))
    }

    /// `pixels`: the longest side drawn, in pixels; 0 keeps the original size.
    static func load(_ path: String, pixels: Int, media: MediaStore) async -> NSImage? {
        let scope=media.scope(path)
        guard media.current(path) else{return nil}
        if let hit = cached(path, pixels: pixels) { return hit }
        guard let data = await media.load(path), !data.placeholder else { return nil }
        let bytes = data.bytes
        guard let decoded = await Task.detached(priority: .userInitiated, operation: { decodeFrames(bytes, pixels: pixels) }).value,
              let first = decoded.first
        else { return nil }
        guard media.current(path),scope==media.scope(path),!Task.isCancelled else{return nil}
        let images = decoded.map { NSImage(cgImage: $0.image, size: NSSize(width: $0.image.width / 2, height: $0.image.height / 2)) }
        cache.setObject(images[0], forKey: key(path, pixels), cost: first.image.width * first.image.height * 4)
        if images.count > 1 {
            animations.setObject(
                Animation(frames: images, delays: decoded.map(\.delay)), forKey: key(path, pixels),
                cost: decoded.reduce(0) { $0 + $1.image.width * $1.image.height * 4 })
        }
        return images[0]
    }

    /// Every frame of a small animated GIF (an emoji) with its delay, at most
    /// `maxFrames`; anything else is its first frame.
    nonisolated static func decodeFrames(_ bytes: Data, pixels: Int) -> [(image: CGImage, delay: Double)]? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1, pixels > 0, pixels <= 256, CGImageSourceGetType(source) as String? == "com.compuserve.gif" else {
            return decode(bytes, pixels: pixels).map { [($0, 0)] }
        }
        var frames: [(image: CGImage, delay: Double)] = []
        for index in 0..<min(count, maxFrames) {
            let image: CGImage?
            if pixels <= 0 {
                image = CGImageSourceCreateImageAtIndex(source, index, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            } else {
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: pixels,
                ]
                image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary)
            }
            guard let image else { break }
            frames.append((image, delay(source, index)))
        }
        return frames.isEmpty ? nil : frames
    }

    nonisolated static let maxFrames = 300

    /// A GIF frame's delay as browsers play it: under 20 ms counts as 100 ms.
    nonisolated static func delay(_ source: CGImageSource, _ index: Int) -> Double {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let value = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
            ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
        return value < 0.02 ? 0.1 : value
    }

    nonisolated static func decode(_ bytes: Data, pixels: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        if pixels <= 0 {
            return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Pixels for a side drawn at `points`, on a Retina screen.
    static func pixels(_ points: CGFloat) -> Int {
        Int((points * 2).rounded(.up))
    }
}
