import NativeSpeechHost from '../specs/NativeSpeechHost';
import type {NativeOpenAITTSResult, NativeSpeechHostBridge} from '../../../packages/mobile/src/native-speech-bridge';

export const nativeSpeechBridge: NativeSpeechHostBridge = {
  transcribeOpenAI: request => NativeSpeechHost.transcribeOpenAI(JSON.stringify(request)),
  synthesizeOpenAI: async request => JSON.parse(await NativeSpeechHost.synthesizeOpenAI(JSON.stringify(request))) as NativeOpenAITTSResult,
  cancelTranscription: requestId => NativeSpeechHost.cancelTranscription(requestId),
  cancelSynthesis: requestId => NativeSpeechHost.cancelSynthesis(requestId),
};
