package com.videoagent.mobile

import android.content.Context
import android.net.Uri
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import com.facebook.react.bridge.Promise
import com.google.common.collect.ImmutableList
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

class NativeMediaRenderer(private val context: Context) {
  companion object { private val active = ConcurrentHashMap<String, Transformer>(); fun cancel(jobId: String) { active.remove(jobId)?.cancel() } }
  private fun resolve(uri: String): File { val marker = uri.indexOf("://"); require(marker > 0); val scheme = uri.substring(0, marker); val relative = Uri.decode(uri.substring(marker + 3)); val base = when (scheme) { "project" -> File(context.filesDir, "Projects"); "cache" -> File(context.cacheDir, "Cache"); "export" -> File(context.filesDir, "Exports"); else -> error("INVALID_INPUT: unsupported media URI") }; val result = File(base, relative).canonicalFile; require(result.path.startsWith(base.canonicalPath)); return result }
  fun render(specJson: String, progress: (Double, String) -> Unit, promise: Promise) {
    try {
      val spec = JSONObject(specJson); val timeline = JSONObject(spec.getString("timelineJson")); val assetsArray = JSONArray(spec.getString("assetsJson")); val assets = mutableMapOf<String, String>(); for (index in 0 until assetsArray.length()) { val item = assetsArray.getJSONObject(index); assets[item.getString("assetId")] = item.getString("uri") }
      val clips = mutableListOf<JSONObject>(); val tracks = timeline.getJSONArray("tracks"); for (trackIndex in 0 until tracks.length()) { val track = tracks.getJSONObject(trackIndex); if (track.optString("type") != "video") continue; val values = track.getJSONArray("clips"); for (clipIndex in 0 until values.length()) clips += values.getJSONObject(clipIndex) }; clips.sortBy { it.getLong("timelineInUs") }
      require(clips.isNotEmpty()) { "INVALID_INPUT: timeline has no video clips" }
      val effects = Effects(ImmutableList.of(), ImmutableList.of<Effect>(Presentation.createForWidthAndHeight(1280, 720, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP)))
      val edited = clips.map { clip -> val source = requireNotNull(assets[clip.getString("assetId")]); val file = resolve(source); val media = MediaItem.Builder().setUri(Uri.fromFile(file)).setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs(clip.getLong("sourceInUs") / 1000).setEndPositionMs(clip.getLong("sourceOutUs") / 1000).build()).build(); EditedMediaItem.Builder(media).setRemoveAudio(false).setRemoveVideo(false).setEffects(effects).build() }
      val sequence = EditedMediaItemSequence.Builder(edited).setIsLooping(false).build(); val composition = Composition.Builder(listOf(sequence)).build(); val output = resolve(spec.getString("outputUri")); output.parentFile?.mkdirs(); output.delete(); val jobId = spec.getString("jobId")
      val listener = object : Transformer.Listener {
        override fun onCompleted(composition: Composition, result: ExportResult) { active.remove(jobId); progress(1.0, "native-complete"); promise.resolve(JSONObject().put("outputUri", spec.getString("outputUri")).put("durationUs", timeline.optLong("durationUs")).put("warnings", JSONArray(listOf("Caption burn-in, speed, ducking and overlays are not implemented"))).toString()) }
        override fun onError(composition: Composition, result: ExportResult, exception: ExportException) { active.remove(jobId); promise.reject("MEDIA_CODEC_UNSUPPORTED", exception.message, exception) }
      }
      val transformer = Transformer.Builder(context).addListener(listener).build(); active[jobId] = transformer; progress(0.02, "native-starting"); transformer.start(composition, output.path)
    } catch (error: Throwable) { promise.reject("NATIVE_RENDER", error.message, error) }
  }
}
