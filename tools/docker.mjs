import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const projects = ['resilientcloud', 'resilientcloud-m1-one', 'resilientcloud-m1-two', 'resilientcloud-m2', 'resilientcloud-m2-disabled'];
let environment;

// Use the selected local daemon, with an empty project-local Docker auth config.
// Context inspection reads endpoint metadata; no credentials/helpers are used for pulls.
export function dockerEnvironment() {
  if (environment) return environment;
  const endpoint = process.env.DOCKER_HOST || execFileSync('docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  if (!endpoint.startsWith('unix:///')) throw new Error('Only a local Unix-socket Docker daemon is allowed');
  const config = path.join(root, '.cache/docker');
  mkdirSync(config, { recursive: true });
  const macPlugins = '/Applications/Docker.app/Contents/Resources/cli-plugins';
  writeFileSync(path.join(config, 'config.json'), JSON.stringify({
    auths: {}, ...(existsSync(macPlugins) ? { cliPluginsExtraDirs: [macPlugins] } : {}),
  }));
  environment = { ...process.env, DOCKER_CONFIG: config, DOCKER_HOST: endpoint, PROJECT_DIRECTORY: root };
  delete environment.DOCKER_CONTEXT;
  return environment;
}

export function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root, env: dockerEnvironment(), encoding: 'utf8', timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024, ...options,
  });
}

export function composeArgs(project, scenario, args) {
  if (!projects.includes(project) || !['one', 'two', 'recovery'].includes(scenario)) throw new Error('Invalid project/scenario');
  return ['compose', '--project-directory', root, '-p', project, '-f', path.join(root, 'compose.yaml'),
    ...(scenario !== 'one' ? ['-f', path.join(root, 'compose.two.yaml')] : []),
    ...(scenario === 'recovery' ? ['-f', path.join(root, 'compose.recovery.yaml')] : []), ...args];
}

export function assertBackend(container, project, service) {
  const labels = container.Config?.Labels ?? {};
  if (!projects.includes(project) || !['backend-a', 'backend-b'].includes(service)
    || !/^[a-f0-9]{64}$/.test(container.Id)
    || labels['com.docker.compose.project'] !== project
    || labels['com.docker.compose.service'] !== service
    || labels['com.docker.compose.project.working_dir'] !== root
    || labels['io.resilientcloud.role'] !== 'backend') {
    throw new Error('Refusing target: not an authorized backend from this project directory');
  }
  return container;
}

export function inspectBackend(project, service) {
  if (!projects.includes(project) || !['backend-a', 'backend-b'].includes(service)) throw new Error('Invalid backend/project');
  const ids = docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', 'label=io.resilientcloud.role=backend']).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected exactly one ${project}/${service}; found ${ids.length}`);
  return assertBackend(JSON.parse(docker(['inspect', ids[0]]))[0], project, service);
}
