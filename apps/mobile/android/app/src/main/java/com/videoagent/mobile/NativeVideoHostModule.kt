package com.videoagent.mobile

import android.app.Activity
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.Settings
import android.util.Base64
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.module.annotations.ReactModule
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@ReactModule(name = NativeVideoHostModule.NAME)
class NativeVideoHostModule(private val context: ReactApplicationContext) : NativeVideoHostSpec(context), ActivityEventListener {
  companion object { const val NAME = "NativeVideoHost"; const val PICK_VIDEO = 9031; const val KEY_ALIAS = "video-agent-byok"; const val WORK_TAG = "video-agent" }
  private var pickerPromise: Promise? = null
  private val securePrefs = context.getSharedPreferences("video-agent-secure", 0)
  init { context.addActivityEventListener(this) }
  override fun getName() = NAME

  private fun resolve(uri: String): File {
    val marker = uri.indexOf("://"); require(marker > 0) { "INVALID_INPUT: malformed logical URI" }; val scheme = uri.substring(0, marker); val relative = Uri.decode(uri.substring(marker + 3)); require(relative.split('/').none { it == ".." }) { "PERMISSION_DENIED: path traversal" }
    val base = when (scheme) { "project" -> File(context.filesDir, "Projects"); "cache" -> File(context.cacheDir, "Cache"); "import" -> File(context.cacheDir, "Import"); "export" -> File(context.filesDir, "Exports"); else -> throw IllegalArgumentException("INVALID_INPUT: unsupported URI scheme") }
    val target = File(base, relative).canonicalFile; require(target.path.startsWith(base.canonicalPath)) { "PERMISSION_DENIED: URI escaped sandbox" }; return target
  }
  private fun logical(file: File): String { val roots = listOf(File(context.filesDir, "Projects") to "project", File(context.cacheDir, "Cache") to "cache", File(context.filesDir, "Exports") to "export"); roots.forEach { (base, scheme) -> if (file.canonicalPath.startsWith(base.canonicalPath)) return "$scheme://${file.canonicalPath.removePrefix(base.canonicalPath).trimStart('/')}" }; return Uri.fromFile(file).toString() }
  private fun bytes(array: ReadableArray) = ByteArray(array.size()) { array.getInt(it).toByte() }
  private fun writable(data: ByteArray): WritableArray = Arguments.createArray().also { out -> data.forEach { out.pushInt(it.toInt() and 255) } }
  private inline fun promise(promise: Promise, action: () -> Any?) { try { promise.resolve(action()) } catch (error: Throwable) { promise.reject("NATIVE_HOST", error.message, error) } }

  override fun platform(promise: Promise) = promise.resolve("android")
  override fun read(uri: String, promise: Promise) = promise(promise) { writable(resolve(uri).readBytes()) }
  override fun write(uri: String, input: ReadableArray, atomic: Boolean, createOnly: Boolean, promise: Promise) = promise(promise) { val target = resolve(uri); target.parentFile?.mkdirs(); if (createOnly && target.exists()) error("INVALID_INPUT: destination exists"); val data = bytes(input); if (atomic) { val temp = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp"); temp.writeBytes(data); if (target.exists() && !target.delete()) error("STORAGE_ERROR: replace failed"); if (!temp.renameTo(target)) error("STORAGE_ERROR: atomic rename failed") } else target.writeBytes(data); null }
  override fun remove(uri: String, recursive: Boolean, promise: Promise) = promise(promise) { val file = resolve(uri); if (recursive) file.deleteRecursively() else file.delete(); null }
  override fun exists(uri: String, promise: Promise) = promise.resolve(runCatching { resolve(uri).exists() }.getOrDefault(false))
  override fun statJson(uri: String, promise: Promise) = promise(promise) { val file = if (uri.startsWith("content://")) null else resolve(uri); if (file != null) JSONObject().put("sizeBytes", file.length()).put("kind", if (file.isDirectory) "directory" else "file").put("modifiedAt", java.time.Instant.ofEpochMilli(file.lastModified()).toString()).toString() else { val afd = context.contentResolver.openAssetFileDescriptor(Uri.parse(uri), "r"); JSONObject().put("sizeBytes", afd?.length ?: 0).put("kind", "file").toString().also { afd?.close() } } }
  override fun listJson(uri: String, promise: Promise) = promise(promise) { val root = resolve(uri); JSONArray(if (!root.exists()) emptyList<String>() else root.walkTopDown().filter { it.isFile }.map(::logical).toList()).toString() }
  override fun copy(source: String, destination: String, promise: Promise) = promise(promise) { val target = resolve(destination); target.parentFile?.mkdirs(); if (source.startsWith("content://")) context.contentResolver.openInputStream(Uri.parse(source)).use { input -> requireNotNull(input).copyTo(target.outputStream()) } else (if (source.contains("://")) resolve(source) else File(source)).inputStream().use { input -> target.outputStream().use(input::copyTo) }; null }
  override fun diskFreeBytes(promise: Promise) = promise.resolve(StatFs(context.filesDir.path).availableBytes.toDouble())

  override fun pickVideoJson(promise: Promise) { val activity = currentActivity ?: return promise.reject("NO_ACTIVITY", "No foreground activity"); if (pickerPromise != null) return promise.reject("BUSY", "Picker already active"); pickerPromise = promise; activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "video/*"; addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) }, PICK_VIDEO) }
  override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) { if (requestCode != PICK_VIDEO) return; val promise = pickerPromise ?: return; pickerPromise = null; if (resultCode != Activity.RESULT_OK || data?.data == null) { promise.resolve(""); return }; val uri = data.data!!; runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }; val size = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0; promise.resolve(JSONObject().put("sourceUri", uri.toString()).put("displayName", uri.lastPathSegment ?: "import.mp4").put("mediaType", "video/*").put("sizeBytes", size).toString()) }
  override fun onNewIntent(intent: Intent?) = Unit

  override fun probeJson(uri: String, promise: Promise) = promise(promise) { val retriever = MediaMetadataRetriever(); try { if (uri.startsWith("content://")) retriever.setDataSource(context, Uri.parse(uri)) else retriever.setDataSource(resolve(uri).path); val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0; val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull(); val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull(); val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0; val fps = if (Build.VERSION.SDK_INT >= 23) retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toFloatOrNull() else null; JSONObject().put("durationUs", durationMs * 1000).put("sizeBytes", resolve(uri).length()).apply { if (width != null) put("width", width); if (height != null) put("height", height); if (fps != null) put("frameRate", JSONObject().put("numerator", (fps * 1000).toInt()).put("denominator", 1000)); put("rotation", rotation); put("videoCodec", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)); put("container", resolve(uri).extension); put("audioCodec", if (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes") "present" else JSONObject.NULL) }.toString() } finally { retriever.release() } }
  override fun rendererCapabilitiesJson(promise: Promise) = promise.resolve(JSONObject().put("trim", true).put("concat", true).put("crop", true).put("scale", true).put("preserveAudio", true).put("speed", false).put("captionBurnIn", false).put("audioDucking", false).put("overlay", false).put("backgroundExport", true).toString())
  override fun renderJson(specJson: String, promise: Promise) { NativeMediaRenderer(context).render(specJson, { progress, phase -> emitOnProgress(Arguments.createMap().apply { putString("jobId", JSONObject(specJson).getString("jobId")); putDouble("progress", progress); putString("phase", phase) }) }, promise) }
  override fun cancelRender(jobId: String, promise: Promise) { NativeMediaRenderer.cancel(jobId); promise.resolve(null) }

  private fun secretKey(): SecretKey { val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }; (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }; val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore"); generator.init(android.security.keystore.KeyGenParameterSpec.Builder(KEY_ALIAS, android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).setUserAuthenticationRequired(false).build()); return generator.generateKey() }
  override fun secureSet(key: String, value: String, promise: Promise) = promise(promise) { val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secretKey()); securePrefs.edit().putString(key, Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)).commit(); null }
  override fun secureGet(key: String, promise: Promise) = promise(promise) { val encoded = securePrefs.getString(key, null) ?: return@promise null; val data = Base64.decode(encoded, Base64.NO_WRAP); val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, data.copyOfRange(0, 12))); String(cipher.doFinal(data.copyOfRange(12, data.size))) }
  override fun secureDelete(key: String, promise: Promise) = promise(promise) { securePrefs.edit().remove(key).commit(); null }

  override fun httpJson(requestJson: String, promise: Promise) { Thread { try { val value = JSONObject(requestJson); val connection = URL(value.getString("url")).openConnection() as HttpURLConnection; connection.requestMethod = value.optString("method", "GET"); connection.connectTimeout = value.optInt("timeoutMs", 120000); connection.readTimeout = connection.connectTimeout; value.optJSONObject("headers")?.keys()?.forEach { connection.setRequestProperty(it, value.getJSONObject("headers").getString(it)) }; value.optString("bodyBase64").takeIf { it.isNotEmpty() }?.let { connection.doOutput = true; connection.outputStream.use { output -> output.write(Base64.decode(it, Base64.NO_WRAP)) } }; val status = connection.responseCode; val data = (if (status >= 400) connection.errorStream else connection.inputStream)?.readBytes() ?: ByteArray(0); val headers = JSONObject(); connection.headerFields.filterKeys { it != null }.forEach { (key, values) -> headers.put(key.lowercase(), values.joinToString(",")) }; promise.resolve(JSONObject().put("status", status).put("headers", headers).put("bodyBase64", Base64.encodeToString(data, Base64.NO_WRAP)).toString()) } catch (error: Throwable) { promise.reject("NETWORK_UNAVAILABLE", error.message, error) } }.start() }

  override fun scheduleBackgroundJson(taskJson: String, promise: Promise) = promise(promise) { val task = JSONObject(taskJson); val request = OneTimeWorkRequestBuilder<VideoAgentWorker>().setInputData(Data.Builder().putString("jobId", task.getString("id")).putString("kind", task.optString("kind")).build()).addTag(WORK_TAG).addTag(task.getString("id")).build(); WorkManager.getInstance(context).enqueue(request); null }
  override fun cancelBackground(id: String, promise: Promise) { WorkManager.getInstance(context).cancelAllWorkByTag(id); promise.resolve(null) }
  override fun pendingBackgroundJson(promise: Promise) = promise(promise) { val workerTag = VideoAgentWorker::class.java.name; val values = WorkManager.getInstance(context).getWorkInfosByTag(WORK_TAG).get().filter { !it.state.isFinished }.map { info -> JSONObject().put("id", info.tags.firstOrNull { tag -> tag != WORK_TAG && tag != workerTag } ?: info.id.toString()).put("kind", "durable-mobile-job") }; JSONArray(values).toString() }
  override fun backgroundBudgetMs(promise: Promise) = promise.resolve(-1.0)
  override fun permissionStatus(kind: String, promise: Promise) = promise.resolve(if (kind == "files" || kind == "photos") "granted" else "unknown")
  override fun requestPermission(kind: String, promise: Promise) = promise.resolve(if (kind == "files" || kind == "photos") "granted" else "denied")
  override fun resourceBudgetJson(promise: Promise) = promise.resolve(JSONObject().put("maxWorkingSetBytes", Runtime.getRuntime().maxMemory()).put("maxConcurrentMediaJobs", 1).put("previewMaxWidth", 1280).put("previewMaxDurationUs", 120000000).put("thermalState", "unknown").put("powerState", "unknown").toString())
  override fun sha256Json(dataJson: String, promise: Promise) = promise(promise) { val decoded = JSONTokener(dataJson).nextValue(); val input = when (decoded) { is String -> decoded.toByteArray(); is JSONArray -> ByteArray(decoded.length()) { decoded.getInt(it).toByte() }; else -> dataJson.toByteArray() }; MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) } }
  override fun sha256File(uri: String, promise: Promise) = promise(promise) { val digest = MessageDigest.getInstance("SHA-256"); resolve(uri).inputStream().use { input -> val buffer = ByteArray(1024 * 1024); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }; digest.digest().joinToString("") { "%02x".format(it) } }
  override fun randomBytes(length: Double): WritableArray = writable(ByteArray(length.toInt()).also { SecureRandom().nextBytes(it) })
  override fun createId(): String = UUID.randomUUID().toString().lowercase()
}
