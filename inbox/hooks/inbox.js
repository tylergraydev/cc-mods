import { lockState } from './lock';
import { level, shortDuration, stallCounts, toolLabel } from './watch';
// The inbox's pure side: the task file format, the subagent's brief, the
// /inbox arguments, which tasks a drain starts next and the state summary.
export { toolLabel };
export const DIR = '.inbox';
const STATUSES = ['open', 'running', 'done', 'failed'];
const RESULT = '\n## Result\n';
export const slug = (title) => title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
export const fileName = (id, title) => `${String(id).padStart(3, '0')}-${slug(title)}.md`;
export const isTaskFile = (name) => /^\d+-.*\.md$/.test(name);
export const nextId = (tasks) => tasks.reduce((max, one) => Math.max(max, one.id), 0) + 1;
const oneLine = (text) => text.replace(/\s*\r?\n\s*/g, ' ').trim();
/** Reads a task file. A file with no front matter is an open task titled by its first line. */
export function parseTask(file, text) {
    const id = Number(/^(\d+)/.exec(file)?.[1] ?? 0);
    const fields = {};
    let rest = text.replace(/\r\n/g, '\n');
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(rest);
    if (front) {
        for (const line of (front[1] ?? '').split('\n')) {
            const at = line.indexOf(':');
            if (at > 0)
                fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        rest = rest.slice(front[0].length);
    }
    const cut = rest.lastIndexOf(RESULT);
    const body = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    const result = cut >= 0 ? rest.slice(cut + RESULT.length).trim() : undefined;
    const status = STATUSES.find(one => one === fields.status) ?? 'open';
    const title = fields.title || body.split('\n')[0]?.replace(/^#+\s*/, '') || file;
    return {
        id,
        file,
        title,
        status,
        ...(fields.agent ? { agent: fields.agent } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        created: fields.created ?? '',
        updated: fields.updated ?? fields.created ?? '',
        ...(fields.agentId ? { agentId: fields.agentId } : {}),
        ...(fields.commit ? { commit: fields.commit } : {}),
        body,
        ...(result ? { result } : {}),
    };
}
export function serializeTask(task) {
    const fields = [
        ['id', String(task.id)],
        ['title', oneLine(task.title)],
        ['status', task.status],
        ['agent', task.agent],
        ['model', task.model],
        ['created', task.created],
        ['updated', task.updated],
        ['agentId', task.agentId],
        ['commit', task.commit],
    ];
    const front = fields.filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
    const parts = [`---\n${front.join('\n')}\n---`, task.body.trim()];
    if (task.result)
        parts.push(`## Result\n\n${task.result.trim()}`);
    return `${parts.filter(Boolean).join('\n\n')}\n`;
}
/** What the subagent deployed on a task is told. */
export function brief(task) {
    return [
        `You are working inbox task #${task.id} (${DIR}/${task.file} in this repository).`,
        '',
        `# ${task.title}`,
        '',
        task.body || '(No further description: the title is the task.)',
        '',
        'Do the task. When you are finished, end with a short report: what you changed (files), how you checked it, and anything left open or worth a follow-up task.',
        `Do not edit ${DIR}/${task.file}; the inbox records your report there.`,
    ].join('\n');
}
/** What the reviewer deployed on a finished task is told. */
export function reviewBrief(task, trailer) {
    const grep = commitGrepArgv(task.id, trailer).slice(1).join(' ');
    return [
        `You are reviewing inbox task #${task.id} (${DIR}/${task.file} in this repository) and committing the result.`,
        '',
        `# ${task.title}`,
        '',
        task.body || '(No further description: the title is the task.)',
        '',
        task.result ? `The worker's report:

${task.result}` : '(The worker left no report.)',
        '',
        'Review the worker', s, changes in the, working, tree, read, the, diff, run, the, checks, that, apply, fix, small, problems, and, say, what, you, could, not, fix., ', `Immediately before committing, run \`git ${grep}\`. If it prints a commit, do not commit: stop and end your report with \`NO-COMMIT: already committed in <sha>\`.`,
        `Otherwise commit the task's changes with the trailer \`${trailer}: ${task.id}\` on its own line at the end of the commit message.`,
        'End your report with a line `COMMIT: <sha>` or `NO-COMMIT: <reason>`.',
        `Do not edit ${DIR}/${task.file}; the inbox records your report there.`,
    ].join(', '));
}
/** The git command that finds a commit already made for a task. */
export const commitGrepArgv = (id, trailer) => [
    'git', 'log', '--all', '-n', '1', '--format=%h %s', '-E', `--grep=^${trailer}: ${id}$`,
];
/** The sha a reviewer's report ends with, if it committed. */
export const parseCommitReport = (answer) => /^COMMIT:\s*([0-9a-f]{7,40})/m.exec(answer ?? '')?.[1];
export const isLive = (run) => run.status === 'running';
export const liveRun = (runs, taskId) => runs.find(run => run.taskId === taskId && isLive(run));
/** Open tasks no agent works yet, oldest first: what a drain starts next. */
export function pending(tasks, runs, blocked = new Set()) {
    return tasks.filter(task => task.status === 'open' && !liveRun(runs, task.id) && !blocked.has(task.id)).sort((a, b) => a.id - b.id);
}
/** The tasks the drain starts now so that `width` agents are busy. */
export function toStart(tasks, runs, width, blocked = new Set()) {
    const busy = runs.filter(isLive).length;
    return pending(tasks, runs, blocked).slice(0, Math.max(0, width - busy));
}
export function counts(tasks) {
    const by = (status) => tasks.filter(one => one.status === status).length;
    return { open: by('open'), running: by('running'), done: by('done'), failed: by('failed') };
}
export function filtered(tasks, filter) {
    const list = [...tasks].sort((a, b) => a.id - b.id);
    if (filter === 'all')
        return list;
    if (filter === 'done')
        return list.filter(one => one.status === 'done');
    return list.filter(one => one.status !== 'done');
}
export function elapsedText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
export const HELP = [
    '/inbox                                     open the inbox pane',
    '/inbox new [--agent t] [--model m] <title> [-- <details>]   add a task',
    '/inbox run <id> [<id>…]                    deploy a subagent on each task',
    '/inbox drain [n|off]                       keep n subagents (default 2) working open tasks until none are left',
    '/inbox status                              one-line state of the inbox: open, running, stalled, locked elsewhere',
    '/inbox review <id> [<id>…]                 deploy a reviewer that checks a done task and commits it (once)',
    '/inbox unlock <id> [--force]               release a lock this session holds; --force releases anyone', s, ',,
    '/inbox done <id> · /inbox reopen <id>      mark a task done, or open again',
    '/inbox show <id> · /inbox list             print a task, or all of them',
    `Tasks are markdown files in ${DIR}/ — you, Claude or any agent can add or edit them.`,
].join('\n');
const ids = (words) => words.map(word => Number(word.replace(/^#/, ''))).filter(n => Number.isInteger(n) && n > 0);
export function parseCommand(args) {
    const text = args.trim();
    const [verb = '', ...words] = text.split(/\s+/);
    const rest = text.slice(verb.length).trim();
    switch (verb) {
        case '':
            return { kind: 'open' };
        case 'help':
            return { kind: 'help' };
        case 'list':
            return { kind: 'list' };
        case 'status':
            return { kind: 'status' };
        case 'review':
        case 'commit': {
            const list = ids(words);
            return list.length > 0 ? { kind: 'review', ids: list } : { kind: 'error', text: 'Usage: /inbox review <id> [<id>…]' };
        }
        case 'unlock': {
            const [id] = ids(words.filter(word => word !== '--force'));
            return id ? { kind: 'unlock', id, force: words.includes('--force') } : { kind: 'error', text: 'Usage: /inbox unlock <id> [--force]' };
        }
        case 'new':
        case 'add': {
            let head = rest;
            let body = '';
            const split = rest.indexOf(' -- ');
            if (split >= 0) {
                head = rest.slice(0, split);
                body = rest.slice(split + 4).trim();
            }
            const flags = {};
            const flag = /^--(agent|model)\s+(\S+)\s*/;
            for (let m = flag.exec(head); m; m = flag.exec(head)) {
                flags[m[1] ?? ''] = m[2] ?? '';
                head = head.slice(m[0].length);
            }
            const title = head.trim();
            if (!title)
                return { kind: 'error', text: 'Usage: /inbox new [--agent t] [--model m] <title> [-- <details>]' };
            return { kind: 'new', title, body, ...(flags.agent ? { agent: flags.agent } : {}), ...(flags.model ? { model: flags.model } : {}) };
        }
        case 'run':
        case 'deploy': {
            const list = ids(words);
            return list.length > 0 ? { kind: 'run', ids: list } : { kind: 'error', text: 'Usage: /inbox run <id> [<id>…]' };
        }
        case 'drain': {
            const word = words[0];
            if (word === undefined)
                return { kind: 'drain', width: 2 };
            if (word === 'off' || word === 'stop')
                return { kind: 'drain', width: 0 };
            const width = Number(word);
            return Number.isInteger(width) && width >= 1 && width <= 8
                ? { kind: 'drain', width }
                : { kind: 'error', text: 'Usage: /inbox drain [1-8|off]' };
        }
        case 'done':
        case 'reopen': {
            const [id] = ids(words);
            return id ? { kind: 'set', id, status: verb === 'done' ? 'done' : 'open' } : { kind: 'error', text: `Usage: /inbox ${verb} <id>` };
        }
        case 'show': {
            const [id] = ids(words);
            return id ? { kind: 'show', id } : { kind: 'error', text: 'Usage: /inbox show <id>' };
        }
        default:
            return { kind: 'error', text: HELP };
    }
}
/** One line on where the inbox stands; every answer that would otherwise say nothing ends with it. */
export function summary(input) {
    const { tasks, runs, locks, me, now, cfg, drain } = input;
    if (tasks.length === 0)
        return 'The inbox is empty. Add one: /inbox new <title>';
    const c = counts(tasks);
    const live = runs.filter(isLive);
    const stalled = stallCounts(runs, now, cfg);
    const idle = live.filter(run => level(run, now, cfg) === 'idle');
    const out = live.filter(run => level(run, now, cfg) === 'timedOut');
    const parts = [`${c.open} open`];
    if (live.length > 0) {
        const names = idle.map(run => `#${run.taskId} idle ${shortDuration(now - run.lastActivityAt)}`).join(', ');
        parts.push(`${live.length - stalled.timedOut} running${names ? ` (${names})` : ''}`);
    }
    if (out.length > 0)
        parts.push(`${out.length} timed out (${out.map(run => `#${run.taskId}`).join(', ')})`);
    parts.push(`${c.done} done`);
    if (c.failed > 0)
        parts.push(`${c.failed} failed`);
    const elsewhere = locks.filter(lock => lockState(lock, now, me, cfg.lockStaleMs) === 'held');
    if (elsewhere.length > 0)
        parts.push(`locked elsewhere: ${elsewhere.map(lock => `#${lock.task} (${lock.phase})`).join(', ')}`);
    const blocked = new Set(elsewhere.map(lock => lock.task));
    const next = pending(tasks, runs, blocked);
    const hints = next.length > 0 ? [`/inbox run ${next[0]?.id}`, ...(drain > 0 ? [] : ['/inbox drain'])] : [];
    return `Inbox: ${parts.join(' · ')}.${hints.length > 0 ? ` Next: ${hints.join(' · ')}` : ''}${drain > 0 ? ` Draining ×${drain}.` : ''}`;
}
