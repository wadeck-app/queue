import WebSocket from 'ws';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { loadRelayConfig, type RelayConfig, type PluginConfig } from './config.js';
import { loadPlugin, type RelayPlugin, type RelayEnvelope } from './plugin-api.js';
import { ensureDaemonRunning, pushToQueue } from './push.js';

interface LoadedPlugin {
  plugin: RelayPlugin;
  config: PluginConfig;
}

export interface RelayConnectionOptions {
  configDir: string;
  onLog?: (line: string) => void;
}

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const NO_CONFIG_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the WebSocket connection to the relay (auth, subscribe, reconnect with
 * backoff) and routes incoming envelopes to the loaded plugins. Contains no
 * Source-specific logic -- see plugin-api.ts.
 */
export class RelayConnection {
  private readonly configDir: string;
  private readonly log: (line: string) => void;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private loadedPlugins: LoadedPlugin[] = [];

  constructor(options: RelayConnectionOptions) {
    this.configDir = options.configDir;
    this.log = options.onLog ?? (() => {});
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      const config = loadRelayConfig(this.configDir);
      if (!config || config.plugins.length === 0) {
        this.log(
          config
            ? '[relay] relay.yml has no plugins configured.'
            : '[relay] No relay.yml found in QUEUE_CONFIG_DIR.'
        );
        await sleep(NO_CONFIG_RETRY_DELAY_MS);
        continue;
      }

      try {
        this.loadedPlugins = await Promise.all(
          config.plugins.map(async (pluginConfig) => ({
            plugin: await loadPlugin(pluginConfig.module),
            config: pluginConfig,
          }))
        );
      } catch (err) {
        this.log(`[relay] Failed to load plugins: ${getErrorMessage(err)}`);
        await sleep(NO_CONFIG_RETRY_DELAY_MS);
        continue;
      }

      try {
        await this.connectOnce(config);
      } catch (err) {
        this.log(`[relay] Connection error: ${getErrorMessage(err)}`);
      }

      this.connected = false;
      if (this.stopped) break;
      await sleep(this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  /** Resolves once the connection closes (cleanly or not); rejects only on a connect-time error. */
  private connectOnce(config: RelayConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.relayUrl);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: config.token }));
      });

      ws.on('message', (raw) => {
        void this.handleMessage(String(raw)).catch((err) => {
          this.log(`[relay] Error handling message: ${getErrorMessage(err)}`);
        });
      });

      ws.on('close', () => {
        this.connected = false;
        this.log('[relay] Connection closed.');
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    switch (msg.type) {
      case 'authenticated':
        this.connected = true;
        this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
        this.log(`[relay] Authenticated as ${String(msg.username)}.`);
        this.subscribeAll();
        break;
      case 'error':
        this.log(`[relay] Relay reported an error: ${String(msg.error)}`);
        break;
      case 'subscribed':
        this.log(`[relay] Subscribed: ${JSON.stringify(msg.filter)}`);
        break;
      case 'event':
        await this.dispatchEvent(msg.envelope as RelayEnvelope);
        break;
      default:
        this.log(`[relay] Unknown message type from relay: ${String(msg.type)}`);
    }
  }

  private subscribeAll(): void {
    if (!this.ws) return;
    for (const { plugin, config } of this.loadedPlugins) {
      for (const subscription of config.subscriptions) {
        this.ws.send(JSON.stringify({
          type: 'subscribe',
          filter: {
            source: plugin.source,
            eventType: subscription.eventType ?? [],
            payloadMatch: subscription.payloadMatch ?? {},
          },
        }));
      }
    }
  }

  private async dispatchEvent(envelope: RelayEnvelope): Promise<void> {
    const loaded = this.loadedPlugins.find((entry) => entry.plugin.source === envelope.source);
    if (!loaded) {
      this.log(`[relay] No plugin loaded for source "${envelope.source}" -- dropping delivery ${envelope.deliveryId}.`);
      return;
    }

    const mapped = loaded.plugin.mapEvent(envelope);
    if (!mapped) {
      this.log(`[relay] Plugin "${loaded.plugin.source}" dropped delivery ${envelope.deliveryId}.`);
      return;
    }

    const matchingSubscription = loaded.config.subscriptions.find(
      (subscription) => !subscription.eventType?.length || subscription.eventType.includes(envelope.eventType)
    );
    const event = matchingSubscription?.queueEvent ?? mapped.event;

    try {
      await ensureDaemonRunning(this.configDir);
      const result = await pushToQueue(this.configDir, event, mapped.payload);
      this.log(`[relay] Pushed "${event}" (delivery ${envelope.deliveryId}) -> ${result.status}.`);
    } catch (err) {
      this.log(`[relay] Failed to push "${event}" (delivery ${envelope.deliveryId}): ${getErrorMessage(err)}`);
    }
  }
}
