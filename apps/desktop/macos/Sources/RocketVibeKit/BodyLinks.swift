import RocketVibeCore

/// The addresses a message's text links to, in order and once each, mentions
/// and room links left out: the row's context menu replaces the text's own, so
/// it offers to copy them.
public func linkAddresses(_ blocks: [BodyBlock]) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    func take(_ runs: [Run]) {
        for link in runs.compactMap(\.link) where !link.hasPrefix("rv-") && seen.insert(link).inserted {
            out.append(link)
        }
    }
    func walk(_ blocks: [BodyBlock]) {
        for block in blocks {
            switch block {
            case let .paragraph(runs), let .bigEmoji(runs): take(runs)
            case let .heading(_, runs): take(runs)
            case let .quote(inner): walk(inner)
            case let .list(items): items.forEach { take($0.runs) }
            case let .table(_, header, rows):
                header.forEach { take($0.runs) }
                rows.forEach { $0.cells.forEach { take($0.runs) } }
            default: break
            }
        }
    }
    walk(blocks)
    return out
}
