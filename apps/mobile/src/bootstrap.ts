import {createMobileHost} from '../../../packages/mobile/src/composition';
import {nativeBridge} from './nativeBridge';
import {nativeSpeechBridge} from './nativeSpeechBridge';

export const mobileHost = createMobileHost(nativeBridge, nativeSpeechBridge);
