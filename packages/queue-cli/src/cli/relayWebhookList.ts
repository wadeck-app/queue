/**
 * List configured webhooks on the relay with their health status.
 * Makes exactly one HTTP request to /api/webhook-configs.
 */

import type { WebhookConfigInfo } from '@wadeck-app/queue-relay-client';

export interface RelayApiClient {
  listWebhookConfigs(): Promise<WebhookConfigInfo[]>;
  listDeliveries(query?: unknown): Promise<unknown[]>;
}

export interface ListIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export interface ListOptions {
  json?: boolean;
  // Scheme + host of the relay, prefixed to each webhook path to print the full payload URL
  origin?: string;
}

export async function relayWebhookList(
  client: RelayApiClient,
  io: ListIO,
  options: ListOptions
): Promise<number> {
  try {
    const configs = await client.listWebhookConfigs();

    if (options.json) {
      io.stdout.write(JSON.stringify(configs, null, 2) + '\n');
      return 0;
    }

    if (configs.length === 0) {
      io.stderr.write(
        `[info] No webhook configured on the relay (create one in the relay UI, then point the GitHub webhook at ` +
        `<origin>/webhook/github/<id> or similar).\n`
      );
      return 0;
    }

    // One block per webhook: the full id and URL matter (they are pasted into the GitHub webhook settings)
    for (const config of configs) {
      const url = (options.origin ?? '') + config.webhookUrl;
      const stats = config.stats;
      const health = stats
        ? `${stats.verified24h} verified, ${stats.rejected24h} rejected in the last 24h; last delivery ${stats.lastDeliveryAt ?? 'never'}`
        : 'statistics not reported by this relay (see: queue relay webhook history)';
      io.stdout.write(`${config.name}  (${config.source}, created ${config.createdAt})
`);
      io.stdout.write(`  id:      ${config.id}
`);
      io.stdout.write(`  url:     ${url}   <- payload URL for the GitHub webhook
`);
      io.stdout.write(`  health:  ${health}

`);
    }

    // Print summary line
    const count = configs.length;
    io.stdout.write(`\n${count} webhook${count === 1 ? '' : 's'}\n`);

    return 0;
  } catch (err) {
    const message = (err as any)?.message ?? String(err);
    io.stderr.write(`[fail] ${message}\n`);
    return 1;
  }
}
