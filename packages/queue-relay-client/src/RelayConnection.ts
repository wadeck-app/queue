import WebSocket from 'ws';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { loadRelayConfig, type RelayConfig, type PluginConfig } from './config.js';
import { loadPlugin, type RelayPlugin, type RelayEnvelope } from './plugin-api.js';
import { ensureDaemonRunning, pushToQueue } from './push.js';
import { matchesPayload } from './payloadMatch.js';

interface LoadedPlugin {
  plugin: RelayPlugin;
  config: PluginConfig;
}

export interface RelayConnectionOptions {
  configDir: string;
  onLog?: (line: string) => void;
  retryDelayMs?: number;
}

export interface ConnectionDiagnostics {
  lastError: string | null;
  lastErrorAt: string | null;
  lastCloseCode: number | null;
}

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const NO_CONFIG_RETRY_DELAY_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    // Use { once: true } to automatically remove the listener after abort
    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      resolve();
    }, { once: true });
  });
}

/**
 * Owns the WebSocket connection to the relay (auth, subscribe, reconnect with
 * backoff) and routes incoming envelopes to the loaded plugins. Contains no
 * Source-specific logic -- see plugin-api.ts.
 */
export class RelayConnection {
  private readonly configDir: string;
  private readonly log: (line: string) => void;
  private readonly retryDelayMs: number;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private loadedPlugins: LoadedPlugin[] = [];
  private sleepAbortController: AbortController | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private lastCloseCode: number | null = null;

  constructor(options: RelayConnectionOptions) {
    this.configDir = options.configDir;
    this.log = options.onLog ?? (() => {});
    this.retryDelayMs = options.retryDelayMs ?? NO_CONFIG_RETRY_DELAY_MS;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getDiagnostics(): ConnectionDiagnostics {
    return {
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastCloseCode: this.lastCloseCode,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    // Interrupt any in-progress sleep to allow immediate shutdown
    this.sleepAbortController?.abort();
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      // Wrap config load in try/catch to handle load errors gracefully
      let config: RelayConfig | null;
      try {
        config = loadRelayConfig(this.configDir);
      } catch (err) {
        const errorMsg = `Cannot load relay.yml: ${getErrorMessage(err)}`;
        this.log(`[relay] ${errorMsg}`);
        this.connected = false;
        // Record diagnostics for config load failure
        this.lastError = errorMsg;
        this.lastErrorAt = new Date().toISOString();
        this.sleepAbortController = new AbortController();
        await sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying config load
        if (this.stopped) break;
        continue;
      }

      if (!config || config.plugins.length === 0) {
        this.log(
          config
            ? `[relay] relay.yml has no plugins configured in ${this.configDir}.`
            : `[relay] No relay.yml found in ${this.configDir} -- create it, see 'queue relay --help'.`
        );
        this.connected = false;
        this.sleepAbortController = new AbortController();
        await sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying
        if (this.stopped) break;
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
        const errorMsg = `Failed to load plugins: ${getErrorMessage(err)}`;
        this.log(`[relay] ${errorMsg}`);
        this.connected = false;
        // Record diagnostics for plugin load failure
        this.lastError = errorMsg;
        this.lastErrorAt = new Date().toISOString();
        this.sleepAbortController = new AbortController();
        await sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying
        if (this.stopped) break;
        continue;
      }

      // Check stopped flag after plugin load completes before attempting connection
      if (this.stopped) break;

      try {
        await this.connectOnce(config);
      } catch (err) {
        this.log(`[relay] Connection error: ${getErrorMessage(err)}`);
      }

      this.connected = false;
      if (this.stopped) break;
      this.sleepAbortController = new AbortController();
      await sleep(this.reconnectDelay, this.sleepAbortController.signal);
      // Check stopped flag after sleep before retrying
      if (this.stopped) break;
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

      ws.on('close', (code) => {
        this.connected = false;
        // Record the close code for diagnostics
        this.lastCloseCode = code;
        // If close code is 4001 (auth rejected), make the diagnostic message actionable
        if (code === 4001) {
          this.lastError = 'The relay refused the token (close code 4001). Check "token" in relay.yml.';
          this.lastErrorAt = new Date().toISOString();
        }
        this.log('[relay] Connection closed.');
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('error', (err) => {
        const errorMsg = `Connection error: ${getErrorMessage(err)}`;
        // Record diagnostics for connection error
        this.lastError = errorMsg;
        this.lastErrorAt = new Date().toISOString();
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    switch (msg.type) {
      case 'authenticated':
        this.connected = true;
        // Clear error state on successful authentication
        this.lastError = null;
        this.lastErrorAt = null;
        this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
        this.log(`[relay] Authenticated as ${String(msg.username)}.`);
        this.subscribeAll();
        break;
      case 'error':
        this.log(`[relay] Relay reported an error: ${String(msg.error)}`);
        // Record the relay error for diagnostics
        this.lastError = `Relay rejected the connection: ${String(msg.error)}`;
        this.lastErrorAt = new Date().toISOString();
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
    // Send ONE subscribe message per loaded plugin with union of eventTypes and empty payloadMatch.
    // The relay-side filter is deliberately coarse; precise filtering happens on the client
    // via matchesPayload in dispatchEvent, allowing subscriptions to override each other
    // by payloadMatch without sending multiple filters to the relay.
    const sourcesSeen = new Set<string>();

    for (const { plugin, config } of this.loadedPlugins) {
      // Warn if multiple plugins use the same source (relay will overwrite the first subscribe)
      if (sourcesSeen.has(plugin.source)) {
        this.log(
          `[relay] Warning: multiple plugins configured for source "${plugin.source}" -- ` +
          `relay subscription will be overwritten by the latest one`
        );
      }
      sourcesSeen.add(plugin.source);

      // Union all eventType arrays, but if ANY subscription has no eventType, use empty array (= all events)
      const eventTypeSet = new Set<string>();
      let hasEmptyEventType = false;

      for (const subscription of config.subscriptions) {
        if (!subscription.eventType || subscription.eventType.length === 0) {
          hasEmptyEventType = true;
          break;
        }
        subscription.eventType.forEach((type) => eventTypeSet.add(type));
      }

      const eventType = hasEmptyEventType ? [] : Array.from(eventTypeSet);

      this.ws.send(JSON.stringify({
        type: 'subscribe',
        filter: {
          source: plugin.source,
          eventType,
          payloadMatch: {},
        },
      }));
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

    // Find the FIRST subscription that matches both eventType and payloadMatch (client-side).
    // Empty/absent eventType means all events.
    const matchingSubscription = loaded.config.subscriptions.find((subscription) => {
      // Check eventType match
      const eventTypeMatches = !subscription.eventType || subscription.eventType.length === 0 || subscription.eventType.includes(envelope.eventType);
      if (!eventTypeMatches) return false;

      // Check payload match
      return matchesPayload(envelope.payload, subscription.payloadMatch);
    });

    if (!matchingSubscription) {
      this.log(`[relay] Delivery ${envelope.deliveryId} (${envelope.eventType}) matched no subscription in relay.yml -- dropped.`);
      return;
    }

    const event = matchingSubscription.queueEvent ?? mapped.event;

    try {
      await ensureDaemonRunning(this.configDir);
      const result = await pushToQueue(this.configDir, event, mapped.payload);
      // When aborted, log a failure line with details instead of treating it as success
      if (result.status === 'aborted') {
        const reason = result.reason ? result.reason : 'no reason given';
        this.log(
          `[relay] Push of "${event}" (delivery ${envelope.deliveryId}) was ABORTED by the queue daemon: ${reason}. ` +
          `The event was not delivered; check subscribers.yml and the daemon logs in ${this.configDir}/logs.`
        );
      } else {
        // For 'dispatched', 'queued', and any other status, keep the existing success line
        this.log(`[relay] Pushed "${event}" (delivery ${envelope.deliveryId}) -> ${result.status}.`);
      }
    } catch (err) {
      this.log(
        `[relay] Failed to push "${event}" (delivery ${envelope.deliveryId}): ${getErrorMessage(err)}. ` +
        `Check subscribers.yml and the daemon logs in ${this.configDir}/logs.`
      );
    }
  }
}
