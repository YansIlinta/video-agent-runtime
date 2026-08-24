package com.videoagent.mobile

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeVideoHostPackage : BaseReactPackage() {
  override fun getModule(name: String, context: ReactApplicationContext): NativeModule? = if (name == NativeVideoHostModule.NAME) NativeVideoHostModule(context) else null
  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider { mapOf(NativeVideoHostModule.NAME to ReactModuleInfo(NativeVideoHostModule.NAME, NativeVideoHostModule.NAME, false, false, false, true)) }
}
