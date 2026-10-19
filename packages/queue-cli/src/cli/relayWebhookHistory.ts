/**
 * Show webhook delivery history from the relay.
 * Makes exactly one HTTP request to /api/webhook-history with optional filters.
 */

import type { DeliveryInfo, DeliveryQuery } from '@wadeck-app/queue-relay-client';
import { summarizePayload } from '@wadeck-app/queue-relay-client';
import { getErrorMessage } from '@wadeck-app/queue-core';

export interface RelayApiClient {
  listDeliveries(query?: DeliveryQuery): Promise<DeliveryInfo[]>;
  listWebhookConfigs(): Promise<unknown[]>;
}

export interface HistoryIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export interface HistoryOptions {
  json?: boolean;
}

interface ParsedHistoryFlags {
  limit: number;
  eventType?: string;
  source?: string;
  verified?: boolean;
  payload: boolean;
  json: boolean;
  errors: string[];
}

function parseHistoryFlags(args: string[]): ParsedHistoryFlags {
  const errors: string[] = [];
  let limit = 20;
  let eventType: string | undefined;
  let source: string | undefined;
  let verified: boolean | undefined;
  let payload = false;
  let json = false;

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      return undefined;
    }
    const next = args[idx + 1];
    if (!next || next.startsWith('--')) {
      return undefined;
    }
    return next;
  };

  // Parse --limit
  if (args.includes('--limit')) {
    const limitVal = getArg('--limit');
    if (limitVal === undefined) {
      errors.push('--limit requires a value');
    } else {
      const parsed = Number(limitVal);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
        errors.push(`--limit must be a positive integer between 1 and 200, got: ${limitVal}`);
      } else {
        limit = parsed;
      }
    }
  }

  // Parse --event
  if (args.includes('--event')) {
    const eventVal = getArg('--event');
    if (eventVal === undefined) {
      errors.push('--event requires a value');
    } else {
      eventType = eventVal;
    }
  }

  // Parse --source
  if (args.includes('--source')) {
    const sourceVal = getArg('--source');
    if (sourceVal === undefined) {
      errors.push('--source requires a value');
    } else {
      source = sourceVal;
    }
  }

  // Parse --verified and --rejected (mutually exclusive)
  const hasVerified = args.includes('--verified');
  const hasRejected = args.includes('--rejected');

  if (hasVerified && hasRejected) {
    errors.push('--verified and --rejected are mutually exclusive');
  } else if (hasVerified) {
    verified = true;
  } else if (hasRejected) {
    verified = false;
  }

  // Parse --payload
  payload = args.includes('--payload');

  // Parse --json
  json = args.includes('--json');

  return { limit, eventType, source, verified, payload, json, errors };
}

export async function relayWebhookHistory(
  client: RelayApiClient,
  io: HistoryIO,
  options: HistoryOptions,
  args: string[]
): Promise<number> {
  // Parse and validate flags first (before making any network calls)
  const flags = parseHistoryFlags(args);

  if (flags.errors.length > 0) {
    for (const err of flags.errors) {
      io.stderr.write(`[fail] ${err}\n`);
    }
    return 1;
  }

  try {
    // Build query object
    const query: DeliveryQuery = {
      limit: flags.limit,
      includePayload: true, // Always request payload to show summary
    };

    if (flags.eventType !== undefined) {
      query.eventType = flags.eventType;
    }
    if (flags.source !== undefined) {
      query.source = flags.source;
    }
    if (flags.verified !== undefined) {
      query.verified = flags.verified;
    }

    const deliveries = await client.listDeliveries(query);

    // JSON output
    if (options.json || flags.json) {
      if (flags.payload) {
        // Include full payload
        io.stdout.write(JSON.stringify(deliveries, null, 2) + '\n');
      } else {
        // Remove payload from output for compact JSON
        const compact = deliveries.map((d) => {
          const { payload, ...rest } = d;
          return rest;
        });
        io.stdout.write(JSON.stringify(compact, null, 2) + '\n');
      }
      return 0;
    }

    if (deliveries.length === 0) {
      io.stderr.write(
        '[info] No delivery recorded by the relay (for these filters). GitHub sends a "ping" the moment a webhook is created: ' +
        'if none shows up, the GitHub webhook is not pointing at this relay yet. ' +
        'Run "queue relay webhook list" for the exact payload URL to paste in the GitHub webhook settings.\n'
      );
      return 0;
    }

    // Text output (one line per delivery)
    for (const delivery of deliveries) {
      const time = delivery.receivedAt;
      const source = delivery.source;
      const eventType = delivery.eventType;
      const status = delivery.verified ? 'VERIFIED' : 'REJECTED';

      // Show error for rejected, or payload summary for verified
      let summary: string;
      if (!delivery.verified && delivery.error) {
        summary = delivery.error;
      } else {
        summary = summarizePayload(delivery.source, delivery.eventType, delivery.payload ?? undefined);
      }

      io.stdout.write(`${time}  ${source}  ${eventType}  ${status}  ${summary}\n`);

      // Print full payload as indented JSON if --payload flag is set
      if (flags.payload && delivery.payload) {
        const payloadJson = JSON.stringify(delivery.payload, null, 2);
        for (const line of payloadJson.split('\n')) {
          io.stdout.write(`  ${line}\n`);
        }
      }
    }

    return 0;
  } catch (err) {
    const message = getErrorMessage(err);
    io.stderr.write(`[fail] ${message}\n`);
    return 1;
  }
}
