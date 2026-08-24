import AVFoundation
import BackgroundTasks
import CommonCrypto
import CryptoKit
import Foundation
import PhotosUI
import Security
import UIKit

@objcMembers public final class NativeVideoHostService: NSObject, UIDocumentPickerDelegate {
  private let fm = FileManager.default
  private var pickerContinuation: CheckedContinuation<[String: Any]?, Error>?
  private var exports: [String: AVAssetExportSession] = [:]
  /// Picked sources are kept as the original URL objects. A URL rebuilt from a string does not
  /// carry the picker's security scope, and the JS boundary only carries strings. This covers
  /// same-session import; a cross-session re-import needs a persisted security-scoped bookmark.
  private var pickedSources: [String: URL] = [:]

  private static let logicalSchemes = ["project://", "cache://", "import://", "export://"]
  private func isLogical(_ uri: String) -> Bool { Self.logicalSchemes.contains { uri.hasPrefix($0) } }

  /// Resolves an external (non-logical) URI back to the picked URL object when one is known.
  private func externalURL(_ uri: String) -> URL { pickedSources[uri] ?? URL(string: uri) ?? URL(fileURLWithPath: uri) }

  /// Runs `body` while holding security-scoped access, releasing it only after `body` returns.
  private func withAccess<T>(_ url: URL, _ body: () throws -> T) rethrows -> T {
    let accessing = url.startAccessingSecurityScopedResource()
    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
    return try body()
  }

  private func root(_ name: String) throws -> URL {
    let base: FileManager.SearchPathDirectory = name == "cache" ? .cachesDirectory : .documentDirectory
    return try fm.url(for: base, in: .userDomainMask, appropriateFor: nil, create: true)
  }

  public func resolve(_ logical: String) throws -> URL {
    // Only logical URIs resolve here. External URLs must go through externalURL(_:) so that
    // sandbox containment below cannot be bypassed by passing a raw file:// path.
    guard let marker = logical.range(of: "://") else { throw hostError("INVALID_INPUT", "Malformed logical URI") }
    let scheme = String(logical[..<marker.lowerBound]); let path = String(logical[marker.upperBound...]).removingPercentEncoding ?? ""
    if path.split(separator: "/").contains("..") { throw hostError("PERMISSION_DENIED", "Path traversal rejected") }
    let base: URL
    switch scheme { case "project": base = try root("documents").appendingPathComponent("Projects", isDirectory: true); case "cache", "import": base = try root("cache").appendingPathComponent(scheme.capitalized, isDirectory: true); case "export": base = try root("documents").appendingPathComponent("Exports", isDirectory: true); default: throw hostError("INVALID_INPUT", "Unsupported URI scheme") }
    let result = base.appendingPathComponent(path); let normalizedBase = base.standardizedFileURL.path; guard result.standardizedFileURL.path.hasPrefix(normalizedBase) else { throw hostError("PERMISSION_DENIED", "URI escaped sandbox") }; return result
  }

  public func read(_ uri: String) throws -> [NSNumber] { try [UInt8](Data(contentsOf: resolve(uri))).map(NSNumber.init(value:)) }
  public func write(_ uri: String, bytes: [NSNumber], atomic: Bool, createOnly: Bool) throws { let url = try resolve(uri); try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true); if createOnly && fm.fileExists(atPath: url.path) { throw hostError("INVALID_INPUT", "Destination exists") }; let data = Data(bytes.map { $0.uint8Value }); if atomic { let temporary = url.appendingPathExtension("\(UUID().uuidString).tmp"); try data.write(to: temporary, options: .atomic); if fm.fileExists(atPath: url.path) { _ = try fm.replaceItemAt(url, withItemAt: temporary) } else { try fm.moveItem(at: temporary, to: url) } } else { try data.write(to: url) } }
  public func remove(_ uri: String) throws { let url = try resolve(uri); if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) } }
  public func exists(_ uri: String) -> Bool { (try? resolve(uri)).map { fm.fileExists(atPath: $0.path) } ?? false }
  public func statJSON(_ uri: String) throws -> String { let url = isLogical(uri) ? try resolve(uri) : externalURL(uri); let values = try withAccess(url) { try fm.attributesOfItem(atPath: url.path) }; return try json(["sizeBytes": values[.size] as? NSNumber ?? 0, "kind": (values[.type] as? FileAttributeType) == .typeDirectory ? "directory" : "file", "modifiedAt": ISO8601DateFormatter().string(from: values[.modificationDate] as? Date ?? Date.distantPast)]) }
  public func listJSON(_ uri: String) throws -> String { let url = try resolve(uri); if !fm.fileExists(atPath: url.path) { return "[]" }; let keys: [URLResourceKey] = [.isRegularFileKey]; let values = (fm.enumerator(at: url, includingPropertiesForKeys: keys)?.allObjects as? [URL] ?? []).filter { (try? $0.resourceValues(forKeys: Set(keys)).isRegularFile) == true }.map { logicalURL(for: $0) }; return try json(values) }
  public func copy(_ source: String, destination: String) throws { let target = try resolve(destination); try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true); let sourceURL = isLogical(source) ? try resolve(source) : externalURL(source); try withAccess(sourceURL) { try fm.copyItem(at: sourceURL, to: target) } }
  public func diskFreeBytes() throws -> NSNumber { let values = try root("documents").resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]); return NSNumber(value: values.volumeAvailableCapacityForImportantUsage ?? 0) }

  @MainActor public func pickVideo() async throws -> [String: Any]? { try await withCheckedThrowingContinuation { continuation in pickerContinuation = continuation; let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.movie], asCopy: false); picker.delegate = self; topViewController()?.present(picker, animated: true) } }
  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { guard let url = urls.first else { pickerContinuation?.resume(returning: nil); pickerContinuation = nil; return }; do { let size = try withAccess(url) { try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0 }; pickedSources[url.absoluteString] = url; pickerContinuation?.resume(returning: ["sourceUri": url.absoluteString, "displayName": url.lastPathComponent, "mediaType": "video/*", "sizeBytes": size]) } catch { pickerContinuation?.resume(throwing: error) }; pickerContinuation = nil }
  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickerContinuation?.resume(returning: nil); pickerContinuation = nil }

  public func probeJSON(_ uri: String) async throws -> String { let asset = AVURLAsset(url: try resolve(uri)); let duration = try await asset.load(.duration); let video = try await asset.loadTracks(withMediaType: .video).first; let audio = try await asset.loadTracks(withMediaType: .audio).first; var result: [String: Any] = ["durationUs": max(0, Int64(CMTimeGetSeconds(duration) * 1_000_000)), "sizeBytes": (try? fm.attributesOfItem(atPath: resolve(uri).path)[.size]) as? NSNumber ?? 0]; if let video { let size = try await video.load(.naturalSize); let transform = try await video.load(.preferredTransform); let transformed = size.applying(transform); result["width"] = Int(abs(transformed.width)); result["height"] = Int(abs(transformed.height)); let fps = try await video.load(.nominalFrameRate); if fps > 0 { result["frameRate"] = ["numerator": Int(fps * 1000), "denominator": 1000] }; result["rotation"] = Int(atan2(transform.b, transform.a) * 180 / .pi); result["videoCodec"] = try await video.load(.formatDescriptions).first.flatMap(codecName) }; if let audio { result["audioCodec"] = try await audio.load(.formatDescriptions).first.flatMap(codecName); if let format = try await audio.load(.formatDescriptions).first as? CMAudioFormatDescription, let stream = CMAudioFormatDescriptionGetStreamBasicDescription(format) { result["sampleRate"] = Int(stream.pointee.mSampleRate); result["channels"] = Int(stream.pointee.mChannelsPerFrame) } }; result["container"] = resolve(uri).pathExtension.lowercased(); return try json(result) }

  public func rendererCapabilitiesJSON() throws -> String { try json(["trim": true, "concat": true, "crop": true, "scale": true, "preserveAudio": true, "speed": false, "captionBurnIn": false, "audioDucking": false, "overlay": false, "backgroundExport": false]) }
  public func renderJSON(_ specJSON: String) async throws -> String {
    let spec = try JSONSerialization.jsonObject(with: Data(specJSON.utf8)) as! [String: Any]; let timeline = try JSONSerialization.jsonObject(with: Data((spec["timelineJson"] as! String).utf8)) as! [String: Any]; let assets = try JSONSerialization.jsonObject(with: Data((spec["assetsJson"] as! String).utf8)) as! [[String: Any]]; let uriById = Dictionary(uniqueKeysWithValues: assets.compactMap { item in (item["assetId"] as? String).flatMap { id in (item["uri"] as? String).map { (id, $0) } } }); let composition = AVMutableComposition(); guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw hostError("MEDIA_CODEC_UNSUPPORTED", "Unable to create video track") }; let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid); var cursor = CMTime.zero
    let tracks = timeline["tracks"] as? [[String: Any]] ?? []; let clips = tracks.filter { ($0["type"] as? String) == "video" }.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.sorted { ($0["timelineInUs"] as? NSNumber)?.int64Value ?? 0 < ($1["timelineInUs"] as? NSNumber)?.int64Value ?? 0 }
    // Output geometry comes from the portable layer, which derives it from the timeline and the
    // render mode. This used to be a fixed AVAssetExportPreset1280x720, which silently reframed
    // every portrait project and capped final export at 720p.
    let renderWidth = CGFloat((spec["outputWidth"] as! NSNumber).doubleValue)
    let renderHeight = CGFloat((spec["outputHeight"] as! NSNumber).doubleValue)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    for clip in clips {
      guard let assetId = clip["assetId"] as? String, let uri = uriById[assetId] else { continue }
      let asset = AVURLAsset(url: try resolve(uri))
      guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first else { throw hostError("MEDIA_CODEC_UNSUPPORTED", "Missing video track") }
      let start = CMTime(value: (clip["sourceInUs"] as! NSNumber).int64Value, timescale: 1_000_000)
      let end = CMTime(value: (clip["sourceOutUs"] as! NSNumber).int64Value, timescale: 1_000_000)
      let range = CMTimeRange(start: start, end: end)
      try videoTrack.insertTimeRange(range, of: sourceVideo, at: cursor)
      if let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first { try audioTrack?.insertTimeRange(range, of: sourceAudio, at: cursor) }
      // Fit the oriented source inside the render size without cropping.
      let preferred = try await sourceVideo.load(.preferredTransform)
      let oriented = (try await sourceVideo.load(.naturalSize)).applying(preferred)
      let sourceSize = CGSize(width: abs(oriented.width), height: abs(oriented.height))
      let scale = sourceSize.width > 0 && sourceSize.height > 0 ? min(renderWidth / sourceSize.width, renderHeight / sourceSize.height) : 1
      let offsetX = (renderWidth - sourceSize.width * scale) / 2
      let offsetY = (renderHeight - sourceSize.height * scale) / 2
      layerInstruction.setTransform(preferred.concatenating(CGAffineTransform(scaleX: scale, y: scale)).concatenating(CGAffineTransform(translationX: offsetX, y: offsetY)), at: cursor)
      cursor = CMTimeAdd(cursor, range.duration)
    }
    let frameRate = timeline["frameRate"] as? [String: Any]
    let frameNumerator = (frameRate?["numerator"] as? NSNumber)?.int32Value ?? 30
    let frameDenominator = (frameRate?["denominator"] as? NSNumber)?.int64Value ?? 1
    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = CGSize(width: renderWidth, height: renderHeight)
    videoComposition.frameDuration = CMTime(value: frameDenominator, timescale: max(1, frameNumerator))
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: cursor)
    instruction.layerInstructions = [layerInstruction]
    videoComposition.instructions = [instruction]
    let output = try resolve(spec["outputUri"] as! String); try fm.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true); try? fm.removeItem(at: output)
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw hostError("MEDIA_CODEC_UNSUPPORTED", "No compatible AVAssetExportSession") }
    session.outputURL = output; session.outputFileType = .mp4; session.shouldOptimizeForNetworkUse = true; session.videoComposition = videoComposition
    let jobId = spec["jobId"] as! String; exports[jobId] = session; await session.export(); exports.removeValue(forKey: jobId); if let error = session.error { throw error }
    return try json(["outputUri": spec["outputUri"]!, "durationUs": Int64(CMTimeGetSeconds(composition.duration) * 1_000_000), "warnings": []])
  }
  public func cancelRender(_ id: String) { exports[id]?.cancelExport() }

  public func httpJSON(_ requestJSON: String) async throws -> String { let value = try JSONSerialization.jsonObject(with: Data(requestJSON.utf8)) as! [String: Any]; guard let target = value["url"] as? String, let url = URL(string: target) else { throw hostError("INVALID_INPUT", "Invalid HTTP URL") }; var request = URLRequest(url: url); request.httpMethod = value["method"] as? String ?? "GET"; request.httpBody = (value["bodyBase64"] as? String).flatMap { Data(base64Encoded: $0) }; (value["headers"] as? [String: String])?.forEach { request.setValue($1, forHTTPHeaderField: $0) }; request.timeoutInterval = ((value["timeoutMs"] as? NSNumber)?.doubleValue ?? 120_000) / 1000; let (data, response) = try await URLSession.shared.data(for: request); guard let http = response as? HTTPURLResponse else { throw hostError("NETWORK_UNAVAILABLE", "Missing HTTP response") }; return try json(["status": http.statusCode, "headers": http.allHeaderFields.reduce(into: [String: String]()) { if let key = $1.key as? String { $0[key.lowercased()] = String(describing: $1.value) } }, "bodyBase64": data.base64EncodedString()]) }
  public func scheduleBackgroundJSON(_ taskJSON: String) throws { var pending = UserDefaults.standard.stringArray(forKey: "video-agent.pending-jobs") ?? []; let task = try JSONSerialization.jsonObject(with: Data(taskJSON.utf8)) as! [String: Any]; guard let id = task["id"] as? String else { throw hostError("INVALID_INPUT", "Background task id required") }; if !pending.contains(id) { pending.append(id); UserDefaults.standard.set(pending, forKey: "video-agent.pending-jobs") }; let request = BGProcessingTaskRequest(identifier: "com.videoagent.mobile.processing"); request.requiresNetworkConnectivity = task["requiresNetwork"] as? Bool ?? false; request.requiresExternalPower = task["requiresExternalPower"] as? Bool ?? false; try? BGTaskScheduler.shared.submit(request) }
  public func cancelBackground(_ id: String) { var pending = UserDefaults.standard.stringArray(forKey: "video-agent.pending-jobs") ?? []; pending.removeAll { $0 == id }; UserDefaults.standard.set(pending, forKey: "video-agent.pending-jobs") }
  public func pendingBackgroundJSON() throws -> String { try json((UserDefaults.standard.stringArray(forKey: "video-agent.pending-jobs") ?? []).map { ["id": $0, "kind": "durable-mobile-job"] }) }
  public func permissionStatus(_ kind: String) -> String { if kind == "photos" { switch PHPhotoLibrary.authorizationStatus(for: .readWrite) { case .authorized: return "granted"; case .limited: return "limited"; case .denied, .restricted: return "denied"; default: return "unknown" } }; return "unknown" }
  public func requestPermission(_ kind: String) async -> String { if kind == "photos" { let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite); switch status { case .authorized: return "granted"; case .limited: return "limited"; default: return "denied" } }; return "denied" }
  public func resourceBudgetJSON() throws -> String { let physical = ProcessInfo.processInfo.physicalMemory; let thermal: String; switch ProcessInfo.processInfo.thermalState { case .nominal: thermal = "nominal"; case .fair: thermal = "fair"; case .serious: thermal = "serious"; case .critical: thermal = "critical"; @unknown default: thermal = "unknown" }; return try json(["maxWorkingSetBytes": min(physical / 3, 1_500_000_000), "maxConcurrentMediaJobs": 1, "previewMaxWidth": 1280, "previewMaxDurationUs": 120_000_000, "thermalState": thermal, "powerState": UIDevice.current.batteryState == .charging ? "charging" : "battery"]) }

  public func secureSet(_ key: String, value: String) throws { let data = Data(value.utf8); SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: "video-agent", kSecAttrAccount: key] as CFDictionary); let status = SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: "video-agent", kSecAttrAccount: key, kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil); guard status == errSecSuccess else { throw hostError("STORAGE_ERROR", "Keychain write failed \(status)") } }
  public func secureGet(_ key: String) throws -> String? { var item: CFTypeRef?; let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: "video-agent", kSecAttrAccount: key, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &item); if status == errSecItemNotFound { return nil }; guard status == errSecSuccess, let data = item as? Data else { throw hostError("STORAGE_ERROR", "Keychain read failed \(status)") }; return String(data: data, encoding: .utf8) }
  public func secureDelete(_ key: String) throws { let status = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: "video-agent", kSecAttrAccount: key] as CFDictionary); if status != errSecSuccess && status != errSecItemNotFound { throw hostError("STORAGE_ERROR", "Keychain delete failed \(status)") } }
  public func sha256JSON(_ value: String) -> String { let decoded = try? JSONSerialization.jsonObject(with: Data(value.utf8)); let data: Data; if let text = decoded as? String { data = Data(text.utf8) } else if let values = decoded as? [NSNumber] { data = Data(values.map { $0.uint8Value }) } else { data = Data(value.utf8) }; return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  public func sha256File(_ uri: String) throws -> String { SHA256.hash(data: try Data(contentsOf: resolve(uri), options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined() }
  public func randomBytes(_ length: Int) throws -> [NSNumber] { var bytes = [UInt8](repeating: 0, count: length); guard SecRandomCopyBytes(kSecRandomDefault, length, &bytes) == errSecSuccess else { throw hostError("INTERNAL", "Secure random failed") }; return bytes.map(NSNumber.init(value:)) }
  public func createID() -> String { UUID().uuidString.lowercased() }

  private func logicalURL(for url: URL) -> String { let roots = [(try? root("documents").appendingPathComponent("Projects"), "project"), (try? root("cache").appendingPathComponent("Cache"), "cache"), (try? root("documents").appendingPathComponent("Exports"), "export")]; for (base, scheme) in roots { if let base, url.path.hasPrefix(base.path) { return "\(scheme)://" + url.path.dropFirst(base.path.count).trimmingCharacters(in: CharacterSet(charactersIn: "/")) } }; return url.absoluteString }
  private func json(_ value: Any) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)! }
  private func codecName(_ description: CMFormatDescription) -> String { let value = CMFormatDescriptionGetMediaSubType(description); return String(format: "%c%c%c%c", (value >> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255) }
  private func hostError(_ code: String, _ message: String) -> NSError { NSError(domain: "VideoAgentHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(code): \(message)"]) }
  @MainActor private func topViewController() -> UIViewController? { var current = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController; while let presented = current?.presentedViewController { current = presented }; return current }

  public func pickVideoCallback(_ completion: @escaping (String?, NSError?) -> Void) { Task { do { let value = try await pickVideo(); completion(value.flatMap { try? json($0) } ?? "", nil) } catch { completion(nil, error as NSError) } } }
  public func probeJSONCallback(_ uri: String, completion: @escaping (String?, NSError?) -> Void) { Task { do { completion(try await probeJSON(uri), nil) } catch { completion(nil, error as NSError) } } }
  public func renderJSONCallback(_ spec: String, completion: @escaping (String?, NSError?) -> Void) { Task { do { completion(try await renderJSON(spec), nil) } catch { completion(nil, error as NSError) } } }
  public func httpJSONCallback(_ request: String, completion: @escaping (String?, NSError?) -> Void) { Task { do { completion(try await httpJSON(request), nil) } catch { completion(nil, error as NSError) } } }
  public func requestPermissionCallback(_ kind: String, completion: @escaping (String?, NSError?) -> Void) { Task { completion(await requestPermission(kind), nil) } }
}
