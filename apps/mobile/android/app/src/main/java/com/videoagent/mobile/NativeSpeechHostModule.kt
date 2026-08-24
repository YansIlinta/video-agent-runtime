package com.videoagent.mobile

import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@ReactModule(name = NativeSpeechHostModule.NAME)
class NativeSpeechHostModule(private val context: ReactApplicationContext) : NativeSpeechHostSpec(context) {
  companion object {
    const val NAME = "NativeSpeechHost"
    private const val OPENAI_TRANSCRIPTIONS = "https://api.openai.com/v1/audio/transcriptions"
    private const val OPENAI_SPEECH = "https://api.openai.com/v1/audio/speech"
    private const val RESPONSE_LIMIT = 16 * 1024 * 1024
    private const val MAX_TTS_TEXT_CHARS = 4096
  }

  private val active = ConcurrentHashMap<String, HttpURLConnection>()
  private val starting = ConcurrentHashMap.newKeySet<String>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  override fun getName() = NAME

  private fun projectFile(uri: String, mustExist: Boolean): File {
    require(uri.startsWith("project://")) { "INVALID_INPUT: speech I/O accepts project:// paths only" }
    val relative = Uri.decode(uri.removePrefix("project://"))
    require(relative.isNotBlank() && relative.split('/').none { it == ".." }) { "PERMISSION_DENIED: invalid project path" }
    val base = File(context.filesDir, "Projects").canonicalFile
    val target = File(base, relative).canonicalFile
    require(target.path == base.path || target.path.startsWith(base.path + File.separator)) { "PERMISSION_DENIED: URI escaped project sandbox" }
    if (mustExist) require(target.isFile) { "NOT_FOUND: media asset does not exist" }
    return target
  }

  private fun resolveProject(uri: String) = projectFile(uri, true)
  private fun resolveProjectOutput(uri: String) = projectFile(uri, false)

  private fun mime(file: File) = when (file.extension.lowercase()) {
    "flac" -> "audio/flac"; "mp3", "mpeg", "mpga" -> "audio/mpeg"; "mp4" -> "video/mp4"; "m4a" -> "audio/mp4"; "ogg" -> "audio/ogg"; "wav" -> "audio/wav"; "webm" -> "audio/webm"; else -> "application/octet-stream"
  }

  private fun ensureActive(requestId: String) { if (cancelled.contains(requestId)) error("CANCELLED: speech request cancelled") }

  private fun readLimited(input: InputStream?, requestId: String): String {
    if (input == null) return ""
    input.use { stream ->
      val output = ByteArrayOutputStream(); val buffer = ByteArray(32 * 1024); var total = 0
      while (true) {
        ensureActive(requestId); val count = stream.read(buffer); if (count < 0) break; total += count
        if (total > RESPONSE_LIMIT) error("PROVIDER_ERROR: speech response exceeded $RESPONSE_LIMIT bytes")
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

  private fun readLe16(file: RandomAccessFile): Int {
    val a = file.read(); val b = file.read(); if (a < 0 || b < 0) error("PROVIDER_ERROR: truncated WAV header")
    return a or (b shl 8)
  }

  private fun readLe32(file: RandomAccessFile): Long {
    val a = file.read(); val b = file.read(); val c = file.read(); val d = file.read(); if (a < 0 || b < 0 || c < 0 || d < 0) error("PROVIDER_ERROR: truncated WAV header")
    return (a.toLong() or (b.toLong() shl 8) or (c.toLong() shl 16) or (d.toLong() shl 24)) and 0xffffffffL
  }

  private fun wavMetadata(file: File): Pair<Double, Int> {
    RandomAccessFile(file, "r").use { input ->
      val riff = ByteArray(4); input.readFully(riff); input.skipBytes(4); val wave = ByteArray(4); input.readFully(wave)
      require(String(riff, Charsets.US_ASCII) == "RIFF" && String(wave, Charsets.US_ASCII) == "WAVE") { "PROVIDER_ERROR: OpenAI TTS returned invalid WAV" }
      var channels = 0; var sampleRate = 0; var bits = 0; var dataBytes = 0L
      while (input.filePointer + 8 <= input.length()) {
        val idBytes = ByteArray(4); input.readFully(idBytes); val id = String(idBytes, Charsets.US_ASCII); val size = readLe32(input); val body = input.filePointer
        if (id == "fmt " && size >= 16) {
          readLe16(input); channels = readLe16(input); sampleRate = readLe32(input).toInt(); input.skipBytes(6); bits = readLe16(input)
        } else if (id == "data") { dataBytes = size; break }
        val next = body + size + (size and 1L); if (next > input.length()) break; input.seek(next)
      }
      require(channels > 0 && sampleRate > 0 && bits > 0 && dataBytes > 0) { "PROVIDER_ERROR: OpenAI TTS WAV is missing fmt/data chunks" }
      return (dataBytes.toDouble() / (sampleRate.toDouble() * channels * (bits / 8.0))) to sampleRate
    }
  }

  private fun synthesize(value: JSONObject): String {
    val requestId = value.getString("requestId"); ensureActive(requestId)
    val apiKey = value.getString("apiKey"); require(apiKey.isNotBlank()) { "AUTH_REQUIRED: API key required" }
    val model = value.getString("model").trim(); require(model.isNotBlank()) { "INVALID_INPUT: TTS model required" }
    val text = value.getString("text").trim(); require(text.isNotBlank() && text.length <= MAX_TTS_TEXT_CHARS) { "INVALID_INPUT: TTS text must be 1-$MAX_TTS_TEXT_CHARS characters" }
    val voiceId = value.getString("voiceId").trim(); require(voiceId.isNotBlank()) { "INVALID_INPUT: voiceId required" }
    val speed = if (value.has("speed")) value.getDouble("speed") else 1.0; require(speed in 0.25..4.0) { "INVALID_INPUT: TTS speed must be between 0.25 and 4" }
    val target = resolveProjectOutput(value.getString("outputUri")); require(!target.exists()) { "INVALID_INPUT: TTS output already exists" }; target.parentFile?.mkdirs()
    val temp = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
    val body = JSONObject().put("model", model).put("input", text).put("voice", voiceId).put("response_format", "wav").put("speed", speed).toString().toByteArray(Charsets.UTF_8)
    val connection = URL(OPENAI_SPEECH).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"; connection.connectTimeout = value.optInt("timeoutMs", 120_000); connection.readTimeout = connection.connectTimeout; connection.doOutput = true
    connection.setFixedLengthStreamingMode(body.size); connection.setRequestProperty("Authorization", "Bearer $apiKey"); connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", "audio/wav")
    active[requestId] = connection; ensureActive(requestId)
    try {
      connection.outputStream.use { it.write(body) }; ensureActive(requestId)
      val status = connection.responseCode
      if (status !in 200..299) { val error = readLimited(connection.errorStream, requestId); error("PROVIDER_ERROR: OpenAI TTS failed ($status): ${error.take(1000)}") }
      (connection.inputStream ?: error("NETWORK_UNAVAILABLE: missing TTS response")).use { input ->
        temp.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) { ensureActive(requestId); val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
        }
      }
      ensureActive(requestId); val (durationSeconds, sampleRate) = wavMetadata(temp)
      if (!temp.renameTo(target)) { temp.inputStream().use { source -> target.outputStream().use(source::copyTo) }; if (!temp.delete()) temp.deleteOnExit() }
      return JSONObject().put("durationSeconds", durationSeconds).put("sampleRate", sampleRate).put("model", model).put("voiceId", voiceId).toString()
    } catch (error: Throwable) { temp.delete(); target.delete(); throw error }
    finally { active.remove(requestId); connection.disconnect() }
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

  override fun synthesizeOpenAI(requestJson: String, promise: Promise) {
    val value = try { JSONObject(requestJson) } catch (error: Throwable) { promise.reject("INVALID_INPUT", error.message, error); return }
    val requestId = try { value.getString("requestId") } catch (error: Throwable) { promise.reject("INVALID_INPUT", "requestId required", error); return }
    starting.add(requestId)
    Thread {
      try { ensureActive(requestId); promise.resolve(synthesize(value)) }
      catch (error: Throwable) { promise.reject("SPEECH_PROVIDER", error.message, error) }
      finally { starting.remove(requestId); cancelled.remove(requestId); active.remove(requestId)?.disconnect() }
    }.start()
  }

  override fun cancelTranscription(requestId: String, promise: Promise) { cancel(requestId); promise.resolve(null) }
  override fun cancelSynthesis(requestId: String, promise: Promise) { cancel(requestId); promise.resolve(null) }
  private fun cancel(requestId: String) { if (starting.contains(requestId) || active.containsKey(requestId)) cancelled.add(requestId); active.remove(requestId)?.disconnect() }
}
