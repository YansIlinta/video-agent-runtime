import NativeSpeechHost from '../specs/NativeSpeechHost';
import type {NativeSpeechHostBridge} from '../../../packages/mobile/src/native-speech-bridge';

export const nativeSpeechBridge: NativeSpeechHostBridge = {
  transcribeOpenAI: request => NativeSpeechHost.transcribeOpenAI(JSON.stringify(request)),
  cancelTranscription: requestId => NativeSpeechHost.cancelTranscription(requestId),
};
