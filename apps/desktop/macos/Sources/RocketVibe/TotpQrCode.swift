import CoreImage
import CoreImage.CIFilterBuiltins
import RocketVibeKit
import SwiftUI

/// The authenticator setup link as a QR code, black on white whatever the appearance.
struct TotpQrCode: View {
    let uri: String

    var body: some View {
        if let image = Self.render(uri) {
            Image(image, scale: 1, label: Text(L("security.qr")))
                .resizable()
                .interpolation(.none)
                .frame(width: CGFloat(image.width) * 3, height: CGFloat(image.height) * 3)
                .frame(maxWidth: .infinity)
        }
    }

    static let quietZone: CGFloat = 4

    static func render(_ uri: String) -> CGImage? {
        guard uri.hasPrefix("otpauth://totp/") else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(uri.utf8)
        filter.correctionLevel = "M"
        guard let symbol = filter.outputImage else { return nil }
        let bounds = symbol.extent.insetBy(dx: -quietZone, dy: -quietZone)
        let light = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: bounds)
        return CIContext().createCGImage(symbol.composited(over: light), from: bounds)
    }
}
