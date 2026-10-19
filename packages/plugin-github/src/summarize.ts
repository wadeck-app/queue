/** A property of an unknown JSON value; undefined unless the value is an object that has it. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * One-line description of a GitHub webhook payload (repository, actor, action, ref, commit, PR/issue/run/comment).
 * Null when the payload has none of the known fields. The relay client caps the length.
 */
export function summarizeGithubPayload(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];

  // Repository name
  const repo = field(field(payload, 'repository'), 'full_name');
  if (typeof repo === 'string') {
    parts.push(repo);
  }

  // Actor (sender login)
  const sender = field(field(payload, 'sender'), 'login');
  if (typeof sender === 'string') {
    parts.push(`by ${sender}`);
  }

  // Action
  const action = field(payload, 'action');
  if (typeof action === 'string') {
    parts.push(`action=${action}`);
  }

  // Branch/ref (strip refs/heads/ prefix)
  const ref = field(payload, 'ref');
  if (typeof ref === 'string') {
    parts.push(ref.startsWith('refs/heads/') ? ref.slice(11) : ref);
  }

  // Commit message first line
  const commitMsg = field(field(payload, 'head_commit'), 'message');
  if (typeof commitMsg === 'string') {
    const firstLine = commitMsg.split('\n')[0];
    parts.push(`"${firstLine}"`);
  }

  // Commits count
  const commits = field(payload, 'commits');
  if (Array.isArray(commits)) {
    parts.push(`${commits.length} commits`);
  }

  // Pull request number and title
  const pr = field(payload, 'pull_request');
  if (typeof pr === 'object' && pr !== null) {
    const num = field(pr, 'number');
    const title = field(pr, 'title');
    if (typeof num === 'number' && typeof title === 'string') {
      parts.push(`#${num} ${title}`);
    }
  }

  // Issue number and title
  const issue = field(payload, 'issue');
  if (typeof issue === 'object' && issue !== null) {
    const num = field(issue, 'number');
    const title = field(issue, 'title');
    if (typeof num === 'number' && typeof title === 'string') {
      parts.push(`#${num} ${title}`);
    }
  }

  // Workflow run name and conclusion
  const workflow = field(payload, 'workflow_run');
  if (typeof workflow === 'object' && workflow !== null) {
    const name = field(workflow, 'name');
    const conclusion = field(workflow, 'conclusion');
    if (typeof name === 'string' && typeof conclusion === 'string') {
      parts.push(`${name} ${conclusion}`);
    }
  }

  // Check run name and conclusion
  const checkRun = field(payload, 'check_run');
  if (typeof checkRun === 'object' && checkRun !== null) {
    const name = field(checkRun, 'name');
    const conclusion = field(checkRun, 'conclusion');
    if (typeof name === 'string' && typeof conclusion === 'string') {
      parts.push(`${name} ${conclusion}`);
    }
  }

  // Comment body (first 40 chars)
  const comment = field(field(payload, 'comment'), 'body');
  if (typeof comment === 'string') {
    const truncated = comment.length > 40 ? comment.slice(0, 40) + '...' : comment;
    parts.push(`comment: "${truncated}"`);
  }

  return parts.length === 0 ? null : parts.join(' | ');
}
