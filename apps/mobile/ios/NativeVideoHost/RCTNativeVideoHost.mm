#import "RCTNativeVideoHost.h"
#import "VideoAgentMobile-Swift.h"

@implementation RCTNativeVideoHost {
  NativeVideoHostService *_service;
}

- (instancetype)init { if ((self = [super init])) { _service = [NativeVideoHostService new]; } return self; }
+ (NSString *)moduleName { return @"NativeVideoHost"; }
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params { return std::make_shared<facebook::react::NativeVideoHostSpecJSI>(params); }

- (void)platform:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(@"ios"); }
- (void)read:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSArray *value = [_service read:uri error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (void)write:(NSString *)uri bytes:(NSArray<NSNumber *> *)bytes atomic:(BOOL)atomic createOnly:(BOOL)createOnly resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service write:uri bytes:bytes atomic:atomic createOnly:createOnly error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(nil); }
- (void)remove:(NSString *)uri recursive:(BOOL)recursive resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service remove:uri error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(nil); }
- (void)exists:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(@([_service exists:uri])); }
- (void)statJson:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service statJSON:uri error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (void)listJson:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service listJSON:uri error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (void)copy:(NSString *)source destination:(NSString *)destination resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service copy:source destination:destination error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(nil); }
- (void)diskFreeBytes:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSNumber *value = [_service diskFreeBytesAndReturnError:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (void)pickVideoJson:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service pickVideoCallback:^(NSString *value, NSError *error) { error ? reject(@"PERMISSION_DENIED", error.localizedDescription, error) : resolve(value); }]; }
- (void)probeJson:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service probeJSONCallback:uri completion:^(NSString *value, NSError *error) { error ? reject(@"MEDIA_CODEC_UNSUPPORTED", error.localizedDescription, error) : resolve(value); }]; }
- (void)renderJson:(NSString *)specJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service renderJSONCallback:specJson completion:^(NSString *value, NSError *error) { error ? reject(@"MEDIA_CODEC_UNSUPPORTED", error.localizedDescription, error) : resolve(value); }]; }
- (void)cancelRender:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service cancelRender:jobId]; resolve(nil); }
- (void)rendererCapabilitiesJson:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service rendererCapabilitiesJSONAndReturnError:&error]; error ? reject(@"INTERNAL", error.localizedDescription, error) : resolve(value); }
- (void)secureSet:(NSString *)key value:(NSString *)value resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service secureSet:key value:value error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(nil); }
- (void)secureGet:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service secureGet:key error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (void)secureDelete:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service secureDelete:key error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(nil); }
- (void)httpJson:(NSString *)requestJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service httpJSONCallback:requestJson completion:^(NSString *value, NSError *error) { error ? reject(@"NETWORK_UNAVAILABLE", error.localizedDescription, error) : resolve(value); }]; }
- (void)scheduleBackgroundJson:(NSString *)taskJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; [_service scheduleBackgroundJSON:taskJson error:&error]; error ? reject(@"BACKGROUND_INTERRUPTED", error.localizedDescription, error) : resolve(nil); }
- (void)cancelBackground:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service cancelBackground:jobId]; resolve(nil); }
- (void)pendingBackgroundJson:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service pendingBackgroundJSONAndReturnError:&error]; error ? reject(@"INTERNAL", error.localizedDescription, error) : resolve(value); }
- (void)backgroundBudgetMs:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve(@(25000)); }
- (void)permissionStatus:(NSString *)kind resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve([_service permissionStatus:kind]); }
- (void)requestPermission:(NSString *)kind resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { [_service requestPermissionCallback:kind completion:^(NSString *value, NSError *error) { resolve(value); }]; }
- (void)resourceBudgetJson:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service resourceBudgetJSONAndReturnError:&error]; error ? reject(@"INTERNAL", error.localizedDescription, error) : resolve(value); }
- (void)sha256Json:(NSString *)dataJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { resolve([_service sha256JSON:dataJson]); }
- (void)sha256File:(NSString *)uri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject { NSError *error; NSString *value = [_service sha256File:uri error:&error]; error ? reject(@"STORAGE_ERROR", error.localizedDescription, error) : resolve(value); }
- (NSArray<NSNumber *> *)randomBytes:(double)length { NSError *error; NSArray *value = [_service randomBytes:(NSInteger)length error:&error]; return value ?: @[]; }
- (NSString *)createId { return [_service createID]; }
@end
