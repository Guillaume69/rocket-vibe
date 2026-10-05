import Foundation

/// Public labels only. Recovery keys and pending confirmations belong to Rust.
public struct CryptoBackupReceipt: Decodable {
    public let backupId: String
    public let backupRevision: String
}
public struct CryptoBackupStatus: Decodable {
    public let controlsRoot: Bool
    public let rootFingerprint: String
    public let receipt: CryptoBackupReceipt?
    public let pending: Bool
    public let codeSaved: Bool
    public let cancelRequested: Bool
}
public struct CryptoBackupPreview: Decodable {
    public let id: String
    public let rootFingerprint: String
    public let backupRevision: String?
}
public struct CryptoRestorePreview: Decodable {
    public let id: String
    public let rootFingerprint: String
    public let backupId: String
}
