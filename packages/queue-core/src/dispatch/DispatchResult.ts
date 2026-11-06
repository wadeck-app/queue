/** What a transport (cli, http, action) reports for one dispatch of one event to one subscriber. */
export interface DispatchResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
  /** Exit code of a cli command that ran to its end (zero or not). Absent when it never started, timed out, or for http/action. */
  exitCode?: number;
  /** The failure cannot be fixed by trying again (the command or the event is the problem): no retry, straight to the DLQ. */
  permanent?: true;
  /** A one-line trace of what an action did on success (e.g. the event it emitted). Logged by the dispatcher, never parsed: stdout stays empty for an action. */
  detail?: string;
}
