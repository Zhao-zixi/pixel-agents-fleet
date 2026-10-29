import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function readYaml(path) {
  const document = parseDocument(readFileSync(resolve(root, path), 'utf8'), {
    uniqueKeys: true,
  });
  assert.equal(document.errors.length, 0, `${path}: ${document.errors.join('; ')}`);
  return document.toJS();
}

export function checkPolicy({ automatic, full, dependabot, badges }) {
  assert.deepEqual(Object.keys(automatic.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(Object.keys(automatic.jobs), ['ci']);
  const ci = automatic.jobs.ci;
  assert.equal(ci['runs-on'], 'ubuntu-latest');
  assert.equal(ci.strategy, undefined, 'Automatic CI cannot fan out into a matrix');
  assert.ok(ci['timeout-minutes'] > 0 && ci['timeout-minutes'] <= 10);
  assert.equal(automatic.concurrency['cancel-in-progress'], true);
  assert.deepEqual(automatic.permissions, { contents: 'read' });
  for (const step of ci.steps) {
    assert.ok(!/artifact|cache|playwright|vercel|setup-java/i.test(step.uses ?? ''));
    assert.ok(
      !/npm run e2e(?!:inventory)|verify:npm-package|playwright install|vercel:prepare/.test(
        step.run ?? '',
      ),
    );
    assert.equal(step['continue-on-error'], undefined, 'Automatic quality checks must fail closed');
  }
  const commands = ci.steps.map((step) => step.run ?? '').join('\n');
  for (const command of [
    'check-ci-policy.mjs',
    'check-types',
    'npm run lint',
    'format:check',
    'build:extension',
    'build:webview',
    'npm test',
  ]) {
    assert.ok(commands.includes(command), `Missing automatic validation: ${command}`);
  }

  assert.deepEqual(Object.keys(full.on), ['workflow_dispatch']);
  const inputs = full.on.workflow_dispatch.inputs;
  assert.equal(inputs.confirm_usage.type, 'boolean');
  assert.equal(inputs.confirm_usage.required, true);
  assert.equal(inputs.confirm_usage.default, false);
  assert.equal(inputs.build_report.default, false);
  for (const [name, job] of Object.entries(full.jobs)) {
    assert.ok(
      job.if?.includes("github.event_name == 'workflow_dispatch'"),
      `${name}: not manual-only`,
    );
    assert.ok(job.if?.includes('inputs.confirm_usage'), `${name}: missing cost acknowledgement`);
    assert.ok(!job.if.includes('||'), `${name}: manual guard must not have an OR bypass`);
    if (name === 'report') {
      assert.ok(
        job.if.includes('inputs.build_report'),
        `${name}: report must be separately opt-in`,
      );
    }
  }
  assert.deepEqual(full.jobs.e2e.strategy.matrix.shard, [1, 2, 3]);
  assert.deepEqual(
    full.jobs.e2e.strategy.matrix.target.map((target) => target.os),
    ['ubuntu-latest', 'macos-latest', 'windows-latest'],
  );
  for (const job of Object.values(full.jobs)) {
    const needs = job.needs ? (Array.isArray(job.needs) ? job.needs : [job.needs]) : [];
    for (const name of needs) assert.ok(full.jobs[name], `Unknown dependency ${name}`);
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/upload-artifact@')) {
        assert.equal(step.with['retention-days'], 3);
      }
    }
  }
  assert.deepEqual(dependabot.updates.map((update) => update['package-ecosystem']).sort(), [
    'github-actions',
    'npm',
  ]);
  for (const update of dependabot.updates) assert.equal(update['open-pull-requests-limit'], 0);
  assert.deepEqual(Object.keys(badges.on), ['workflow_dispatch']);
}

const policy = {
  automatic: readYaml('.github/workflows/ci.yml'),
  full: readYaml('.github/workflows/ci-full.yml'),
  dependabot: readYaml('.github/dependabot.yml'),
  badges: readYaml('.github/workflows/update-badges.yml'),
};
checkPolicy(policy);

if (process.argv.includes('--self-test')) {
  const mutations = [
    (p) => {
      p.full.on.push = {};
    },
    (p) => {
      p.full.jobs.e2e.if = 'always()';
    },
    (p) => {
      p.full.jobs['required-checks'].if = 'always()';
    },
    (p) => {
      p.full.jobs.report.if =
        "always() && github.event_name == 'workflow_dispatch' && inputs.confirm_usage";
    },
    (p) => {
      p.automatic.jobs.ci['runs-on'] = 'macos-latest';
    },
    (p) => {
      p.automatic.jobs.ci.steps.push({ uses: 'actions/upload-artifact@v7' });
    },
    (p) => {
      p.dependabot.updates[0]['open-pull-requests-limit'] = 10;
    },
    (p) => {
      p.badges.on.schedule = [{ cron: '* * * * *' }];
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(policy);
    mutate(invalid);
    assert.throws(() => checkPolicy(invalid));
  }
  console.log(`CI policy: ${mutations.length} regression guards passed`);
}
console.log('CI policy: automatic=1 Linux job; full matrix/report=manual; version updates=paused');
