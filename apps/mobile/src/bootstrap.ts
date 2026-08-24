import {createMobileHost} from '../../../packages/mobile/src/composition';
import {nativeBridge} from './nativeBridge';
export const mobileHost = createMobileHost(nativeBridge);
