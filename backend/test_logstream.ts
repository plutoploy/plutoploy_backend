// Run: node --import tsx/esm backend/test_logstream.ts
// Checks the pure PartyKit-message decision used by GET /builds/:id/logs.
import assert from 'node:assert';
import { interpretBuildEvent } from './src/routes/github.routes.ts';

const REPO = 'Debzoti/test';
const msg = (o: any) => JSON.stringify(o);

// workflow_run completed/success → forward + done + success (the terminal event)
const ok = interpretBuildEvent(msg({
    channel: 'Debzoti/test/run-28012987572',
    payload: { event: 'workflow_run', action: 'completed', conclusion: 'success' },
}), REPO);
assert(ok && ok.done && ok.success, 'run success is terminal');

// workflow_run completed/failure → done but not success
const fail = interpretBuildEvent(msg({
    channel: 'Debzoti/test/run-1',
    payload: { event: 'workflow_run', action: 'completed', conclusion: 'failure' },
}), REPO);
assert(fail && fail.done && !fail.success, 'run failure is terminal, not success');

// a JOB completing is forwarded but is NOT terminal (multi-job / double-completion)
const jobDone = interpretBuildEvent(msg({
    channel: 'Debzoti/test/run-1',
    payload: { event: 'workflow_job', action: 'completed', jobName: 'build', conclusion: 'success' },
}), REPO);
assert(jobDone && !jobDone.done && jobDone.forward.job === 'build', 'job completion forwards, not terminal');

// in_progress → forward, not done
const prog = interpretBuildEvent(msg({
    channel: 'Debzoti/test/run-1', payload: { event: 'workflow_run', action: 'in_progress' },
}), REPO);
assert(prog && !prog.done, 'in_progress forwards, not done');

// another repo on the same user socket → ignored (isolation)
assert(interpretBuildEvent(msg({ channel: 'Debzoti/other/run-1', payload: {} }), REPO) === null, 'other repo ignored');

// garbage / missing channel → ignored
assert(interpretBuildEvent('not json', REPO) === null, 'bad json ignored');
assert(interpretBuildEvent(msg({ payload: {} }), REPO) === null, 'no channel ignored');

console.log('✅ interpretBuildEvent: all checks passed');
