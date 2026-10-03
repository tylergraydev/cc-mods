import { atom, read, update } from 'claude-code';
import { BENCH, fillSlot, inSlot, slotOf } from './bench';
import { DIR, HELP, brief, commitGrepArgv, counts, elapsedText, fileName, filtered, isLive, isTaskFile, liveRun, nextId, parseCommand, parseCommitReport, parseTask, pending, reviewBrief, serializeTask, summary, toStart, toolLabel, } from './inbox';
import { acquireLock, describeLock, loadLocks, lockState, readLock, refreshLock, releaseLock } from './lock';
import { beatText, errorCount, fingerprint, inFlight, lastTool, level, observe, shortDuration, stallCounts, step, toolCount, watchConfig } from './watch';
const PANE = 'inbox';
const TITLE = 'Inbox';
const TICK_MS = 3000;
const LOCK_REFRESH_MS = 60000;
const DEFAULT_AGENT = 'general-purpose';
const tasks = atom({ plugin: 'inbox', key: 'tasks' }, []);
const runs = atom({ plugin: 'inbox', key: 'runs' }, []);
const selected = atom({ plugin: 'inbox', key: 'selected' }, null);
const filter = atom({ plugin: 'inbox', key: 'filter' }, 'active');
const drain = atom({ plugin: 'inbox', key: 'drain' }, 0);
const clockNow = atom({ plugin: 'inbox', key: 'now' }, 0);
const locks = atom({ plugin: 'inbox', key: 'locks' }, []);
const sessionId = atom({ plugin: 'inbox', key: 'sessionId' }, '');
const STATUS = {
    open: { glyph: '○' },
    running: { glyph: '●', color: 'yellow' },
    done: { glyph: '✓', color: 'green', dimColor: true },
    failed: { glyph: '✗', color: 'red' },
};
const TONE = {
    dim: { dimColor: true },
    yellow: { color: 'yellow', bold: true },
    red: { color: 'red', bold: true },
};
/** Parsed task files by name, kept while their mtime stands. */
const cache = new Map();
let isTicking = false;
let isPumping = false;
/** The userConfig values, set by register. */
let cfg = watchConfig({});
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
/** Reads .inbox/ into state: new and changed files, removed ones dropped. */
async function loadTasks($) {
    const entries = (await $.fs.exists(DIR)) ? await $.fs.list(DIR) : [];
    const list = [];
    for (const entry of entries) {
        if (entry.kind !== 'file' || !isTaskFile(entry.name))
            continue;
        const held = cache.get(entry.name);
        if (held && held.mtimeMs === entry.mtimeMs) {
            list.push(held.task);
            continue;
        }
        const text = await $.fs.read(`${DIR}/${entry.name}`).catch(() => undefined);
        if (typeof text !== 'string')
            continue;
        const task = parseTask(entry.name, text);
        cache.set(entry.name, { mtimeMs: entry.mtimeMs, task });
        list.push(task);
    }
    for (const name of [...cache.keys()])
        if (!entries.some(entry => entry.name === name))
            cache.delete(name);
    list.sort((a, b) => a.id - b.id);
    const held = await read($, tasks);
    if (JSON.stringify(held) !== JSON.stringify(list))
        await update($, tasks, () => list);
    return list;
}
async function writeTask($, task) {
    await $.fs.write(`${DIR}/${task.file}`, serializeTask(task));
    cache.delete(task.file);
    await update($, tasks, list => {
        const rest = list.filter(one => one.id !== task.id);
        return [...rest, task].sort((a, b) => a.id - b.id);
    });
}
/** Changes a task's fields from its file as it stands now, so edits made meanwhile are kept. */
async function patchTask($, id, change) {
    const known = (await read($, tasks)).find(one => one.id === id);
    if (!known)
        return undefined;
    const text = await $.fs.read(`${DIR}/${known.file}`).catch(() => undefined);
    const fresh = typeof text === 'string' ? parseTask(known.file, text) : known;
    const next = { ...change(fresh), updated: stamp(await $.clock.now()) };
    await writeTask($, next);
    return next;
}
async function createTask($, fields) {
    const list = await loadTasks($);
    const id = nextId(list);
    const now = stamp(await $.clock.now());
    const task = {
        id,
        file: fileName(id, fields.title),
        title: fields.title,
        status: 'open',
        ...(fields.agent ? { agent: fields.agent } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        created: now,
        updated: now,
        body: fields.body,
    };
    await writeTask($, task);
    return task;
}
/** This session's id, asked once and kept so a reload still owns its locks. */
async function getMe($) {
    const held = await read($, sessionId);
    if (held)
        return held;
    const id = await $.session.id().catch(() => '');
    if (id)
        await update($, sessionId, () => id);
    return id;
}
/** Reads the lock files into state, written only when they changed. */
async function refreshLocks($) {
    const list = await loadLocks($);
    if (JSON.stringify(await read($, locks)) !== JSON.stringify(list))
        await update($, locks, () => list);
    return list;
}
/** Tasks another live session holds a lock on. */
async function blockedIds($) {
    const me = await getMe($);
    const now = await $.clock.now();
    return new Set((await read($, locks)).filter(lock => lockState(lock, now, me, cfg.lockStaleMs) === 'held').map(lock => lock.task));
}
/** Takes a task's lock for this session, toasting a takeover; says why not when it can't. */
async function takeLock($, id, phase) {
    const now = await $.clock.now();
    const got = await acquireLock($, id, phase, await getMe($), now, cfg.lockStaleMs);
    if (got.ok && got.tookOver) {
        const ago = shortDuration(now - Date.parse(got.tookOver.refreshedAt));
        $.ui.toast(`inbox: took over stale lock on #${id} (session ${got.tookOver.session.slice(0, 8)}, ${ago})`);
    }
    await refreshLocks($);
    return got;
}
async function dropLock($, id) {
    await releaseLock($, id, await $.clock.now()).catch(() => undefined);
    await refreshLocks($);
}
/** Looks for a commit that already carries the task's trailer. */
async function commitCheck($, id) {
    const ran = await $.process.run(commitGrepArgv(id, cfg.trailer), { timeoutMs: 10000 }).catch(() => undefined);
    if (!ran)
        return { kind: 'skipped', why: 'git did not run' };
    if (ran.exitCode !== 0)
        return { kind: 'skipped', why: ran.stderr.split('\n')[0]?.trim() || `git exited ${ran.exitCode}` };
    const line = ran.stdout.trim().split('\n')[0] ?? '';
    if (!line)
        return { kind: 'clear' };
    const [sha = '', ...subject] = line.split(' ');
    return { kind: 'committed', sha, subject: subject.join(' ') };
}
/** Starts a background subagent on a task, to work it or to review it; says what happened. */
async function deploy($, id, phase = 'work') {
    const task = (await read($, tasks)).find(one => one.id === id);
    if (!task)
        return `No task #${id}.`;
    if (liveRun(await read($, runs), id))
        return `#${id} already has an agent working it.`;
    if (phase === 'review' && task.status !== 'done')
        return `#${id} is ${task.status}; only a done task can be reviewed.`;
    if (phase === 'review' && task.commit)
        return `#${id} already committed in ${task.commit}.`;
    const got = await takeLock($, id, phase);
    if (!got.ok)
        return `${got.reason}.`;
    let note = '';
    if (phase === 'review') {
        const found = await commitCheck($, id);
        if (found.kind === 'committed') {
            await patchTask($, id, held => ({ ...held, commit: found.sha }));
            await dropLock($, id);
            return `#${id} already committed in ${found.sha} "${found.subject}".`;
        }
        if (found.kind === 'skipped')
            note = ` (commit check skipped: ${found.why})`;
    }
    const result = await $.agent.spawn({
        subagentType: task.agent ?? DEFAULT_AGENT,
        prompt: phase === 'review' ? reviewBrief(task, cfg.trailer) : brief(task),
        description: `inbox #${id}${phase === 'review' ? ' review' : ''}: ${task.title}`.slice(0, 60),
        ...(task.model ? { model: task.model } : {}),
    });
    if (result.deny) {
        await dropLock($, id);
        return `#${id} not started: ${result.deny}`;
    }
    // the agent.spawn hook records the run as the agent starts; the result carries its id too
    if (result.agentId)
        await startRun($, id, result.agentId, phase);
    const run = liveRun(await read($, runs), id);
    if (!run) {
        await dropLock($, id);
        return `#${id} not started: no agent id came back`;
    }
    return `#${id}${phase === 'review' ? ' review' : ''} → ${task.agent ?? DEFAULT_AGENT} (${run.agentId}) on ${result.model}.${note}`;
}
/** An agent took a task: its run starts and the file says so. */
async function startRun($, id, agentId, phase = 'work') {
    if ((await read($, runs)).some(one => one.agentId === agentId))
        return;
    const now = await $.clock.now();
    await update($, clockNow, () => now);
    await update($, runs, list => [
        ...list.filter(one => one.taskId !== id),
        { taskId: id, agentId, startedAt: now, tools: 0, errors: 0, status: 'running', phase, lastActivityAt: now, watch: 'active' },
    ]);
    // a review leaves the task's status alone: it is done, and stays done
    await patchTask($, id, held => ({ ...held, ...(phase === 'work' ? { status: 'running' } : {}), agentId }));
}
/** An agent ended: the task takes its report and status. */
async function settle($, agentId, status, answer) {
    const run = (await read($, runs)).find(one => one.agentId === agentId && isLive(one));
    if (!run)
        return;
    const now = await $.clock.now();
    await update($, runs, list => list.map(one => (one.agentId === agentId ? { ...one, status, endedAt: now, waitingOn: undefined } : one)));
    const text = answer?.trim();
    if (run.phase === 'review') {
        const sha = parseCommitReport(text);
        const task = await patchTask($, run.taskId, held => ({
            ...held,
            ...(sha ? { commit: sha } : {}),
            result: [held.result, `### Review (${stamp(now)})\n\n${text || '(The reviewer stopped without a report.)'}`].filter(Boolean).join('\n\n'),
        }));
        await dropLock($, run.taskId);
        if (task) {
            $.ui.toast(status === 'done' ? `✓ inbox #${task.id} reviewed: ${sha ? `committed ${sha}` : 'not committed'}` : `✗ inbox #${task.id} review failed: ${task.title}`);
        }
        void pump($);
        return;
    }
    const task = await patchTask($, run.taskId, held => ({
        ...held,
        status,
        ...(text ? { result: text } : status === 'failed' ? { result: '(The agent stopped without a report.)' } : {}),
    }));
    await dropLock($, run.taskId);
    if (task)
        $.ui.toast(`${status === 'done' ? '✓' : '✗'} inbox #${task.id} ${status}: ${task.title}`);
    void pump($);
}
/** While draining, starts open tasks until the drain's width of agents is busy. */
async function pump($) {
    if (isPumping)
        return;
    isPumping = true;
    try {
        const width = await read($, drain);
        if (width <= 0)
            return;
        const list = await read($, tasks);
        const held = await read($, runs);
        const blocked = await blockedIds($);
        for (const task of toStart(list, held, width, blocked)) {
            const said = await deploy($, task.id);
            if (said.includes('locked by'))
                continue;
            if (!said.includes('→')) {
                $.ui.toast(`inbox drain stopped: ${said}`);
                await update($, drain, () => 0);
                return;
            }
        }
        const after = await read($, runs);
        if (pending(await read($, tasks), after, blocked).length === 0 && !after.some(isLive)) {
            await update($, drain, () => 0);
            $.ui.toast('Inbox drained: no open tasks left.');
        }
    }
    finally {
        isPumping = false;
    }
}
/** What the watchdog does once a run times out, besides marking it; the toast's tail says which. */
async function onTimedOut($, run, now) {
    if (cfg.onTimeout === 'nudge') {
        const text = `[inbox watchdog] No progress on inbox #${run.taskId} for ${shortDuration(now - run.lastActivityAt)}. Finish and report now, or say what is blocking you.`;
        const sent = await $.session
            .append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId: run.agentId })
            .catch(() => undefined);
        return sent && !sent.deny ? ' · nudged' : '';
    }
    if (cfg.onTimeout === 'redeploy' && (run.redeploys ?? 0) < 1) {
        await update($, runs, list => list.map(one => (one.agentId === run.agentId ? { ...one, status: 'abandoned', endedAt: now } : one)));
        await dropLock($, run.taskId);
        if (run.phase === 'work')
            await patchTask($, run.taskId, held => ({ ...held, status: 'open' }));
        const said = await deploy($, run.taskId, run.phase);
        await update($, runs, list => list.map(one => (one.taskId === run.taskId && isLive(one) ? { ...one, redeploys: (run.redeploys ?? 0) + 1 } : one)));
        return said.includes('→') ? ' · redeployed' : ` · redeploy failed: ${said}`;
    }
    return '';
}
/** Polls a live run's conversation for the heartbeat and announces a level the first time it is reached. */
async function watch($, run, now) {
    const rows = await $.session.messages({ agentId: run.agentId }).catch(() => undefined);
    if (!Array.isArray(rows))
        return;
    const polled = observe(run, now, fingerprint(rows), inFlight(rows));
    const latest = lastTool(rows);
    const grown = {
        ...polled,
        tools: Math.max(polled.tools, toolCount(rows)),
        errors: Math.max(polled.errors, errorCount(rows)),
        ...(latest ? { lastTool: latest } : {}),
    };
    const { run: stepped, fire } = step(grown, now, cfg);
    if (JSON.stringify(stepped) !== JSON.stringify(run)) {
        await update($, runs, list => list.map(one => (one.agentId === run.agentId && isLive(one) ? stepped : one)));
    }
    if (!fire)
        return;
    const idle = shortDuration(now - stepped.lastActivityAt);
    if (fire === 'idle')
        $.ui.toast(`inbox: task ${run.taskId} idle ${idle}`);
    else
        $.ui.toast(`inbox: task ${run.taskId} timed out (idle ${idle})${await onTimedOut($, stepped, now)}`);
}
/** Picks up new files, settles agents the hooks missed, watches the workers, keeps locks fresh, feeds a drain. */
async function tick($) {
    if (isTicking)
        return;
    isTicking = true;
    try {
        await loadTasks($);
        const held = await refreshLocks($);
        const me = await getMe($);
        const now = await $.clock.now();
        const live = (await read($, runs)).filter(isLive);
        if (live.length > 0 || held.some(lock => !lock.released))
            await update($, clockNow, () => now);
        if (live.length > 0) {
            const agents = await $.agent.list().catch(() => []);
            for (const run of live) {
                const seen = agents.find(one => one.id === run.agentId);
                if (seen && seen.status !== 'running' && seen.status !== 'pending') {
                    await settle($, run.agentId, seen.status === 'completed' ? 'done' : 'failed', undefined);
                }
            }
            for (const run of (await read($, runs)).filter(isLive))
                await watch($, run, now);
            for (const run of (await read($, runs)).filter(isLive)) {
                const lock = held.find(one => one.task === run.taskId);
                if (lock && lock.session === me && !lock.released && now - Date.parse(lock.refreshedAt) > LOCK_REFRESH_MS) {
                    await refreshLock($, run.taskId, me, now);
                }
            }
        }
        await pump($);
    }
    finally {
        isTicking = false;
    }
}
async function setStatus($, id, status) {
    return patchTask($, id, held => ({ ...held, status }));
}
/** The one-line state, from what the atoms hold now. */
async function summaryText($) {
    return summary({
        tasks: await read($, tasks),
        runs: await read($, runs),
        locks: await read($, locks),
        me: await getMe($),
        now: await $.clock.now(),
        cfg,
        drain: await read($, drain),
    });
}
export const register = (on, options) => {
    cfg = watchConfig(options);
    on('session.start', async ($, e, next) => {
        const started = await next(e);
        await $.command.register({
            name: 'inbox',
            description: 'Task inbox in .inbox/: add tasks, deploy subagents on them, watch progress',
            argumentHint: '[new|run|review|drain|status|unlock|done|reopen|show|list|help] …',
        });
        await getMe($);
        await loadTasks($).catch(() => undefined);
        await refreshLocks($).catch(() => undefined);
        $.clock.every(TICK_MS, () => void tick($));
        return started;
    });
    // Every spawn of an inbox task, ours or one Claude made from a brief: the run starts here.
    on('agent.spawn', async ($, e, next) => {
        const match = /^inbox #(\d+)( review)?:/.exec(e.description ?? '');
        const id = Number(match?.[1] ?? 0);
        const phase = match?.[2] ? 'review' : 'work';
        if (id > 0) {
            const got = await takeLock($, id, phase);
            if (!got.ok) {
                $.ui.toast(`inbox: ${got.reason}`);
                return { deny: `${got.reason}. Another session is working it; pick another task.` };
            }
        }
        const result = await next(e);
        if (id > 0) {
            if (result.agentId)
                await startRun($, id, result.agentId, phase);
            else
                await dropLock($, id);
        }
        return result;
    });
    // Only the agents Claude spawned itself pass through here: a hook's own spawns step past it.
    on('tool.call', async ($, e, next) => {
        const agentId = e.agentId;
        if (!agentId || !(await read($, runs)).some(run => run.agentId === agentId && isLive(run)))
            return next(e);
        const label = toolLabel(e.tool, e);
        const before = await $.clock.now();
        await update($, runs, list => list.map(run => (run.agentId === agentId ? { ...run, tools: run.tools + 1, lastTool: label, waitingOn: label, lastActivityAt: before } : run)));
        const ran = await next(e);
        const after = await $.clock.now();
        await update($, runs, list => list.map(run => (run.agentId === agentId ? { ...run, waitingOn: undefined, lastActivityAt: after } : run)));
        if (ran.deny || ran.isError) {
            await update($, runs, list => list.map(run => (run.agentId === agentId ? { ...run, errors: run.errors + 1 } : run)));
        }
        return ran;
    });
    on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        if (e.agentId)
            await settle($, e.agentId, e.reason === 'answer' ? 'done' : 'failed', e.answer);
        return result;
    });
    on('command.run', { command: 'inbox' }, async ($, e) => {
        const handle = async () => {
            const cmd = parseCommand(e.args);
            if (cmd.kind !== 'error' && cmd.kind !== 'help') {
                await loadTasks($);
                await refreshLocks($);
            }
            switch (cmd.kind) {
                case 'error':
                    return { text: cmd.text };
                case 'help':
                    return { text: HELP };
                case 'open': {
                    const now = await $.clock.now();
                    await update($, clockNow, () => now);
                    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true });
                    const shown = opened.isPlaced ? '' : `\nPane not shown: ${opened.reason}.`;
                    return { text: `${await summaryText($)}${shown}` };
                }
                case 'status': {
                    await tick($);
                    return { text: await summaryText($) };
                }
                case 'list': {
                    const list = await read($, tasks);
                    if (list.length === 0)
                        return { text: `The inbox is empty. Add one: /inbox new <title>` };
                    return { text: list.map(one => `${STATUS[one.status].glyph} #${one.id} ${one.title} (${one.status})`).join('\n') };
                }
                case 'new': {
                    const task = await createTask($, cmd);
                    void $.ui.open({ id: PANE, title: TITLE });
                    return { text: `Added #${task.id}: ${task.title} (${DIR}/${task.file}). Deploy it: /inbox run ${task.id}` };
                }
                case 'run':
                case 'review': {
                    const said = [];
                    for (const id of cmd.ids)
                        said.push(await deploy($, id, cmd.kind === 'review' ? 'review' : 'work'));
                    void $.ui.open({ id: PANE, title: TITLE });
                    // every line a refusal: say where the inbox stands too
                    const started = said.some(line => line.includes('→'));
                    return { text: started ? said.join('\n') : `${said.join('\n')}\n${await summaryText($)}` };
                }
                case 'drain': {
                    if (cmd.width === 0) {
                        await update($, drain, () => 0);
                        return { text: 'Drain off. Running agents finish their tasks.' };
                    }
                    const open = pending(await read($, tasks), await read($, runs), await blockedIds($)).length;
                    if (open === 0)
                        return { text: `Nothing to drain: 0 open tasks. ${await summaryText($)}` };
                    await update($, drain, () => cmd.width);
                    void $.ui.open({ id: PANE, title: TITLE });
                    await pump($);
                    return { text: `Draining ${open} open task${open === 1 ? '' : 's'}, ${cmd.width} at a time. /inbox drain off stops it.` };
                }
                case 'unlock': {
                    const lock = await readLock($, cmd.id);
                    const now = await $.clock.now();
                    const me = await getMe($);
                    if (!lock || lock.released)
                        return { text: `No lock on #${cmd.id}.` };
                    if (lock.session !== me && !cmd.force) {
                        return { text: `#${cmd.id} is locked by ${describeLock(lock, now)}. Release it anyway: /inbox unlock ${cmd.id} --force` };
                    }
                    await dropLock($, cmd.id);
                    return { text: `Released the lock on #${cmd.id}.` };
                }
                case 'set': {
                    const task = await setStatus($, cmd.id, cmd.status);
                    return { text: task ? `#${task.id} is ${task.status}.` : `No task #${cmd.id}.` };
                }
                case 'show': {
                    const task = (await read($, tasks)).find(one => one.id === cmd.id);
                    if (!task)
                        return { text: `No task #${cmd.id}.` };
                    return { text: serializeTask(task) };
                }
            }
        };
        const out = await handle();
        return out.text?.trim() ? out : { ...out, text: await summaryText($) };
    });
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e));
    // Inside the workbench: fill this pane's slot in its frame.
    on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
        const frame = await next(e);
        const slot = slotOf(frame, PANE);
        return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns))) : frame;
    });
};
/** The pane's drawing, in its own pane or in a workbench slot. */
async function drawPane($, e) {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    // mobile draws no Input; adding a task there goes through /inbox new
    const Input = 'Input' in elements ? elements.Input : undefined;
    const list = await read($, tasks);
    const held = await read($, runs);
    const locked = await read($, locks);
    const pick = await read($, selected);
    const view = await read($, filter);
    const width = await read($, drain);
    const me = (await read($, sessionId)) || (await $.session.id().catch(() => ''));
    const now = Math.max(await read($, clockNow), await $.clock.now(), ...held.map(run => run.endedAt ?? run.startedAt));
    const columns = Math.max(30, e.props.bodyColumns || 60);
    const c = counts(list);
    const shown = filtered(list, view);
    const stalled = stallCounts(held, now, cfg);
    /** Another session's lock on a task, and whether it has gone stale. */
    const lockOn = (id) => {
        const lock = locked.find(one => one.task === id);
        const state = lockState(lock, now, me, cfg.lockStaleMs);
        return { lock, isHeld: state === 'held', isStale: state === 'stale' };
    };
    const header = (<Box key="head" flexDirection="row">
      <Text bold color="#D97757">INBOX </Text>
      <Text>{`${c.open} open`}</Text>
      <Text color="yellow">{` · ${c.running} running`}</Text>
      {stalled.idle > 0 && <Text color="yellow">{` · ${stalled.idle} idle`}</Text>}
      {stalled.timedOut > 0 && <Text color="red">{` · ${stalled.timedOut} timed out`}</Text>}
      <Text dimColor>{` · ${c.done} done`}</Text>
      {c.failed > 0 && <Text color="red">{` · ${c.failed} failed`}</Text>}
      {width > 0 && <Text color="cyan">{`   draining ×${width}`}</Text>}
    </Box>);
    const controls = (<Box key="controls" flexDirection="row">
      {['active', 'all', 'done'].map(one => (<Button key={`filter-${one}`} plain dimColor={view !== one} onPress={() => void update($, filter, () => one)}>
          {view === one ? `[${one}]` : ` ${one} `}
        </Button>))}
      <Text> </Text>
      {width > 0 ? (<Button key="drain" hotkey="s" onPress={() => void update($, drain, () => 0)}>
          Stop drain
        </Button>) : (<Button key="drain" hotkey="a" onPress={() => void (async () => {
                await update($, drain, () => 2);
                await pump($);
            })()}>
          Drain ×2
        </Button>)}
    </Box>);
    const adder = Input && (<Input key="new-task" placeholder="New task title… (Enter adds it; details after ' -- ')" submitLabel="Add" onSubmit={(value) => {
            const [title = '', ...more] = value.split(' -- ');
            if (!title.trim())
                return;
            void createTask($, { title: title.trim(), body: more.join(' -- ').trim() }).then(task => update($, selected, () => task.id));
        }}/>);
    const line = (task) => {
        const run = held.find(one => one.taskId === task.id);
        const isRunning = run !== undefined && isLive(run);
        const lock = lockOn(task.id);
        const isBlocked = lock.isHeld && !isRunning;
        const isTimedOut = isRunning && level(run, now, cfg) === 'timedOut';
        const mark = isBlocked ? { glyph: '⊘', dimColor: true } : isTimedOut ? { glyph: '!', color: 'red' } : STATUS[task.status];
        const isOpen = pick === task.id;
        const progress = run
            ? `${run.phase === 'review' ? 'review · ' : ''}${elapsedText((run.endedAt ?? now) - run.startedAt)} · ${run.tools} tools${run.errors ? ` · ${run.errors} err` : ''}`
            : '';
        const beat = isRunning ? beatText(run, now, cfg) : undefined;
        const name = `${isOpen ? '▾' : '▸'} #${task.id} `;
        const room = Math.max(8, columns - name.length - progress.length - (beat?.text.length ?? 0) - 8);
        const title = task.title.length > room ? `${task.title.slice(0, room - 1)}…` : task.title;
        return (<Box key={`task-${task.id}`} flexDirection="column">
        <Box key="line" flexDirection="row">
          <Text color={mark.color} dimColor={mark.dimColor}>{`${mark.glyph} `}</Text>
          <Button key={`row-${task.id}`} plain dimColor={task.status === 'done' && !isOpen} onPress={() => void update($, selected, id => (id === task.id ? null : task.id))}>
            {`${name}${title}`}
          </Button>
          {progress && <Text dimColor wrap="truncate">{`  ${progress}`}</Text>}
          {beat && (<Text key={`beat-${task.id}`} wrap="truncate" {...TONE[beat.tone]}>
              {`  · ${beat.text}`}
            </Text>)}
          {isBlocked && lock.lock && (<Text key={`lock-${task.id}`} color="magenta" wrap="truncate">
              {`  locked by other session · ${lock.lock.phase} · ${shortDuration(now - Date.parse(lock.lock.refreshedAt))} ago`}
            </Text>)}
        </Box>
        {isRunning && run?.lastTool && !isOpen && (<Text key="now" dimColor wrap="truncate">{`    ↳ ${run.lastTool}`}</Text>)}
        {isOpen && detail(task, run)}
      </Box>);
    };
    const detail = (task, run) => {
        const isRunning = run !== undefined && isLive(run);
        const lock = lockOn(task.id);
        const isBlocked = lock.isHeld && !isRunning;
        const isTimedOut = isRunning && level(run, now, cfg) === 'timedOut';
        const body = task.body.length > 1500 ? `${task.body.slice(0, 1500)}…` : task.body;
        const result = task.result && (task.result.length > 2500 ? `${task.result.slice(0, 2500)}…` : task.result);
        return (<Box key="detail" flexDirection="column" marginLeft={4} marginBottom={1}>
        <Text key="meta" dimColor wrap="truncate">
          {[
                `${DIR}/${task.file}`,
                task.agent ?? DEFAULT_AGENT,
                task.model,
                task.agentId && `agent ${task.agentId}`,
                task.commit && `commit ${task.commit}`,
            ]
                .filter(Boolean)
                .join(' · ')}
        </Text>
        {body ? <Text key="body" wrap="wrap">{body}</Text> : <Text key="body" dimColor>(no details)</Text>}
        {isRunning && run?.lastTool && <Text key="now" color="yellow" wrap="truncate">{`↳ ${run.lastTool}`}</Text>}
        {isRunning && run?.waitingOn && (<Text key="waiting" color="yellow" wrap="truncate">{`↳ waiting on ${run.waitingOn} (${shortDuration(now - run.lastActivityAt)})`}</Text>)}
        {isTimedOut && cfg.onTimeout === 'mark' && (<Text key="timedout" color="red" wrap="wrap">
            Timed out. inbox can't stop subagents; stop it from the engine's task view, then Reopen or Deploy.
          </Text>)}
        {isBlocked && lock.lock && (<Box key="locked" flexDirection="column">
            <Text key="lock-line" color="magenta" wrap="wrap">{`Locked by ${describeLock(lock.lock, now)}.`}</Text>
            <Text key="lock-hint" dimColor>{`/inbox unlock ${task.id} --force releases it.`}</Text>
          </Box>)}
        {lock.isStale && lock.lock && (<Text key="stale-lock" dimColor>{`stale lock (${shortDuration(now - Date.parse(lock.lock.refreshedAt))}) · Deploy takes over`}</Text>)}
        {task.status === 'running' && !isRunning && (<Text key="stale" dimColor>No agent works it in this session; deploy it again or reopen it.</Text>)}
        {result && (<Box key="result" flexDirection="column" marginTop={1}>
            <Text key="label" bold color={task.status === 'failed' ? 'red' : undefined}>
              Result
            </Text>
            <Text key="text" wrap="wrap">{result}</Text>
          </Box>)}
        <Box key="actions" flexDirection="row" marginTop={1}>
          {!isRunning && !isBlocked && task.status !== 'done' && (<Button key={`deploy-${task.id}`} hotkey="d" variant="primary" onPress={() => void deploy($, task.id).then(said => $.ui.toast(said))}>
              Deploy
            </Button>)}
          {!isRunning && !isBlocked && task.status === 'done' && !task.commit && (<Button key={`review-${task.id}`} hotkey="v" onPress={() => void deploy($, task.id, 'review').then(said => $.ui.toast(said))}>
              Review
            </Button>)}
          {task.status !== 'done' && !isRunning && !isBlocked && (<Button key={`done-${task.id}`} hotkey="x" onPress={() => void setStatus($, task.id, 'done')}>
              Mark done
            </Button>)}
          {task.status !== 'open' && !isRunning && (<Button key={`reopen-${task.id}`} hotkey="r" onPress={() => void setStatus($, task.id, 'open')}>
              Reopen
            </Button>)}
        </Box>
      </Box>);
    };
    return (<Box flexDirection="column">
      {header}
      {controls}
      {adder}
      {shown.length === 0 ? (<Text key="empty" dimColor>
          {list.length === 0 ? `No tasks yet. Add one above, or /inbox new <title>. Files live in ${DIR}/.` : `Nothing ${view === 'done' ? 'done' : 'open'} here.`}
        </Text>) : (<Box key="list" flexDirection="column" marginTop={1}>
          {shown.map(line)}
        </Box>)}
    </Box>);
}
