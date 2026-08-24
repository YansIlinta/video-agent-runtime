package com.videoagent.mobile

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class VideoAgentWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    // DurableJobQueue owns state and deterministic recovery. WorkManager only wakes the host.
    return Result.success()
  }
}
