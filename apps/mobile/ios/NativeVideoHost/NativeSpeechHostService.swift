import Foundation

@objcMembers public final class NativeSpeechHostService: NSObject {
  private let fm = FileManager.default
  private let lock = NSLock()
  private var active: [String: URLSessionUploadTask] = [:]
  private var temporaryBodies: [String: URL] = [:]
  private var starting = Set<String>()
  private var cancelled = Set<String>()
  private static let endpoint = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
  private static let responseLimit = 16 * 1024 * 1024

  private func projectRoot() throws -> URL {
    let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return documents.appendingPathComponent("Projects", isDirectory: true)
  }

  private func resolveProject(_ uri: String) throws -> URL {
    guard uri.hasPrefix("project://") else { throw hostError("INVALID_INPUT", "Speech upload accepts project:// media only") }
    let encoded = String(uri.dropFirst("project://".count)); let relative = encoded.removingPercentEncoding ?? encoded
    if relative.split(separator: "/").contains("..") { throw hostError("PERMISSION_DENIED", "Path traversal rejected") }
    let root = try projectRoot().standardizedFileURL; let target = root.appendingPathComponent(relative).standardizedFileURL
    guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { throw hostError("PERMISSION_DENIED", "URI escaped project sandbox") }
    guard fm.fileExists(atPath: target.path) else { throw hostError("NOT_FOUND", "Media asset does not exist") }
    return target
  }

  private func mime(_ url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "flac": return "audio/flac"; case "mp3", "mpeg", "mpga": return "audio/mpeg"; case "mp4": return "video/mp4"; case "m4a": return "audio/mp4"; case "ogg": return "audio/ogg"; case "wav": return "audio/wav"; case "webm": return "audio/webm"; default: return "application/octet-stream"
    }
  }

  private func isCancelled(_ requestId: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(requestId) }
  private func ensureActive(_ requestId: String) throws { if isCancelled(requestId) { throw hostError("CANCELLED", "Transcription cancelled") } }
  private func append(_ text: String, to handle: FileHandle) throws { try handle.write(contentsOf: Data(text.utf8)) }

  private func makeMultipartBody(requestId: String, source: URL, model: String, language: String?, prompt: String?, boundary: String) throws -> URL {
    let directory = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("SpeechUploads", isDirectory: true)
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let outputURL = directory.appendingPathComponent("\(UUID().uuidString).multipart")
    guard fm.createFile(atPath: outputURL.path, contents: nil) else { throw hostError("STORAGE_ERROR", "Unable to create speech upload body") }
    let output = try FileHandle(forWritingTo: outputURL); defer { try? output.close() }
    func field(_ name: String, _ value: String) throws { try append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n", to: output) }

    do {
      try ensureActive(requestId); try field("model", model)
      if let language, !language.isEmpty { try field("language", language) }
      if model == "gpt-4o-transcribe-diarize" { try field("response_format", "diarized_json"); try field("chunking_strategy", "auto") }
      else { try field("response_format", "verbose_json"); try field("timestamp_granularities[]", "segment"); try field("timestamp_granularities[]", "word"); if let prompt, !prompt.isEmpty { try field("prompt", prompt) } }
      let safeName = source.lastPathComponent.replacingOccurrences(of: "\"", with: "")
      try append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime(source))\r\n\r\n", to: output)
      let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
      while let chunk = try input.read(upToCount: 256 * 1024), !chunk.isEmpty { try ensureActive(requestId); try output.write(contentsOf: chunk) }
      try ensureActive(requestId); try append("\r\n--\(boundary)--\r\n", to: output); try output.synchronize(); return outputURL
    } catch { try? fm.removeItem(at: outputURL); throw error }
  }

  private func cleanup(_ requestId: String) {
    lock.lock(); let body = temporaryBodies.removeValue(forKey: requestId); active.removeValue(forKey: requestId); starting.remove(requestId); cancelled.remove(requestId); lock.unlock()
    if let body { try? fm.removeItem(at: body) }
  }

  public func transcribeOpenAI(_ requestJSON: String, completion: @escaping (String?, NSError?) -> Void) {
    let value: [String: Any]; let requestId: String
    do {
      guard let parsed = try JSONSerialization.jsonObject(with: Data(requestJSON.utf8)) as? [String: Any], let id = parsed["requestId"] as? String else { throw hostError("INVALID_INPUT", "Malformed speech request") }
      value = parsed; requestId = id
    } catch { completion(nil, error as NSError); return }
    lock.lock(); starting.insert(requestId); lock.unlock()

    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { completion(nil, NSError(domain: "VideoAgentSpeechHost", code: 1)); return }
      do {
        try self.ensureActive(requestId)
        guard let uri = value["uri"] as? String, let apiKey = value["apiKey"] as? String, let model = value["model"] as? String else { throw self.hostError("INVALID_INPUT", "Malformed speech request") }
        guard model == "gpt-4o-transcribe-diarize" || model == "whisper-1" else { throw self.hostError("INVALID_INPUT", "Unsupported ASR model") }
        guard !apiKey.isEmpty else { throw self.hostError("AUTH_REQUIRED", "API key required") }
        let source = try self.resolveProject(uri); let boundary = "video-agent-\(UUID().uuidString)"
        let body = try self.makeMultipartBody(requestId: requestId, source: source, model: model, language: value["language"] as? String, prompt: model == "whisper-1" ? value["prompt"] as? String : nil, boundary: boundary)
        try self.ensureActive(requestId)
        var request = URLRequest(url: Self.endpoint); request.httpMethod = "POST"; request.timeoutInterval = ((value["timeoutMs"] as? NSNumber)?.doubleValue ?? 1_800_000) / 1000
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization"); request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let task = URLSession.shared.uploadTask(with: request, fromFile: body) { [weak self] data, response, error in
          defer { self?.cleanup(requestId) }
          if let error { completion(nil, error as NSError); return }
          guard let self, let http = response as? HTTPURLResponse else { completion(nil, self?.hostError("NETWORK_UNAVAILABLE", "Missing HTTP response")); return }
          let data = data ?? Data(); if data.count > Self.responseLimit { completion(nil, self.hostError("PROVIDER_ERROR", "Transcription response exceeded \(Self.responseLimit) bytes")); return }
          let text = String(data: data, encoding: .utf8) ?? ""
          if !(200...299).contains(http.statusCode) { completion(nil, self.hostError("PROVIDER_ERROR", "OpenAI transcription failed (\(http.statusCode)): \(text.prefix(1000))")); return }
          completion(text, nil)
        }
        self.lock.lock(); self.starting.remove(requestId); let cancelledBeforeStart = self.cancelled.contains(requestId); if !cancelledBeforeStart { self.temporaryBodies[requestId] = body; self.active[requestId] = task }; self.lock.unlock()
        if cancelledBeforeStart { try? self.fm.removeItem(at: body); self.cleanup(requestId); completion(nil, self.hostError("CANCELLED", "Transcription cancelled")); return }
        task.resume()
      } catch { self.cleanup(requestId); completion(nil, error as NSError) }
    }
  }

  public func cancelTranscription(_ requestId: String) {
    lock.lock(); let task = active[requestId]; if starting.contains(requestId) || task != nil { cancelled.insert(requestId) }; lock.unlock(); task?.cancel()
  }

  private func hostError(_ code: String, _ message: String) -> NSError { NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(code): \(message)"]) }
}
