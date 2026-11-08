/** A property of an unknown JSON value; undefined unless the value is an object that has it. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function branchOrTag(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/**
 * One-line description of a GitLab webhook payload (project, actor, action, issue/MR number and title, branches, ref, commits, pipeline, job, note).
 * Null when the payload has none of the known fields. The relay client caps the length.
 */
export function summarizeGitlabPayload(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const attributes = field(payload, 'object_attributes');

  const project = text(field(field(payload, 'project'), 'path_with_namespace'));
  if (project !== undefined) {
    parts.push(project);
  }

  // Issue, merge request, note and pipeline events carry `user`; push and tag events carry `user_username`
  const actor = text(field(field(payload, 'user'), 'username')) ?? text(field(payload, 'user_username'));
  if (actor !== undefined) {
    parts.push(`by ${actor}`);
  }

  const action = text(field(attributes, 'action'));
  if (action !== undefined) {
    parts.push(`action=${action}`);
  }

  // Issue or merge request: #iid and the first line of the title
  const iid = field(attributes, 'iid');
  const title = text(field(attributes, 'title'));
  if (typeof iid === 'number' && title !== undefined) {
    parts.push(`#${iid} ${title.split('\n')[0]}`);
  }

  const sourceBranch = text(field(attributes, 'source_branch'));
  const targetBranch = text(field(attributes, 'target_branch'));
  if (sourceBranch !== undefined && targetBranch !== undefined) {
    parts.push(`${sourceBranch} -> ${targetBranch}`);
  }

  // Push, tag push and job events carry the ref at the top level; a pipeline carries it in object_attributes
  const ref = text(field(payload, 'ref'));
  if (ref !== undefined) {
    parts.push(branchOrTag(ref));
  }

  const pipelineRef = text(field(attributes, 'ref'));
  const pipelineStatus = text(field(attributes, 'status'));
  if (pipelineRef !== undefined) {
    parts.push(branchOrTag(pipelineRef));
    if (pipelineStatus !== undefined) {
      parts.push(`pipeline ${pipelineStatus}`);
    }
  }

  const commits = field(payload, 'total_commits_count');
  const commitList = field(payload, 'commits');
  if (typeof commits === 'number') {
    parts.push(`${commits} commits`);
  } else if (Array.isArray(commitList)) {
    parts.push(`${commitList.length} commits`);
  }

  const jobName = text(field(payload, 'build_name'));
  const jobStatus = text(field(payload, 'build_status'));
  if (jobName !== undefined && jobStatus !== undefined) {
    parts.push(`job ${jobName} ${jobStatus}`);
  }

  const note = text(field(attributes, 'note'));
  if (note !== undefined) {
    parts.push(`comment: "${note.length > 40 ? note.slice(0, 40) + '...' : note}"`);
  }

  return parts.length === 0 ? null : parts.join(' | ');
}
