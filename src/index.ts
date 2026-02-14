import type { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MelkBlePlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MelkBlePlatform);
};
