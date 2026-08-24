import AVFoundation
import Foundation

@objcMembers public final class NativeSpeechHostService: NSObject {
  private let fm = FileManager.default
  private let lock = NSLock()
  private var active: [String: URLSessionTask] = [:]
  private var temporaryBodies: [String: URL] = [:]
  private var starting = Set<String>()
  private var cancelled = Set<String>()
  private static let transcriptionEndpoint = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
  private static let speechEndpoint = URL(string: "https://api.openai.com/v1/audio/speech")!
  private static let responseLimit = 16 * 1024 * 1024
  private static let maxTTSFileBytes = 64 * 1024 * 1024
  private static let maxTTSTextChars = 4096

  private func projectRoot() throws -> URL {
    let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return documents.appendingPathComponent("Projects", isDirectory: true)
  }

  private func projectURL(_ uri: String, mustExist: Bool) throws -> URL {
    guard uri.hasPrefix("project://") else { throw hostError("INVALID_INPUT", "Speech I/O accepts project:// paths only") }
    let encoded = String(uri.dropFirst("project://".count)); let relative = encoded.removingPercentEncoding ?? encoded
    if relative.isEmpty || relative.split(separator: "/").contains("..") { throw hostError("PERMISSION_DENIED", "Invalid project path") }
    let root = try projectRoot().standardizedFileURL; let target = root.appendingPathComponent(relative).standardizedFileURL
    guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { throw hostError("PERMISSION_DENIED", "URI escaped project sandbox") }
    if mustExist && !fm.fileExists(atPath: target.path) { throw hostError("NOT_FOUND", "Media asset does not exist") }
    return target
  }

  private func resolveProject(_ uri: String) throws -> URL { try projectURL(uri, mustExist: true) }
  private func resolveProjectOutput(_ uri: String) throws -> URL { try projectURL(uri, mustExist: false) }

  private func mime(_ url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "flac": return "audio/flac"; case "mp3", "mpeg", "mpga": return "audio/mpeg"; case "mp4": return "video/mp4"; case "m4a": return "audio/mp4"; case "ogg": return "audio/ogg"; case "wav": return "audio/wav"; case "webm": return "audio/webm"; default: return "application/octet-stream"
    }
  }

  private func isCancelled(_ requestId: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(requestId) }
  private func ensureActive(_ requestId: String) throws { if isCancelled(requestId) { throw hostError("CANCELLED", "Speech request cancelled") } }
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

  private func register(_ requestId: String, task: URLSessionTask, body: URL? = nil) -> Bool {
    lock.lock(); defer { lock.unlock() }
    starting.remove(requestId)
    if cancelled.contains(requestId) { return false }
    active[requestId] = task
    if let body { temporaryBodies[requestId] = body }
    return true
  }

  public func transcribeOpenAI(_ requestJSON: String, completion: @escaping (String?, NSError?) -> Void) {
    let value: [String: Any]; let requestId: String
    do {
      guard let parsed = try JSONSerialization.jsonObject(with: Data(requestJSON.utf8)) as? [String: Any], let id = parsed["requestId"] as? String else { throw hostError("INVALID_INPUT", "Malformed speech request") }
      value = parsed; requestId = id
    } catch { completion(nil, error as NSError); return }
    lock.lock(); starting.insert(requestId); lock.unlock()

    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let host = self else { completion(nil, NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech host was released"])); return }
      do {
        try host.ensureActive(requestId)
        guard let uri = value["uri"] as? String, let apiKey = value["apiKey"] as? String, let model = value["model"] as? String else { throw host.hostError("INVALID_INPUT", "Malformed speech request") }
        guard model == "gpt-4o-transcribe-diarize" || model == "whisper-1" else { throw host.hostError("INVALID_INPUT", "Unsupported ASR model") }
        guard !apiKey.isEmpty else { throw host.hostError("AUTH_REQUIRED", "API key required") }
        let source = try host.resolveProject(uri); let boundary = "video-agent-\(UUID().uuidString)"
        let body = try host.makeMultipartBody(requestId: requestId, source: source, model: model, language: value["language"] as? String, prompt: model == "whisper-1" ? value["prompt"] as? String : nil, boundary: boundary)
        try host.ensureActive(requestId)
        var request = URLRequest(url: Self.transcriptionEndpoint); request.httpMethod = "POST"; request.timeoutInterval = ((value["timeoutMs"] as? NSNumber)?.doubleValue ?? 1_800_000) / 1000
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization"); request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let task = URLSession.shared.uploadTask(with: request, fromFile: body) { [weak host] data, response, error in
          guard let host else { completion(nil, NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech host was released"])); return }
          defer { host.cleanup(requestId) }
          if let error { completion(nil, error as NSError); return }
          guard let http = response as? HTTPURLResponse else { completion(nil, host.hostError("NETWORK_UNAVAILABLE", "Missing HTTP response")); return }
          let responseData = data ?? Data(); if responseData.count > Self.responseLimit { completion(nil, host.hostError("PROVIDER_ERROR", "Transcription response exceeded \(Self.responseLimit) bytes")); return }
          let text = String(data: responseData, encoding: .utf8) ?? ""
          if !(200...299).contains(http.statusCode) { completion(nil, host.hostError("PROVIDER_ERROR", "OpenAI transcription failed (\(http.statusCode)): \(text.prefix(1000))")); return }
          completion(text, nil)
        }
        if !host.register(requestId, task: task, body: body) { try? host.fm.removeItem(at: body); host.cleanup(requestId); completion(nil, host.hostError("CANCELLED", "Transcription cancelled")); return }
        task.resume()
      } catch { host.cleanup(requestId); completion(nil, error as NSError) }
    }
  }

  private func errorPreview(_ url: URL) -> String {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }; defer { try? handle.close() }
    let data = (try? handle.read(upToCount: 1000)) ?? Data(); return String(data: data, encoding: .utf8) ?? ""
  }

  private func measureWav(_ url: URL) throws -> (Double, Double) {
    let audio = try AVAudioFile(forReading: url)
    let sampleRate = audio.fileFormat.sampleRate
    guard sampleRate > 0, audio.length > 0 else { throw hostError("PROVIDER_ERROR", "OpenAI TTS returned empty audio") }
    return (Double(audio.length) / sampleRate, sampleRate)
  }

  public func synthesizeOpenAI(_ requestJSON: String, completion: @escaping (String?, NSError?) -> Void) {
    let value: [String: Any]; let requestId: String
    do {
      guard let parsed = try JSONSerialization.jsonObject(with: Data(requestJSON.utf8)) as? [String: Any], let id = parsed["requestId"] as? String else { throw hostError("INVALID_INPUT", "Malformed TTS request") }
      value = parsed; requestId = id
    } catch { completion(nil, error as NSError); return }
    lock.lock(); starting.insert(requestId); lock.unlock()

    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let host = self else { completion(nil, NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech host was released"])); return }
      do {
        try host.ensureActive(requestId)
        guard let outputUri = value["outputUri"] as? String, let apiKey = value["apiKey"] as? String, let model = value["model"] as? String, let rawText = value["text"] as? String, let voiceId = value["voiceId"] as? String else { throw host.hostError("INVALID_INPUT", "Malformed TTS request") }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines); guard !text.isEmpty && text.count <= Self.maxTTSTextChars else { throw host.hostError("INVALID_INPUT", "TTS text must be 1-\(Self.maxTTSTextChars) characters") }
        guard !apiKey.isEmpty && !model.isEmpty && !voiceId.isEmpty else { throw host.hostError("AUTH_REQUIRED", "TTS provider configuration is incomplete") }
        let speed = (value["speed"] as? NSNumber)?.doubleValue ?? 1; guard speed >= 0.25 && speed <= 4 else { throw host.hostError("INVALID_INPUT", "TTS speed must be between 0.25 and 4") }
        let target = try host.resolveProjectOutput(outputUri); guard !host.fm.fileExists(atPath: target.path) else { throw host.hostError("INVALID_INPUT", "TTS output already exists") }
        try host.fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let body = try JSONSerialization.data(withJSONObject: ["model": model, "input": text, "voice": voiceId, "response_format": "wav", "speed": speed])
        var request = URLRequest(url: Self.speechEndpoint); request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = ((value["timeoutMs"] as? NSNumber)?.doubleValue ?? 120_000) / 1000
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("audio/wav", forHTTPHeaderField: "Accept")
        let task = URLSession.shared.downloadTask(with: request) { [weak host] location, response, error in
          guard let host else { completion(nil, NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech host was released"])); return }
          defer { host.cleanup(requestId) }
          if let error { completion(nil, error as NSError); return }
          guard let http = response as? HTTPURLResponse, let location else { completion(nil, host.hostError("NETWORK_UNAVAILABLE", "Missing TTS response")); return }
          if !(200...299).contains(http.statusCode) { completion(nil, host.hostError("PROVIDER_ERROR", "OpenAI TTS failed (\(http.statusCode)): \(host.errorPreview(location))")); return }
          do {
            let size = (try host.fm.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size > 0 && size <= Self.maxTTSFileBytes else { throw host.hostError("PROVIDER_ERROR", "TTS response size is invalid or exceeds \(Self.maxTTSFileBytes) bytes") }
            try host.ensureActive(requestId)
            do { try host.fm.moveItem(at: location, to: target) } catch { try host.fm.copyItem(at: location, to: target) }
            let (duration, sampleRate) = try host.measureWav(target)
            let result = try JSONSerialization.data(withJSONObject: ["durationSeconds": duration, "sampleRate": sampleRate, "model": model, "voiceId": voiceId])
            completion(String(data: result, encoding: .utf8), nil)
          } catch { try? host.fm.removeItem(at: target); completion(nil, error as NSError) }
        }
        if !host.register(requestId, task: task) { host.cleanup(requestId); completion(nil, host.hostError("CANCELLED", "TTS request cancelled")); return }
        task.resume()
      } catch { host.cleanup(requestId); completion(nil, error as NSError) }
    }
  }

  public func cancelTranscription(_ requestId: String) { cancel(requestId) }
  public func cancelSynthesis(_ requestId: String) { cancel(requestId) }
  private func cancel(_ requestId: String) {
    lock.lock(); let task = active[requestId]; if starting.contains(requestId) || task != nil { cancelled.insert(requestId) }; lock.unlock(); task?.cancel()
  }

  private func hostError(_ code: String, _ message: String) -> NSError { NSError(domain: "VideoAgentSpeechHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(code): \(message)"]) }
}
