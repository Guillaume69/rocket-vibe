import Foundation

public struct CryptoWithdrawalSubject: Decodable, Identifiable {
    public let device: String
    public let incarnation: String
    public var id: String { device + ":" + incarnation }
}
public struct CryptoWithdrawalDevice: Decodable, Identifiable {
    public let device: String
    public let incarnation: String
    public let fingerprint: String
    public let revision: String
    public let expiresAt: String
    public var id: String { device + ":" + incarnation }
}
public struct CryptoWithdrawalStatus: Decodable {
    public let controlsRoot: Bool
    public let devices: [CryptoWithdrawalDevice]
    public let withdrawn: [CryptoWithdrawalSubject]
    public let pending: CryptoWithdrawalSubject?
}
public struct CryptoWithdrawalPreview: Decodable {
    public let id: String
    public let device: String
    public let incarnation: String
    public let fingerprint: String
    public let rootFingerprint: String
    public let expiresAt: String
}
