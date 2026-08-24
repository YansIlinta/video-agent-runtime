package com.videoagent.mobile

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class VideoAgentWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    // DurableJobQueue owns job state and deterministic recovery; this worker exists only to bring
    // the host back so that recover() can run.
    //
    // NOT IMPLEMENTED: this does not start the JS runtime. A CoroutineWorker cannot, on its own,
    // resume React Native. Waking the host requires a HeadlessJsTaskService, a manifest entry for
    // it, and an AppRegistry.registerHeadlessTask handler that calls DurableJobQueue.recover().
    // Until that exists, scheduled work is recorded and observable through pendingBackground(),
    // but recovery happens on next foreground launch, not on the WorkManager wake-up.
    // See apps/mobile/NATIVE_INTEGRATION.md.
    return Result.success()
  }
}
