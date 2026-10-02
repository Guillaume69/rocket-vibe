import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// Uses the same room information form; only confirmed values reach the sidebar.
struct NativeFavoriteControls: View {
    let model:RoomModel
    @State private var state:NativeFavoriteState?
    @State private var error:String?
    var body:some View {
        Section {
            if let state {
                Button(L(state.present ? "rooms.favorite_remove" : "rooms.favorite_add")) {
                    perform { try model.changeFavorite(present:!state.present,state:state) }
                }.disabled(state.intention != nil)
                if let saved=state.intention {
                    Text(L(saved.failed ? "rooms.rejected" : "rooms.pending")).foregroundStyle(.secondary)
                    if saved.failed {
                        Button(L("rooms.clear")) { perform {try model.dismissFavorite(key:saved.key)} }
                    } else {
                        Button(L("rooms.resume")) { perform {try model.resumeFavorite(key:saved.key)} }
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .task(id:model.roomOperationRevision) { state=try? model.favoriteState() }
        .onChange(of:model.supportsRoomFavorite) { _,active in if !active {state=nil;error=nil} }
        .onDisappear { state=nil;error=nil }
    }
    func perform(_ action:() throws -> Void) {
        do {try action();error=nil}
        catch {error=L("rooms.conflict")}
        state=try? model.favoriteState()
    }
}

/// The same sidebar context action offered by GTK, including a saved native request.
struct NativeFavoriteMenu: View {
    @Environment(AppModel.self) var app
    let native:NativeChat
    let room:Room
    let accountKey:String?
    @State private var state:NativeFavoriteState?
    var body:some View {
        Group {
            if let state {
                Button(L(state.present ? "rooms.favorite_remove" : "rooms.favorite_add")) {
                    perform {try native.setFavoriteFromState(room:room.rid,present:!state.present,membership:state.membership,revision:state.revision)}
                }.disabled(state.intention != nil)
                if let saved=state.intention {
                    Text(L(saved.failed ? "rooms.rejected" : "rooms.pending"))
                    if saved.failed {Button(L("rooms.clear")){perform {_ = try native.dismissFailedFavorite(room:room.rid,key:saved.key)}}}
                    else {Button(L("rooms.resume")){perform {try native.resumeFavorite(room:room.rid,key:saved.key)}}}
                }
            } else {Button(L(room.favorite ? "rooms.favorite_remove" : "rooms.favorite_add")) {}.disabled(true)}
        }
        .onAppear {if app.account?.key == accountKey {state=try? native.favoriteState(room:room.rid)}}
        .onDisappear {state=nil}
    }
    func perform(_ action:() throws -> Void) {
        guard app.account?.key == accountKey else {state=nil;return}
        do {try action()}catch{app.notice=L("rooms.conflict")}
        state=try? native.favoriteState(room:room.rid)
    }
}
