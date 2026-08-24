import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export type ProgressEvent = {jobId: string; progress: number; phase: string; message?: string};
export interface Spec extends TurboModule {
  platform(): Promise<string>;
  read(uri: string): Promise<ReadonlyArray<number>>;
  write(uri: string, bytes: ReadonlyArray<number>, atomic: boolean, createOnly: boolean): Promise<void>;
  remove(uri: string, recursive: boolean): Promise<void>;
  exists(uri: string): Promise<boolean>;
  statJson(uri: string): Promise<string>;
  listJson(uri: string): Promise<string>;
  copy(source: string, destination: string): Promise<void>;
  diskFreeBytes(): Promise<number>;
  pickVideoJson(): Promise<string>;
  probeJson(uri: string): Promise<string>;
  renderJson(specJson: string): Promise<string>;
  cancelRender(jobId: string): Promise<void>;
  rendererCapabilitiesJson(): Promise<string>;
  secureSet(key: string, value: string): Promise<void>;
  secureGet(key: string): Promise<string | null>;
  secureDelete(key: string): Promise<void>;
  httpJson(requestJson: string): Promise<string>;
  scheduleBackgroundJson(taskJson: string): Promise<void>;
  cancelBackground(id: string): Promise<void>;
  pendingBackgroundJson(): Promise<string>;
  backgroundBudgetMs(): Promise<number>;
  permissionStatus(kind: string): Promise<string>;
  requestPermission(kind: string): Promise<string>;
  resourceBudgetJson(): Promise<string>;
  sha256Json(dataJson: string): Promise<string>;
  sha256File(uri: string): Promise<string>;
  randomBytes(length: number): ReadonlyArray<number>;
  createId(): string;
  readonly onProgress: CodegenTypes.EventEmitter<ProgressEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeVideoHost');
