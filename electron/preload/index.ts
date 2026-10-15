/**
 * Preload (sandbox 有効 / contextIsolation 有効)。
 * 許可されたチャネルだけを `window.gumi` として公開する。Node.js API は一切公開しない。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type EventMap,
  type GumiApi,
  type InvokeEnvelope,
  type InvokeMap,
  type SendMap,
} from '../../src/types/ipc';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const sendSet = new Set<string>(SEND_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

const api: GumiApi = {
  async invoke<K extends keyof InvokeMap>(channel: K, ...args: InvokeMap[K]['args']) {
    if (!invokeSet.has(channel)) throw new Error(`許可されていないチャネル: ${channel}`);
    const res = (await ipcRenderer.invoke(channel, ...args)) as InvokeEnvelope<InvokeMap[K]['result']>;
    if (!res || typeof res !== 'object') throw new Error('不正な応答');
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  send<K extends keyof SendMap>(channel: K, payload: SendMap[K]) {
    if (!sendSet.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void) {
    if (!eventSet.has(channel)) throw new Error(`許可されていないイベント: ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: EventMap[K]) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('gumi', Object.freeze(api));
