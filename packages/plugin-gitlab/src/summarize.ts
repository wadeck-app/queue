/** A property of an unknown JSON value; undefined unless the value is an object that has it. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** All whitespace runs (newlines included) become one space: a summary is one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function branchOrTag(ref: string): string {
  const mergeRequest = /^refs\/merge-requests\/(\d+)\//.exec(ref);
  if (mergeRequest !== null) {
    return `merge request !${mergeRequest[1]}`;
  }
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

const MEMBER_EVENT = /^user_.*_(team|group|project)$/;
const MEMBER_VERBS: Record<string, string> = {
  user_add_to_team: 'added',
  user_add_to_group: 'added',
  user_remove_from_team: 'removed',
  user_remove_from_group: 'removed',
  user_update_for_team: 'updated',
  user_update_for_group: 'updated',
};

/** What a note was left on (GitLab sends the noteable next to object_attributes); undefined when none is there. */
function noteTarget(payload: Record<string, unknown>): string | undefined {
  const mergeRequestIid = field(field(payload, 'merge_request'), 'iid');
  if (typeof mergeRequestIid === 'number') {
    return `merge request !${mergeRequestIid}`;
  }
  const issueIid = field(field(payload, 'issue'), 'iid');
  if (typeof issueIid === 'number') {
    return `issue #${issueIid}`;
  }
  const commitId = text(field(field(payload, 'commit'), 'id'));
  if (commitId !== undefined) {
    return `commit ${commitId.slice(0, 8)}`;
  }
  const snippetId = field(field(payload, 'snippet'), 'id');
  if (typeof snippetId === 'number') {
    return `snippet $${snippetId}`;
  }
  return undefined;
}

/**
 * One-line description of a GitLab webhook payload (project, actor, action, issue/MR number and title, branches, ref, commits, pipeline,
 * job, release, deployment, wiki page, feature flag, member, note).
 * Null when the payload has none of the known fields. The relay client caps the length.
 */
export function summarizeGitlabPayload(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const attributes = field(payload, 'object_attributes');
  const objectKind = text(field(payload, 'object_kind'));
  const eventName = text(field(payload, 'event_name'));
  const isMemberEvent = eventName !== undefined && MEMBER_EVENT.test(eventName);

  // Most events carry `project`; a job (build) carries project_name and repository.name; a project member event carries project_path_with_namespace
  const project =
    text(field(field(payload, 'project'), 'path_with_namespace')) ??
    text(field(payload, 'project_path_with_namespace')) ??
    text(field(payload, 'project_name')) ??
    text(field(field(payload, 'repository'), 'name')) ??
    (isMemberEvent ? (text(field(payload, 'group_path')) ?? text(field(payload, 'group_name'))) : undefined);
  if (project !== undefined) {
    parts.push(project);
  }

  // Issue, merge request, note, pipeline and deployment events carry `user` (a job's has a name only); push and tag events carry `user_username`.
  // In a member event the user is the member, not the actor.
  const actor =
    text(field(field(payload, 'user'), 'username')) ??
    text(field(payload, 'user_username')) ??
    text(field(field(payload, 'user'), 'name')) ??
    text(field(payload, 'user_name'));
  if (actor !== undefined && !isMemberEvent) {
    parts.push(`by ${actor}`);
  }

  // A release carries `action` at the top level, the others in object_attributes
  const action = text(field(attributes, 'action')) ?? text(field(payload, 'action'));
  if (action !== undefined) {
    parts.push(`action=${action}`);
  }

  // Issue or merge request: #iid and the title
  const iid = field(attributes, 'iid');
  const title = text(field(attributes, 'title'));
  if (typeof iid === 'number' && title !== undefined) {
    parts.push(`#${iid} ${oneLine(title)}`);
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

  // A push that deletes a ref has `after` made of zeros and no commit
  const after = text(field(payload, 'after'));
  const commits = field(payload, 'total_commits_count');
  const commitList = field(payload, 'commits');
  if (after !== undefined && /^0+$/.test(after)) {
    parts.push('deleted');
  } else if (typeof commits === 'number') {
    parts.push(`${commits} commits`);
  } else if (Array.isArray(commitList)) {
    parts.push(`${commitList.length} commits`);
  }

  const jobName = text(field(payload, 'build_name'));
  const jobStatus = text(field(payload, 'build_status'));
  if (jobName !== undefined && jobStatus !== undefined) {
    parts.push(`job ${jobName} ${jobStatus}`);
  }

  const releaseTag = text(field(payload, 'tag'));
  if (objectKind === 'release' && releaseTag !== undefined) {
    const releaseName = text(field(payload, 'name'));
    parts.push(releaseName !== undefined && releaseName !== releaseTag ? `release ${releaseTag} "${oneLine(releaseName)}"` : `release ${releaseTag}`);
  }

  const environment = text(field(payload, 'environment'));
  const deploymentStatus = text(field(payload, 'status'));
  if ((objectKind === 'deployment' || typeof field(payload, 'deployment_id') === 'number') && environment !== undefined && deploymentStatus !== undefined) {
    const shortSha = text(field(payload, 'short_sha'));
    parts.push(`deployment ${environment} ${deploymentStatus}${shortSha === undefined ? '' : ` | ${shortSha}`}`);
  }

  const wikiTitle = text(field(attributes, 'title'));
  if (objectKind === 'wiki_page' && wikiTitle !== undefined) {
    parts.push(`wiki page "${oneLine(wikiTitle)}"`);
  }

  const flagName = text(field(attributes, 'name'));
  const flagActive = field(attributes, 'active');
  if (objectKind === 'feature_flag' && flagName !== undefined) {
    parts.push(`feature flag ${flagName}${typeof flagActive === 'boolean' ? (flagActive ? ' enabled' : ' disabled') : ''}`);
  }

  const member = text(field(payload, 'user_username'));
  if (isMemberEvent && member !== undefined) {
    const access = text(field(payload, 'access_level')) ?? text(field(payload, 'group_access'));
    const verb = MEMBER_VERBS[eventName] ?? eventName;
    parts.push(`member ${member} ${verb}${access === undefined ? '' : ` (${access})`}`);
  }

  const note = text(field(attributes, 'note'));
  if (note !== undefined) {
    const flat = oneLine(note);
    const target = noteTarget(payload);
    parts.push(`comment${target === undefined ? '' : ` on ${target}`}: "${flat.length > 40 ? flat.slice(0, 40) + '...' : flat}"`);
  }

  return parts.length === 0 ? null : parts.join(' | ');
}
