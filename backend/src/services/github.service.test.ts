// Run: npx tsx backend/src/services/github.service.test.ts
import assert from 'node:assert';
import { planInjectFiles } from './github.service.ts';

const FILES = [
    { path: '.github/workflows/build.yml', skipIfExists: false },
    { path: 'Dockerfile', skipIfExists: true },
    { path: '.dockerignore', skipIfExists: true },
];

// Empty repo → everything is written, nothing skipped.
{
    const { toWrite, skipped } = planInjectFiles(new Set(), FILES);
    assert.deepEqual(toWrite.map((f) => f.path), FILES.map((f) => f.path));
    assert.deepEqual(skipped, []);
}

// User has a Dockerfile (and even a build.yml) → keep their Dockerfile, but our
// build.yml is always (over)written since it isn't skipIfExists.
{
    const { toWrite, skipped } = planInjectFiles(
        new Set(['Dockerfile', '.github/workflows/build.yml']),
        FILES,
    );
    assert.deepEqual(toWrite.map((f) => f.path), ['.github/workflows/build.yml', '.dockerignore']);
    assert.deepEqual(skipped, ['Dockerfile']);
}

// Both user files present → only build.yml goes in the commit.
{
    const { toWrite, skipped } = planInjectFiles(new Set(['Dockerfile', '.dockerignore']), FILES);
    assert.deepEqual(toWrite.map((f) => f.path), ['.github/workflows/build.yml']);
    assert.deepEqual(skipped, ['Dockerfile', '.dockerignore']);
}

console.log('planInjectFiles: all assertions passed ✓');
