import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  /** Streams a project:// media asset to the official OpenAI transcription endpoint. */
  transcribeOpenAI(requestJson: string): Promise<string>;
  /** Writes generated WAV directly to a project:// output URI and returns only small JSON metadata. */
  synthesizeOpenAI(requestJson: string): Promise<string>;
  cancelTranscription(requestId: string): Promise<void>;
  cancelSynthesis(requestId: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSpeechHost');
