import WebSocket from 'ws';
import { getErrorMessage, isRecord } from '@wadeck-app/queue-core';
import { loadRelayConfig, type RelayConfig, type PluginConfig } from './config.js';
import { loadPlugin, type RelayPlugin, type RelayEnvelope } from './plugin-api.js';
import { ensureDaemonRunning, pushToQueue } from './push.js';
import { matchesPayload } from './payloadMatch.js';
import { pushLogLine } from './pushLogLine.js';

interface LoadedPlugin {
  plugin: RelayPlugin;
  config: PluginConfig;
}

export interface ReconnectOptions {
  minMs: number;
  maxMs: number;
  authBlockedMs: number;
  tryAgainMs: number;
  abuseMs: number;
  random: () => number;
}

export interface RelayConnectionOptions {
  configDir: string;
  onLog?: (line: string) => void;
  retryDelayMs?: number;
  reconnect?: Partial<ReconnectOptions>;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  // Exists for timing-free test assertions: replaces the sleep of the connection loop (retry and backoff waits) so a test can
  // count the loop passes instead of waiting a duration. Production never sets it.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Exists for timing-free test assertions: replaces the timer functions of the heartbeat so a test can see whether a tick is
  // still scheduled (for example after stop()). Production never sets it.
  heartbeatTimers?: HeartbeatTimers;
  // Exists for timing-free test assertions: called once when the connection loop has ended (stop() was honoured), so a test can
  // wait for that fact instead of a duration before asserting that nothing reconnected. Production never sets it.
  onLoopEnd?: () => void;
}

// How a delivery ended: pushed to the queue daemon, failed (push error, aborted or rejected), dropped by its plugin, matched no
// subscription of relay.yml, or no plugin is loaded for its source
type DeliveryOutcome = 'pushed' | 'failed' | 'dropped' | 'no-subscription' | 'no-plugin';

export interface HeartbeatTimers {
  set: (fn: () => void, ms: number) => NodeJS.Timeout;
  clear: (timer: NodeJS.Timeout) => void;
}

export interface ConnectionDiagnostics {
  lastError: string | null;
  lastErrorAt: string | null;
  lastCloseCode: number | null;
}

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const NO_CONFIG_RETRY_DELAY_MS = 30_000;
const DEFAULT_AUTH_BLOCKED_MS = 600_000;
const DEFAULT_TRY_AGAIN_MS = 60_000;
const DEFAULT_ABUSE_MS = 300_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

// Computes reconnect delay with jitter: baseMs * (0.8 + random() * 0.4)
// Ensures minimum of minMs before jitter is applied
export function computeReconnectDelay(baseMs: number, minMs: number, random: () => number): number {
  // Ensure base delay is at least minMs
  const adjustedMs = Math.max(baseMs, minMs);
  // Apply jitter: 0.8 to 1.2 multiplier
  const jitterFactor = 0.8 + random() * 0.4;
  return Math.round(adjustedMs * jitterFactor);
}

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
  private readonly reconnect: ReconnectOptions;
  private readonly heartbeat: { intervalMs: number; timeoutMs: number };
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly heartbeatTimers: HeartbeatTimers;
  private readonly onLoopEnd: (() => void) | undefined;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private loadedPlugins: LoadedPlugin[] = [];
  private sleepAbortController: AbortController | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private lastCloseCode: number | null = null;
  // Track token refusal state: { relayUrl, token } that was refused, or null
  private refusedAuthConfig: { relayUrl: string; token: string } | null = null;
  // Track if we're waiting due to a special backoff (auth-refused/4429/4400/1013)
  private lastBackoffReason: 'auth-refused' | 'auth-blocked' | 'try-again' | 'abuse' | null = null;
  // Track pending auth error message to pair with close code
  private pendingAuthErrorMsg: string | null = null;
  // Subscribe acknowledgements received on this connection (they arrive in the order the subscribes were sent)
  private acksReceived = 0;
  // Only warn once per connection when the relay replaces filters instead of appending them
  private hasWarnedAboutSubscriptionReplacement = false;
  // Module names in the order their subscribe was sent, to name the plugin an acknowledgement belongs to
  private subscribedModules: string[] = [];
  // Heartbeat timer for liveness detection
  private heartbeatTimer: NodeJS.Timeout | null = null;
  // Track last activity time (message, ping, or pong)
  private lastActivityAt: number | null = null;

  constructor(options: RelayConnectionOptions) {
    this.configDir = options.configDir;
    this.log = options.onLog ?? (() => {});
    this.retryDelayMs = options.retryDelayMs ?? NO_CONFIG_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? sleep;
    this.onLoopEnd = options.onLoopEnd;
    this.heartbeatTimers = options.heartbeatTimers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) };
    this.reconnect = {
      minMs: options.reconnect?.minMs ?? MIN_RECONNECT_DELAY_MS,
      maxMs: options.reconnect?.maxMs ?? MAX_RECONNECT_DELAY_MS,
      authBlockedMs: options.reconnect?.authBlockedMs ?? DEFAULT_AUTH_BLOCKED_MS,
      tryAgainMs: options.reconnect?.tryAgainMs ?? DEFAULT_TRY_AGAIN_MS,
      abuseMs: options.reconnect?.abuseMs ?? DEFAULT_ABUSE_MS,
      random: options.reconnect?.random ?? Math.random,
    };
    this.heartbeat = {
      intervalMs: options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      timeoutMs: options.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
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
    try {
      await this.connectLoop();
    } finally {
      this.onLoopEnd?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    // Interrupt any in-progress sleep to allow immediate shutdown
    this.sleepAbortController?.abort();
    // Clear heartbeat timer on stop
    if (this.heartbeatTimer) {
      this.heartbeatTimers.clear(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Where to fix a refused token: the secrets file is the recommended home, relay.yml the deprecated one
  private tokenFixHint(): string {
    return `Fix QUEUE_RELAY_TOKEN in ${this.configDir}/_secrets_/.env.local (or "token" in relay.yml if that is where it is still set).`;
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
        await this.sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying config load
        if (this.stopped) {
          break;
        }
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
        await this.sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying
        if (this.stopped) {
          break;
        }
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
        await this.sleep(this.retryDelayMs, this.sleepAbortController.signal);
        // Check stopped flag after sleep before retrying
        if (this.stopped) {
          break;
        }
        continue;
      }

      // Check stopped flag after plugin load completes before attempting connection
      if (this.stopped) {
        break;
      }

      // Check if token was previously refused and has not changed
      if (this.refusedAuthConfig) {
        if (
          this.refusedAuthConfig.relayUrl === config.relayUrl &&
          this.refusedAuthConfig.token === config.token
        ) {
          // Token hasn't changed; stay in retry loop without reconnecting
          this.sleepAbortController = new AbortController();
          await this.sleep(this.retryDelayMs, this.sleepAbortController.signal);
          if (this.stopped) {
            break;
          }
          continue;
        } else {
          // Token or URL changed; clear refusal state and attempt connection
          this.refusedAuthConfig = null;
        }
      }

      try {
        await this.connectOnce(config);
      } catch (err) {
        this.log(`[relay] Connection error: ${getErrorMessage(err)}`);
      }

      this.connected = false;
      if (this.stopped) {
        break;
      }

      // Determine the backoff delay based on the reason for disconnection
      let backoffMs: number;
      if (this.lastBackoffReason === 'auth-blocked') {
        backoffMs = this.reconnect.authBlockedMs;
        this.lastBackoffReason = null;
      } else if (this.lastBackoffReason === 'try-again') {
        backoffMs = this.reconnect.tryAgainMs;
        this.lastBackoffReason = null;
      } else if (this.lastBackoffReason === 'abuse') {
        backoffMs = this.reconnect.abuseMs;
        this.lastBackoffReason = null;
      } else {
        // Normal exponential backoff
        backoffMs = computeReconnectDelay(
          this.reconnectDelay,
          this.reconnect.minMs,
          this.reconnect.random
        );
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnect.maxMs);
      }

      this.sleepAbortController = new AbortController();
      await this.sleep(backoffMs, this.sleepAbortController.signal);
      // Check stopped flag after sleep before retrying
      if (this.stopped) {
        break;
      }
    }
  }

  /** Resolves once the connection closes (cleanly or not); rejects only on a connect-time error. */
  private connectOnce(config: RelayConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.relayUrl);
      this.ws = ws;
      let settled = false;
      // Reset subscription tracking for this connection
      this.acksReceived = 0;
      this.hasWarnedAboutSubscriptionReplacement = false;
      this.subscribedModules = [];
      // Reset activity tracking for heartbeat
      this.lastActivityAt = null;
      let heartbeatStarted = false;

      // R10: Start heartbeat timer after authentication
      const startHeartbeat = () => {
        if (heartbeatStarted || this.heartbeatTimer) {
          return;
        }
        heartbeatStarted = true;
        this.lastActivityAt = Date.now();

        const tick = () => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }

          const now = Date.now();
          const timeSinceLastActivity = now - (this.lastActivityAt ?? now);
          const threshold = this.heartbeat.intervalMs + this.heartbeat.timeoutMs;

          if (timeSinceLastActivity >= threshold) {
            // No sign of life: terminate connection and let normal reconnect flow handle it
            const secs = Math.round(threshold / 1000);
            const errorMsg = `No sign of life from the relay for ${secs}s: connection considered dead, reconnecting.`;
            this.lastError = errorMsg;
            this.lastErrorAt = new Date().toISOString();
            this.log(`[relay] ${errorMsg}`);
            ws.terminate();
            // After terminating, don't schedule another tick
            return;
          }

          // Send ping to check liveness
          ws.ping();
          // Schedule next tick
          this.heartbeatTimer = this.heartbeatTimers.set(tick, this.heartbeat.intervalMs);
        };

        this.heartbeatTimer = this.heartbeatTimers.set(tick, this.heartbeat.intervalMs);
        // Make timer non-blocking (don't keep process alive)
        if (this.heartbeatTimer.unref) {
          this.heartbeatTimer.unref();
        }
      };

      // A close that follows a failed upgrade (HTTP 429/503, ECONNREFUSED) is a synthetic 1006, not a code from the relay
      let opened = false;
      ws.on('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'auth', token: config.token }));
      });

      ws.on('message', (raw) => {
        // Track activity for heartbeat liveness
        this.lastActivityAt = Date.now();
        const rawStr = String(raw);
        const msg: unknown = JSON.parse(rawStr);
        // Start heartbeat after successful authentication
        if (isRecord(msg) && msg.type === 'authenticated') {
          startHeartbeat();
        }
        void this.handleMessage(rawStr, config).catch((err) => {
          this.log(`[relay] Error handling message: ${getErrorMessage(err)}`);
        });
      });

      // Handler for ping events (incoming pings from relay count as activity)
      ws.on('ping', () => {
        this.lastActivityAt = Date.now();
      });

      // Handler for pong events (responses to our pings count as activity)
      ws.on('pong', () => {
        this.lastActivityAt = Date.now();
      });

      ws.on('close', (code) => {
        this.connected = false;
        // Clear heartbeat timer when connection closes
        if (this.heartbeatTimer) {
          this.heartbeatTimers.clear(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        // Record the close code for diagnostics (only when the websocket really opened)
        if (opened) {
          this.lastCloseCode = code;
        }

        // Handle close codes indicating auth refusal
        if (code === 4401) {
          // Token revoked (hardened relay)
          this.lastError = `The relay refused the token (close code 4401). ${this.tokenFixHint()}`;
          this.lastErrorAt = new Date().toISOString();
          this.refusedAuthConfig = { relayUrl: config.relayUrl, token: config.token };
          this.lastBackoffReason = 'auth-refused';
          this.log(`[relay] The relay refused the token (close code 4401). Not retrying: every failed attempt counts against this machine's IP and can lock it out. ${this.tokenFixHint()} The configuration is re-checked every ${Math.round(this.retryDelayMs / 1000)}s.`);
        } else if (code === 4429) {
          // Too many failed auth attempts from this IP
          const mins = Math.ceil(this.reconnect.authBlockedMs / 60000);
          this.lastError = `Too many failed authentications from this IP (4429): backing off ${mins} min.`;
          this.lastErrorAt = new Date().toISOString();
          this.lastBackoffReason = 'auth-blocked';
          this.log(`[relay] Too many failed authentications from this IP (4429): backing off ${mins} min.`);
        } else if (code === 4400) {
          // Protocol error
          const mins = Math.ceil(this.reconnect.abuseMs / 60000);
          this.lastError = `The relay reported a protocol error (4400); backing off ${mins} min.`;
          this.lastErrorAt = new Date().toISOString();
          this.lastBackoffReason = 'abuse';
          this.log(`[relay] The relay reported a protocol error (4400); backing off ${mins} min.`);
        } else if (code === 1013) {
          // Try again later
          const secs = Math.ceil(this.reconnect.tryAgainMs / 1000);
          this.lastError = `The relay is temporarily unavailable (1013); backing off ${secs}s.`;
          this.lastErrorAt = new Date().toISOString();
          this.lastBackoffReason = 'try-again';
          this.log(`[relay] The relay is temporarily unavailable (1013); backing off ${secs}s.`);
        } else if (code === 4001) {
          // Check if we have a pending auth error message
          if (this.pendingAuthErrorMsg) {
            // Auth error was sent before close - token is refused
            this.lastError = `The relay refused the token (close code 4001). ${this.tokenFixHint()}`;
            this.lastErrorAt = new Date().toISOString();
            this.refusedAuthConfig = { relayUrl: config.relayUrl, token: config.token };
            this.lastBackoffReason = 'auth-refused';
            this.pendingAuthErrorMsg = null;
          } else {
            // Bare 4001 close without error message is the relay's authentication timeout, not a refusal: normal backoff
            this.lastError = 'The relay closed the connection because authentication timed out (close code 4001); retrying with backoff.';
            this.lastErrorAt = new Date().toISOString();
          }
        } else {
          // All other closes (network drop, 1006, 1001, etc.) - normal backoff
        }

        this.log('[relay] Connection closed.');
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('error', (err) => {
        // stop() aborts a handshake in flight: that error is ours, not a relay diagnostic, and must not overwrite the real lastError
        if (this.stopped) {
          if (!settled) { settled = true; reject(err); }
          return;
        }
        const errorMsg = getErrorMessage(err);
        // R9: Check for HTTP 429 on websocket upgrade
        if (errorMsg.includes('429')) {
          const mins = Math.ceil(this.reconnect.authBlockedMs / 60000);
          this.lastError = `The relay answered HTTP 429 (this IP is blocked after too many failed authentications): backing off ${mins} min.`;
          this.lastErrorAt = new Date().toISOString();
          this.lastBackoffReason = 'auth-blocked';
          this.log(`[relay] ${this.lastError}`);
        } else if (errorMsg.includes('Unexpected server response:')) {
          // Extract status code from error message (e.g., "Unexpected server response: 503")
          const statusMatch = errorMsg.match(/Unexpected server response: (\d+)/);
          if (statusMatch) {
            const status = statusMatch[1];
            this.lastError = `The relay answered HTTP ${status} to the websocket upgrade.`;
            this.lastErrorAt = new Date().toISOString();
            this.log(`[relay] ${this.lastError}`);
          } else {
            this.lastError = `Connection error: ${errorMsg}`;
            this.lastErrorAt = new Date().toISOString();
          }
        } else {
          const msg = `Connection error: ${errorMsg}`;
          // Record diagnostics for connection error
          this.lastError = msg;
          this.lastErrorAt = new Date().toISOString();
        }
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  private async handleMessage(
    raw: string,
    config: RelayConfig
  ): Promise<void> {
    const msg: unknown = JSON.parse(raw);
    if (!isRecord(msg)) {
      throw new Error(`The relay sent a message that is not a JSON object: ${raw.slice(0, 100)}`);
    }
    switch (msg.type) {
      case 'authenticated':
        this.connected = true;
        // Clear error state on successful authentication
        this.lastError = null;
        this.lastErrorAt = null;
        this.reconnectDelay = this.reconnect.minMs;
        // Clear refusal state on success
        this.refusedAuthConfig = null;
        this.pendingAuthErrorMsg = null;
        this.log(`[relay] Authenticated as ${String(msg.username)}.`);
        this.subscribeAll();
        break;
      case 'error': {
        const errorText = String(msg.error);
        // Check if this is an auth refusal
        if (/invalid token|revoked|unauthori[sz]ed|forbidden/i.test(errorText)) {
          // Mark that we received an auth error; will pair with close code in connectOnce
          this.pendingAuthErrorMsg = errorText;
          this.refusedAuthConfig = { relayUrl: config.relayUrl, token: config.token };
          this.log(`[relay] The relay refused the token (${errorText}). Not retrying: every failed attempt counts against this machine's IP and can lock it out. ${this.tokenFixHint()} The configuration is re-checked every ${Math.round(this.retryDelayMs / 1000)}s.`);
        } else {
          this.log(`[relay] Relay reported an error: ${errorText}`);
          this.lastError = `Relay rejected the connection: ${errorText}`;
          this.lastErrorAt = new Date().toISOString();
        }
        break;
      }
      case 'subscribed': {
        // Acknowledgements arrive in the order the subscribes were sent: this is the Nth one of the connection
        this.acksReceived += 1;
        const subscriptionCount = typeof msg.subscriptionCount === 'number' ? msg.subscriptionCount : null;
        const filterStr = JSON.stringify(msg.filter);
        this.log(
          subscriptionCount !== null && subscriptionCount > 1
            ? `[relay] Subscribed: ${filterStr} (${subscriptionCount} filters on this connection)`
            : `[relay] Subscribed: ${filterStr}`
        );

        // A relay that appends filters reports subscriptionCount >= the number of subscribes acknowledged so far;
        // an older relay keeps one filter per connection and its acknowledgement has no (or a lower) count
        const appendsFilters = subscriptionCount !== null && subscriptionCount >= this.acksReceived;
        if (this.acksReceived > 1 && !appendsFilters && !this.hasWarnedAboutSubscriptionReplacement) {
          this.hasWarnedAboutSubscriptionReplacement = true;
          const moduleName = this.subscribedModules[this.acksReceived - 1] ?? 'unknown';
          const reason = subscriptionCount === null ? 'acknowledgement without subscriptionCount' : 'subscriptionCount lower than subscribes sent';
          this.log(
            `[relay] Subscription of plugin "${moduleName}" replaced an earlier one: ` +
            `this relay keeps a single filter per connection (${reason}). ` +
            `Only the last plugin's events are delivered; upgrade the relay or configure one plugin per source.`
          );
        }
        break;
      }
      case 'event':
        await this.dispatchEvent(msg.envelope as RelayEnvelope);
        break;
      default:
        this.log(`[relay] Unknown message type from relay: ${String(msg.type)}`);
    }
  }

  private subscribeAll(): void {
    if (!this.ws) {
      return;
    }
    // Send ONE subscribe message per loaded plugin with union of eventTypes and empty payloadMatch.
    // The relay-side filter is deliberately coarse; precise filtering happens on the client
    // via matchesPayload in dispatchEvent, allowing subscriptions to override each other
    // by payloadMatch without sending multiple filters to the relay.
    this.acksReceived = 0;
    this.subscribedModules = [];

    for (const { plugin, config } of this.loadedPlugins) {
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
      this.subscribedModules.push(config.module);
    }
  }

  // The last line of every delivery, logged once its handling is over (the push included), whatever the outcome. It exists for
  // timing-free test assertions: a test waits for this line instead of a duration. Format: "[relay] Delivery <id> processed (<outcome>)".
  private async dispatchEvent(envelope: RelayEnvelope): Promise<void> {
    let outcome: DeliveryOutcome = 'failed';
    try {
      outcome = await this.processDelivery(envelope);
    } finally {
      this.log(`[relay] Delivery ${envelope.deliveryId} processed (${outcome})`);
    }
  }

  private async processDelivery(envelope: RelayEnvelope): Promise<DeliveryOutcome> {
    const loaded = this.loadedPlugins.find((entry) => entry.plugin.source === envelope.source);
    if (!loaded) {
      this.log(`[relay] No plugin loaded for source "${envelope.source}" -- dropping delivery ${envelope.deliveryId}.`);
      return 'no-plugin';
    }

    const mapped = loaded.plugin.mapEvent(envelope);
    if (!mapped) {
      this.log(`[relay] Plugin "${loaded.plugin.source}" dropped delivery ${envelope.deliveryId}.`);
      return 'dropped';
    }

    // Find the FIRST subscription that matches both eventType and payloadMatch (client-side).
    // Empty/absent eventType means all events.
    const matchingSubscription = loaded.config.subscriptions.find((subscription) => {
      // Check eventType match
      const eventTypeMatches = !subscription.eventType || subscription.eventType.length === 0 || subscription.eventType.includes(envelope.eventType);
      if (!eventTypeMatches) {
        return false;
      }

      // Check payload match
      return matchesPayload(envelope.payload, subscription.payloadMatch);
    });

    if (!matchingSubscription) {
      this.log(`[relay] Delivery ${envelope.deliveryId} (${envelope.eventType}) matched no subscription in relay.yml -- dropped.`);
      return 'no-subscription';
    }

    const event = matchingSubscription.queueEvent ?? mapped.event;

    try {
      await ensureDaemonRunning(this.configDir);
      const result = await pushToQueue(this.configDir, event, mapped.payload);
      this.log(pushLogLine({ event, deliveryId: envelope.deliveryId, result, configDir: this.configDir }));
      return result.status === 'aborted' || result.status === 'rejected' ? 'failed' : 'pushed';
    } catch (err) {
      this.log(
        `[relay] Failed to push "${event}" (delivery ${envelope.deliveryId}): ${getErrorMessage(err)}. ` +
        `Check subscribers.yml and the daemon logs in ${this.configDir}/logs.`
      );
      return 'failed';
    }
  }
}
