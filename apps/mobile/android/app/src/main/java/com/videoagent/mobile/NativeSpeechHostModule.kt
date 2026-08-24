package com.videoagent.mobile

import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@ReactModule(name = NativeSpeechHostModule.NAME)
class NativeSpeechHostModule(private val context: ReactApplicationContext) : NativeSpeechHostSpec(context) {
  companion object {
    const val NAME = "NativeSpeechHost"
    private const val OPENAI_TRANSCRIPTIONS = "https://api.openai.com/v1/audio/transcriptions"
    private const val RESPONSE_LIMIT = 16 * 1024 * 1024
  }

  private val active = ConcurrentHashMap<String, HttpURLConnection>()
  private val starting = ConcurrentHashMap.newKeySet<String>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  override fun getName() = NAME

  private fun resolveProject(uri: String): File {
    require(uri.startsWith("project://")) { "INVALID_INPUT: speech upload accepts project:// media only" }
    val relative = Uri.decode(uri.removePrefix("project://"))
    require(relative.split('/').none { it == ".." }) { "PERMISSION_DENIED: path traversal" }
    val base = File(context.filesDir, "Projects").canonicalFile
    val target = File(base, relative).canonicalFile
    require(target.path == base.path || target.path.startsWith(base.path + File.separator)) { "PERMISSION_DENIED: URI escaped project sandbox" }
    require(target.isFile) { "NOT_FOUND: media asset does not exist" }
    return target
  }

  private fun mime(file: File) = when (file.extension.lowercase()) {
    "flac" -> "audio/flac"; "mp3", "mpeg", "mpga" -> "audio/mpeg"; "mp4" -> "video/mp4"; "m4a" -> "audio/mp4"; "ogg" -> "audio/ogg"; "wav" -> "audio/wav"; "webm" -> "audio/webm"; else -> "application/octet-stream"
  }

  private fun ensureActive(requestId: String) { if (cancelled.contains(requestId)) error("CANCELLED: transcription cancelled") }

  private fun readLimited(input: InputStream?, requestId: String): String {
    if (input == null) return ""
    input.use { stream ->
      val output = ByteArrayOutputStream(); val buffer = ByteArray(32 * 1024); var total = 0
      while (true) {
        ensureActive(requestId); val count = stream.read(buffer); if (count < 0) break; total += count
        if (total > RESPONSE_LIMIT) error("PROVIDER_ERROR: transcription response exceeded $RESPONSE_LIMIT bytes")
        output.write(buffer, 0, count)
      }
      return output.toString(Charsets.UTF_8.name())
    }
  }

  private fun transcribe(value: JSONObject): String {
    val requestId = value.getString("requestId"); ensureActive(requestId)
    val model = value.getString("model")
    require(model == "gpt-4o-transcribe-diarize" || model == "whisper-1") { "INVALID_INPUT: unsupported ASR model" }
    val apiKey = value.getString("apiKey"); require(apiKey.isNotBlank()) { "AUTH_REQUIRED: API key required" }
    val file = resolveProject(value.getString("uri")); ensureActive(requestId)
    val boundary = "video-agent-${UUID.randomUUID()}"
    val connection = URL(OPENAI_TRANSCRIPTIONS).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"; connection.connectTimeout = value.optInt("timeoutMs", 30 * 60 * 1000); connection.readTimeout = connection.connectTimeout; connection.doOutput = true
    connection.setChunkedStreamingMode(64 * 1024); connection.setRequestProperty("Authorization", "Bearer $apiKey"); connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
    active[requestId] = connection; ensureActive(requestId)

    fun writeText(output: java.io.OutputStream, text: String) = output.write(text.toByteArray(Charsets.UTF_8))
    fun field(output: java.io.OutputStream, name: String, fieldValue: String) { writeText(output, "--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$fieldValue\r\n") }

    try {
      connection.outputStream.use { output ->
        field(output, "model", model); value.optString("language").takeIf { it.isNotBlank() }?.let { field(output, "language", it) }
        if (model == "gpt-4o-transcribe-diarize") { field(output, "response_format", "diarized_json"); field(output, "chunking_strategy", "auto") }
        else { field(output, "response_format", "verbose_json"); field(output, "timestamp_granularities[]", "segment"); field(output, "timestamp_granularities[]", "word"); value.optString("prompt").takeIf { it.isNotBlank() }?.let { field(output, "prompt", it) } }
        writeText(output, "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${file.name.replace("\"", "")}\"\r\nContent-Type: ${mime(file)}\r\n\r\n")
        file.inputStream().buffered(64 * 1024).use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) { ensureActive(requestId); val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
        }
        ensureActive(requestId); writeText(output, "\r\n--$boundary--\r\n")
      }
      ensureActive(requestId); val status = connection.responseCode; val body = readLimited(if (status >= 400) connection.errorStream else connection.inputStream, requestId)
      if (status !in 200..299) error("PROVIDER_ERROR: OpenAI transcription failed ($status): ${body.take(1000)}")
      return body
    } finally { active.remove(requestId); connection.disconnect() }
  }

  override fun transcribeOpenAI(requestJson: String, promise: Promise) {
    val value = try { JSONObject(requestJson) } catch (error: Throwable) { promise.reject("INVALID_INPUT", error.message, error); return }
    val requestId = try { value.getString("requestId") } catch (error: Throwable) { promise.reject("INVALID_INPUT", "requestId required", error); return }
    starting.add(requestId)
    Thread {
      try { ensureActive(requestId); promise.resolve(transcribe(value)) }
      catch (error: Throwable) { promise.reject("SPEECH_PROVIDER", error.message, error) }
      finally { starting.remove(requestId); cancelled.remove(requestId); active.remove(requestId)?.disconnect() }
    }.start()
  }

  override fun cancelTranscription(requestId: String, promise: Promise) {
    if (starting.contains(requestId) || active.containsKey(requestId)) cancelled.add(requestId)
    active.remove(requestId)?.disconnect(); promise.resolve(null)
  }
}
