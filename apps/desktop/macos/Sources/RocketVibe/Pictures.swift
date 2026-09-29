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
        return cache
    }()

    static func key(_ path: String, _ pixels: Int) -> NSString {
        "\(path)#\(pixels)" as NSString
    }

    static func cached(_ path: String, pixels: Int) -> NSImage? {
        cache.object(forKey: key(path, pixels))
    }

    /// `pixels`: the longest side drawn, in pixels; 0 keeps the original size.
    static func load(_ path: String, pixels: Int, media: MediaStore) async -> NSImage? {
        if let hit = cached(path, pixels: pixels) { return hit }
        guard let data = await media.load(path), !data.placeholder else { return nil }
        let bytes = data.bytes
        guard let decoded = await Task.detached(priority: .userInitiated, operation: { decode(bytes, pixels: pixels) }).value
        else { return nil }
        let image = NSImage(cgImage: decoded, size: NSSize(width: decoded.width / 2, height: decoded.height / 2))
        cache.setObject(image, forKey: key(path, pixels))
        return image
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
