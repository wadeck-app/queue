export interface EventMeta {
  cwd: string;
  projectName?: string;
}

export interface EventEnvelope {
  id: string;
  timestamp: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
}

export interface ResolvedSubscriber {
  subscriberId: string;
  event: string;
  type: 'cli' | 'http';
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  retries: number;
  when?: string;
  timeoutMs: number;
  backoff: 'exponential' | 'linear';
}
