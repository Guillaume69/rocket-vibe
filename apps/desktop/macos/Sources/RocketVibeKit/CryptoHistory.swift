import Foundation

/// Public labels only: request fingerprints, device names, room ids and counts.
/// Period secrets, recovered documents and pending approvals belong to Rust.
public struct CryptoHistoryRequested: Decodable {
    public let fingerprint: String
}
public struct CryptoHistoryImport: Decodable {
    public let state: String
    public let request: String?
}
public struct CryptoHistoryOffer: Decodable, Identifiable {
    public let fingerprint: String
    public let device: String
    public let expiresAt: String
    public var id: String { fingerprint }
}
public struct CryptoHistoryOffers: Decodable {
    public let id: String
    public let offers: [CryptoHistoryOffer]
}
public struct CryptoHistoryPeriod: Decodable, Identifiable {
    public let room: String
    public let documents: String
    public var id: String { room + "/" + documents }
}
public struct CryptoHistoryPreview: Decodable {
    public let id: String
    public let fingerprint: String
    public let device: String
    public let periods: [CryptoHistoryPeriod]
}
/// What the history group shows under its title.
public enum CryptoHistoryState: Equatable {
    case idle, requested(String), waiting(String), imported, noOffers, shared
    public var title: String {
        switch self {
        case .idle: return L("crypto.history_idle")
        case .requested: return L("crypto.history_requested")
        case .waiting: return L("crypto.history_waiting")
        case .imported: return L("crypto.history_done")
        case .noOffers: return L("crypto.history_no_offers")
        case .shared: return L("crypto.history_shared")
        }
    }
    public var fingerprint: String? {
        switch self {
        case .requested(let value), .waiting(let value): return value
        default: return nil
        }
    }
}
