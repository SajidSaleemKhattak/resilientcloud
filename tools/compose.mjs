import { composeArgs, docker } from './docker.mjs';

try {
  const [scenario, ...args] = process.argv.slice(2);
  if (!args.length || args.some(a => /^(-[pf]|--(project-name|project-directory|file)(=|$))/.test(a))) {
    throw new Error('Usage: npm run compose -- one|two|recovery|dashboard <compose-command> (project/file overrides are disabled)');
  }
  docker(composeArgs('resilientcloud', scenario, args), { stdio: 'inherit', timeout: 600_000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
