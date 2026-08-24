#import "RCTNativeSpeechHost.h"
#import "VideoAgentMobile-Swift.h"

@implementation RCTNativeSpeechHost {
  NativeSpeechHostService *_service;
}

- (instancetype)init { if ((self = [super init])) { _service = [NativeSpeechHostService new]; } return self; }
+ (NSString *)moduleName { return @"NativeSpeechHost"; }
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params { return std::make_shared<facebook::react::NativeSpeechHostSpecJSI>(params); }

- (void)transcribeOpenAI:(NSString *)requestJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_service transcribeOpenAI:requestJson completion:^(NSString *value, NSError *error) {
    error ? reject(@"SPEECH_PROVIDER", error.localizedDescription, error) : resolve(value);
  }];
}

- (void)synthesizeOpenAI:(NSString *)requestJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_service synthesizeOpenAI:requestJson completion:^(NSString *value, NSError *error) {
    error ? reject(@"SPEECH_PROVIDER", error.localizedDescription, error) : resolve(value);
  }];
}

- (void)cancelTranscription:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_service cancelTranscription:requestId];
  resolve(nil);
}

- (void)cancelSynthesis:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_service cancelSynthesis:requestId];
  resolve(nil);
}
@end
