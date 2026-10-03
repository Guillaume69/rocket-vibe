import ExpoModulesCore
import Foundation

public class TransfertFichierModule: Module {
  private var transfers: [String: FileTransfer] = [:]
  private var cancelled: Set<String> = []
  private let lock = NSLock()
  private func register(_ id: String, _ transfer: FileTransfer) -> Bool {
    lock.lock(); defer { lock.unlock() }; transfers[id] = transfer; return cancelled.contains(id)
  }
  private func remove(_ id: String) {
    lock.lock(); defer { lock.unlock() }; transfers.removeValue(forKey: id); cancelled.remove(id)
  }
  private func stopTransfers() {
    lock.lock(); let active = Array(transfers.values); transfers.removeAll(); cancelled.removeAll(); lock.unlock()
    active.forEach { $0.cancel() }
  }
  public func definition() -> ModuleDefinition {
    Name("TransfertFichier")
    Events("progress")
    OnDestroy { self.stopTransfers() }
    AsyncFunction("cancel") { (id: String) in
      self.lock.lock(); self.cancelled.insert(id); let transfer = self.transfers[id]; self.lock.unlock()
      transfer?.cancel()
    }
    AsyncFunction("upload") { (id: String, url: String, uri: String, headers: [String: String]) async throws -> [String: Any] in
      guard let source = URL(string: uri), source.isFileURL, let target = URL(string: url), ["http", "https"].contains(target.scheme ?? "") else { throw FileTransferError("Invalid file or origin") }
      let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size > 0 && size <= 100 * 1024 * 1024 else { throw FileTransferError("Invalid file size") }
      let transfer = FileTransfer(progress: { fraction in self.sendEvent("progress", ["id": id, "fraction": fraction]) })
      let aborted = self.register(id, transfer)
      defer { self.remove(id) }
      guard !aborted else { throw FileTransferError("Upload cancelled") }
      var request = URLRequest(url: target); request.httpMethod = "PUT"; request.allHTTPHeaderFields = headers
      return try await transfer.upload(request, source: source)
    }
  }
}
private final class FileTransfer: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate, @unchecked Sendable {
  private var task: URLSessionUploadTask?
  private let lock = NSLock()
  private var cancelled = false
  private var continuation: CheckedContinuation<[String: Any], Error>?
  private var data = Data()
  private var session: URLSession?
  private let progress: (Double) -> Void
  init(progress: @escaping (Double) -> Void) { self.progress = progress }
  func cancel() { lock.lock(); cancelled = true; let current = task; lock.unlock(); current?.cancel() }
  private func start(_ session: URLSession, _ request: URLRequest, _ source: URL) {
    lock.lock(); defer { lock.unlock() }
    task = session.uploadTask(with: request, fromFile: source)
    if cancelled { task!.cancel() }; task!.resume()
  }
  func upload(_ request: URLRequest, source: URL) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 150
      self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
      self.start(self.session!, request, source)
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) { if totalBytesExpectedToSend > 0 { progress(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) } }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    self.data.append(data); if self.data.count > 32 * 1024 { dataTask.cancel() }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    defer { continuation = nil; session.invalidateAndCancel() }
    if let error { continuation?.resume(throwing: error); return }
    guard data.count <= 32 * 1024, let response = task.response as? HTTPURLResponse, let body = String(data: data, encoding: .utf8) else { continuation?.resume(throwing: FileTransferError("Invalid response")); return }
    continuation?.resume(returning: ["status": response.statusCode, "body": body])
  }
}
private final class FileTransferError: GenericException<String> { override var reason: String { param } }
