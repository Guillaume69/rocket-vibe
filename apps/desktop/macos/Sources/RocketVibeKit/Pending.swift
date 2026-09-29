/// What a burst of listener events asks to reload. A busy server sends
/// presence and message events in bursts; each reloaded the room list or the
/// open room on its own, several times per frame. They are gathered here and
/// done in one pass.
struct Pending: Equatable {
    var rooms = false
    var everything = false
    var rids: Set<String> = []

    var isEmpty: Bool { !rooms && !everything && rids.isEmpty }

    mutating func add(rooms: Bool = false, everything: Bool = false, rids: [String] = []) {
        self.rooms = self.rooms || rooms
        self.everything = self.everything || everything
        self.rids.formUnion(rids)
    }

    var reloadsRooms: Bool { rooms || everything }

    func reloads(_ rid: String?) -> Bool {
        guard let rid else { return false }
        return everything || rids.contains(rid)
    }
}
