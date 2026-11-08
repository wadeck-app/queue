import { describe, it, expect } from 'vitest';
import { findTemplateProblem } from './commandTemplate.js';

describe('findTemplateProblem - cmd.exe has no safe form for a placeholder', () => {
  it.each([
    ['cmd {{ x }} (the payload picks /c)', 'cmd {{ x }}'],
    ['cmd.exe {{ x }}', 'cmd.exe {{ x }}'],
    ['cmd {{ a }} {{ b }}', 'cmd {{ a }} {{ b }}'],
    ['cmd /d {{ x }}', 'cmd /d {{ x }}'],
    ['cmd /d /s {{ x }}', 'cmd /d /s {{ x }}'],
    ['cmd /q {{ x }}', 'cmd /q {{ x }}'],
    ['cmd, placeholder inside a word', 'cmd /d x{{ x }}'],
    ['absolute path', 'C:\\Windows\\System32\\cmd.exe {{ x }}'],
    ['mshta runs its argument as a document or script', 'mshta {{ x }}'],
  ])('refuses %s', (_label, command) => {
    const problem = findTemplateProblem(command);
    expect(problem, command).toBeDefined();
    expect(problem).toContain('Fix:');
  });

  it('says why, and what to do instead', () => {
    const problem = findTemplateProblem('cmd {{ x }}')!;
    expect(problem).toContain("'cmd'");
    expect(problem).toContain('stdin');
  });

  it('leaves a command without placeholder alone', () => {
    expect(findTemplateProblem('cmd /c echo hi')).toBeUndefined();
  });
});

describe('findTemplateProblem - POSIX shell options written with +', () => {
  it.each([
    ['bash +x {{ x }}', 'bash +x {{ x }}'],
    ['sh +c {{ x }}', 'sh +c {{ x }}'],
    ['bash +e +u {{ x }}', 'bash +e +u {{ x }}'],
    ['bash +o posix {{ x }}', 'bash +o posix {{ x }}'],
    ['bash +O extglob {{ x }}', 'bash +O extglob {{ x }}'],
    ['bash -- {{ x }}', 'bash -- {{ x }}'],
  ])('refuses %s', (_label, command) => {
    expect(findTemplateProblem(command), command).toBeDefined();
  });

  it('accepts a placeholder after a literal script', () => {
    expect(findTemplateProblem('bash +x script.sh {{ x }}')).toBeUndefined();
    expect(findTemplateProblem('bash +o posix script.sh {{ x }}')).toBeUndefined();
  });
});

describe('findTemplateProblem - npm, npx, pnpm and yarn: options that take a value, unknown options', () => {
  it.each([
    ['npx --prefix d {{ x }}', 'npx --prefix d {{ x }}'],
    ['npx -w ws {{ x }}', 'npx -w ws {{ x }}'],
    ['npx --registry https://r.example {{ x }}', 'npx --registry https://r.example {{ x }}'],
    ['npm exec --workspace w {{ x }}', 'npm exec --workspace w {{ x }}'],
    ['npm --prefix d exec {{ x }}', 'npm --prefix d exec {{ x }}'],
    ['npm -C d exec {{ x }}', 'npm -C d exec {{ x }}'],
    ['npm --loglevel silly exec {{ x }}', 'npm --loglevel silly exec {{ x }}'],
    ['npx with an option this list does not know', 'npx --some-future-option d {{ x }}'],
    ['npm with an option this list does not know', 'npm --some-future-option d exec {{ x }}'],
    ['npm init {{ x }} (runs create-<x>)', 'npm init {{ x }}'],
    ['npm create {{ x }}', 'npm create {{ x }}'],
    ['npm run {{ x }} (the payload picks the script)', 'npm run {{ x }}'],
    ['npm install {{ x }} (the payload picks the package)', 'npm install {{ x }}'],
    ['npm i {{ x }}', 'npm i {{ x }}'],
    ['npm install pkg {{ x }} (every positional is a package)', 'npm install pkg {{ x }}'],
    ['npm add -D {{ x }}', 'npm add -D {{ x }}'],
    ['pnpm {{ x }}', 'pnpm {{ x }}'],
    ['pnpm exec {{ x }}', 'pnpm exec {{ x }}'],
    ['pnpm dlx {{ x }}', 'pnpm dlx {{ x }}'],
    ['pnpm add {{ x }}', 'pnpm add {{ x }}'],
    ['pnpm run {{ x }}', 'pnpm run {{ x }}'],
    ['pnpm -C d exec {{ x }}', 'pnpm -C d exec {{ x }}'],
    ['yarn {{ x }}', 'yarn {{ x }}'],
    ['yarn dlx {{ x }}', 'yarn dlx {{ x }}'],
    ['yarn exec {{ x }}', 'yarn exec {{ x }}'],
    ['yarn run {{ x }}', 'yarn run {{ x }}'],
    ['yarn add {{ x }}', 'yarn add {{ x }}'],
    ['yarn create {{ x }}', 'yarn create {{ x }}'],
    ['yarn --cwd d exec {{ x }}', 'yarn --cwd d exec {{ x }}'],
  ])('refuses %s', (_label, command) => {
    const problem = findTemplateProblem(command);
    expect(problem, command).toBeDefined();
    expect(problem).toContain('Fix:');
  });

  it('names the unknown option and says the list is closed', () => {
    const problem = findTemplateProblem('npx --some-future-option d {{ x }}')!;
    expect(problem).toContain('--some-future-option');
    expect(problem).toContain('does not know');
  });

  it.each([
    ['npx --prefix d some-tool {{ x }}'],
    ['npx -w ws some-tool {{ x }}'],
    ['npm --prefix d exec some-tool -- {{ x }}'],
    ['npm -C d exec some-tool -- {{ x }}'],
    ['npm exec --workspace w some-tool -- {{ x }}'],
    ['npm --prefix=d exec some-tool -- {{ x }}'],
    ['npm init some-tool {{ x }}'],
    ['npm run build -- {{ x }}'],
    ['npm run build --if-present -- {{ x }}'],
    ['npm view pkg version {{ x }}'],
    ['npm test -- {{ x }}'],
    ['npm install'],
    ['pnpm exec tool {{ x }}'],
    ['pnpm run build {{ x }}'],
    ['pnpm build {{ x }}'],
    ['pnpm -C d exec tool {{ x }}'],
    ['yarn build {{ x }}'],
    ['yarn exec tool {{ x }}'],
    ['yarn --cwd d run build {{ x }}'],
  ])('accepts %s', (command) => {
    expect(findTemplateProblem(command), command).toBeUndefined();
  });
});

describe('findTemplateProblem - versioned, suffixed and wrapped interpreters', () => {
  it.each([
    ['node18 -e', 'node18 -e "{{ x }}"'],
    ['node-18 -e', 'node-18 -e "{{ x }}"'],
    ['node.exe -e', 'node.exe -e "{{ x }}"'],
    ['perl5.36 -e', `perl5.36 -e 'print "{{ x }}"'`],
    ['lua5.4 -e', `lua5.4 -e 'print("{{ x }}")'`],
    ['php8.2 -r', `php8.2 -r 'echo "{{ x }}";'`],
    ['ruby3.2 -e', `ruby3.2 -e 'puts "{{ x }}"'`],
    ['bash5 -c', `bash5 -c 'echo {{ x }}'`],
    ['busybox sh -c', `busybox sh -c 'echo {{ x }}'`],
    ['busybox ash -c', `busybox ash -c 'echo {{ x }}'`],
    ['busybox {{ x }} (the payload picks the applet)', 'busybox {{ x }}'],
    ['busybox awk with the program in the value', 'busybox awk {{ x }}'],
    ['env bash -c', `env bash -c 'echo {{ x }}'`],
    ['env VAR=1 bash -c', `env VAR=1 bash -c 'echo {{ x }}'`],
    ['env -i node -e', `env -i node -e "{{ x }}"`],
    ['env -u X py -c', `env -u X py -c 'print("{{ x }}")'`],
    ['env {{ x }} (the payload picks the program)', 'env {{ x }}'],
    ['env VAR=1 {{ x }}', 'env VAR=1 {{ x }}'],
    ['env -S {{ x }} (splits the string into a command line)', 'env -S {{ x }}'],
    ['env --split-string={{ x }}', 'env --split-string={{ x }}'],
    ['env bash {{ x }}', 'env bash {{ x }}'],
    ['/usr/bin/env sh -c', `/usr/bin/env sh -c 'echo {{ x }}'`],
    ['tsx -e', 'tsx -e "{{ x }}"'],
    ['tsx {{ x }}', 'tsx {{ x }}'],
    ['ts-node -e', 'ts-node -e "{{ x }}"'],
    ['ts-node -p', 'ts-node -p "{{ x }}"'],
    ['awk with the program in the value', 'awk {{ x }}'],
    ['awk -f {{ x }}', 'awk -f {{ x }} data.txt'],
    ['awk -e {{ x }}', 'awk -e {{ x }}'],
    ['awk BEGIN with a placeholder in the program', `awk 'BEGIN{print "{{ x }}"}'`],
    ['wscript {{ x }}', 'wscript {{ x }}'],
    ['wscript //B {{ x }}', 'wscript //B {{ x }}'],
    ['cscript //nologo {{ x }}', 'cscript //nologo {{ x }}'],
    ['cscript.exe {{ x }}', 'cscript.exe {{ x }}'],
  ])('refuses %s', (_label, command) => {
    const problem = findTemplateProblem(command);
    expect(problem, command).toBeDefined();
    expect(problem).toContain('Fix:');
  });

  it.each([
    ['node18 script.js {{ x }}'],
    ['busybox sh script.sh {{ x }}'],
    ['busybox echo {{ x }}'],
    ['env bash script.sh {{ x }}'],
    ['env VAR={{ x }} bash script.sh'],
    ['env -u X git log {{ x }}'],
    ['env git commit -m {{ x }}'],
    ['tsx script.ts {{ x }}'],
    ['ts-node script.ts {{ x }}'],
    ['awk -f prog.awk {{ x }}'],
    [`awk 'BEGIN{print ARGV[1]}' {{ x }}`],
    ['wscript script.vbs {{ x }}'],
    ['cscript //nologo script.vbs {{ x }}'],
  ])('accepts %s', (command) => {
    expect(findTemplateProblem(command), command).toBeUndefined();
  });
});

describe('findTemplateProblem - hazard table entries, one by one', () => {
  it.each([
    ['node --import ./h.js {{ x }} (the value of --import is not the script)', 'node --import ./h.js {{ x }}'],
    ['node --import {{ x }}', 'node --import {{ x }} s.js'],
    ['node --loader ./l.mjs {{ x }}', 'node --loader ./l.mjs {{ x }}'],
    ['node --env-file .env {{ x }}', 'node --env-file .env {{ x }}'],
    ['node --input-type module {{ x }}', 'node --input-type module {{ x }}'],
    ['py -m {{ x }}', 'py -m {{ x }}'],
    ['python -Bm {{ x }}', 'python -Bm {{ x }}'],
    ['python -X dev {{ x }}', 'python -X dev {{ x }}'],
    ['python -W ignore {{ x }}', 'python -W ignore {{ x }}'],
    ['bun run {{ x }}', 'bun run {{ x }}'],
    ['bun x {{ x }}', 'bun x {{ x }}'],
    ['bun exec {{ x }}', 'bun exec {{ x }}'],
    ['bun create {{ x }}', 'bun create {{ x }}'],
    ['bun add {{ x }}', 'bun add {{ x }}'],
    ['bun --preload ./p.ts {{ x }}', 'bun --preload ./p.ts {{ x }}'],
    ['deno x {{ x }}', 'deno x {{ x }}'],
    ['deno run --config c.json {{ x }}', 'deno run --config c.json {{ x }}'],
    ['deno bench {{ x }}', 'deno bench {{ x }}'],
    ['deno install {{ x }}', 'deno install {{ x }}'],
    ['deno serve {{ x }}', 'deno serve {{ x }}'],
    ['deno task {{ x }}', 'deno task {{ x }}'],
    ['bash --init-file ./f {{ x }}', 'bash --init-file ./f {{ x }}'],
    ['bash --rcfile ./f {{ x }}', 'bash --rcfile ./f {{ x }}'],
    ['bash -O extglob {{ x }}', 'bash -O extglob {{ x }}'],
  ])('refuses %s', (_label, command) => {
    expect(findTemplateProblem(command), command).toBeDefined();
  });

  it.each([
    ['node --import ./h.js s.js {{ x }}'],
    ['python -X dev s.py {{ x }}'],
    ['python -W ignore s.py {{ x }}'],
    ['bun x tool {{ x }}'],
    ['deno x tool {{ x }}'],
    ['deno bench s.ts {{ x }}'],
    ['deno serve s.ts {{ x }}'],
    ['deno task build {{ x }}'],
    ['deno run --config c.json s.ts {{ x }}'],
    ['bash --init-file ./f s.sh {{ x }}'],
  ])('accepts %s', (command) => {
    expect(findTemplateProblem(command), command).toBeUndefined();
  });
});
