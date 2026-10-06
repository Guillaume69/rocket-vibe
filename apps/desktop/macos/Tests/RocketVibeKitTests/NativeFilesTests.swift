import Foundation
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

final class NativeFilesTests:XCTestCase {
    @MainActor
    func testExistingFileModelsAndProtectedReader() async throws {
        guard let server=ProcessInfo.processInfo.environment["RV_FILE_TEST_SERVER"],let password=ProcessInfo.processInfo.environment["RV_FILE_TEST_PASSWORD"] else {throw XCTSkip("Disposable file server unset")}
        let home=FileManager.default.temporaryDirectory.appendingPathComponent("rv-files-swift-\(UUID())").path
        defer{try? FileManager.default.removeItem(atPath:home)}
        let app=AppModel(home:home);defer{app.end()}
        app.login.server=server;app.login.user="desktop-files";app.login.password=password
        await app.submitLogin();let native=try XCTUnwrap(app.native)
        try await until{app.connection == .online}
        let rid=try await native.createRoom(name:"Swift files \(UUID())",private:true)
        try await until{app.rooms.contains{$0.rid==rid}}
        app.open(rid);let room=try XCTUnwrap(app.room);try await until{!room.loading}
        XCTAssertTrue(room.supportsFiles)
        let source=home+"/source.txt";let saved=home+"/saved.txt";let content="the existing SwiftUI file model"
        try content.write(toFile:source,atomically:true,encoding:.utf8)
        let failure=await room.attach(path:source,name:"swift-file.txt",mime:"text/plain",caption:"Swift file caption",temporary:false)
        XCTAssertNil(failure)
        try await until{room.messages.contains{$0.text=="Swift file caption" && !$0.files.isEmpty}}
        let message=try XCTUnwrap(room.messages.first{$0.text=="Swift file caption"})
        XCTAssertEqual(message.files.count,1);XCTAssertEqual(message.files[0].title,"swift-file.txt")
        let path=message.files[0].url;XCTAssertTrue(path.hasPrefix("rv-file:"));XCTAssertFalse(path.contains("token"))
        let media=try XCTUnwrap(app.media)
        let preview=await media.load(path);XCTAssertEqual(preview?.bytes,Data(content.utf8))
        try await media.download(path,to:saved);XCTAssertEqual(try String(contentsOfFile:saved,encoding:.utf8),content)
        let again=await media.load(path);XCTAssertEqual(again?.bytes,Data(content.utf8))
        let privateCopy=try await media.localCopy(path,name:"swift-file.txt")
        XCTAssertTrue(privateCopy.path.contains(".native-files/"));XCTAssertEqual(try String(contentsOf:privateCopy,encoding:.utf8),content)
        await room.quote(message)
        XCTAssertEqual(room.pendingQuote?.files.first?.title,"swift-file.txt")
        room.draft="Swift quoted file";await room.send()
        try await until{room.messages.contains{$0.text=="Swift quoted file" && !$0.quotes.isEmpty}}
        let quoted=try XCTUnwrap(room.messages.first{$0.text=="Swift quoted file"})
        XCTAssertTrue(quoted.files.isEmpty);XCTAssertEqual(quoted.quotes[0].files.count,1)
        XCTAssertEqual(quoted.quotes[0].files[0].url,path)
        try await until{room.uploads.isEmpty}
        // A file sent from a thread answers the thread, not the room.
        app.openThread(message.id)
        try await until{app.thread?.loading == false}
        let thread=try XCTUnwrap(app.thread);XCTAssertTrue(thread.supportsFiles)
        let threadFailure=await thread.attach(path:source,name:"thread-file.txt",mime:"text/plain",caption:"Swift thread file",temporary:false)
        XCTAssertNil(threadFailure)
        try await until{thread.messages.contains{$0.text=="Swift thread file" && !$0.files.isEmpty}}
        try await until{thread.uploads.isEmpty}
        XCTAssertFalse(room.messages.contains{$0.text=="Swift thread file"})
        app.closeThread()
        native.suspend();try await until{app.connection != .online}
        let abandoned=await room.attach(path:source,name:"cancelled.txt",mime:"text/plain",caption:nil,temporary:false)
        XCTAssertNil(abandoned);room.refreshUploads();let upload=try XCTUnwrap(room.uploads.first)
        room.discardUpload(upload.id);native.reconnect()
        try await until{app.connection == .online && room.uploads.isEmpty}
        XCTAssertEqual(room.messages.filter{!$0.files.isEmpty && $0.text != "Swift thread file"}.count,1)
        room.deactivate()
        let closed=await room.attach(path:source,name:"closed.txt",mime:"text/plain",caption:nil,temporary:false)
        XCTAssertNotNil(closed)
    }
    @MainActor private func until(_ predicate:@escaping @MainActor()->Bool) async throws {
        let deadline=Date().addingTimeInterval(30)
        while Date()<deadline {if predicate(){return};try await Task.sleep(nanoseconds:50_000_000)}
        XCTFail("Native file model condition timed out");throw RvError.Local(message:"test timeout")
    }
}
