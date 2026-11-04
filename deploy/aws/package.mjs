// Build on the Mac, transfer over SSH later. No AWS SDK, login, registry push or remote command.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { docker, dockerEnvironment, root } from '../../tools/docker.mjs';

const out = path.join(root,'.cache',`aws-bundle-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(out,{recursive:true});
const stage = path.join(out,'files');mkdirSync(stage);
execFileSync('npm',['--userconfig',path.join(root,'.npmrc'),'--globalconfig=/dev/null','--prefix','dashboard','run','build'],{cwd:root,stdio:'inherit'});
docker(['build','--platform','linux/arm64','-t','resilientcloud-backend:aws','.'],{stdio:'inherit',timeout:600000});
docker(['build','--platform','linux/arm64','-f','recovery/Dockerfile','-t','resilientcloud-recovery:aws','.'],{stdio:'inherit',timeout:600000});
const upstream = {
  gateway:'nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236',
  https:'caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5',
};
for(const [service,image]of Object.entries(upstream)) {
  docker(['pull','--platform','linux/arm64',image],{stdio:'inherit'});
  docker(['tag',image,`resilientcloud-${service}:aws`]);
}
const tags=['resilientcloud-backend:aws','resilientcloud-recovery:aws','resilientcloud-gateway:aws','resilientcloud-https:aws'];
const images=JSON.parse(docker(['image','inspect',...tags])).map((i,index)=>({tag:tags[index],id:i.Id,architecture:i.Architecture,size:i.Size}));
assert.ok(images.every(i=>i.architecture==='arm64'),'Bundle must contain ARM64 images');
const services={'backend-a':images[0].id,'backend-b':images[0].id,gate:images[1].id,controller:images[1].id,status:images[1].id,gateway:images[2].id,https:images[3].id};
// Raw image IDs survive save/load; registry RepoDigests may not. Fix every runtime image
// to its locally built/pulled content ID and prohibit pulls in the Compose overlay.
const release={services:Object.fromEntries(Object.entries(services).map(([s,id])=>[s,{image:id,pull_policy:'never'}]))};
const files=['compose.yaml','compose.two.yaml','compose.recovery.yaml','compose.dashboard.yaml','nginx',
  'deploy/aws/compose.aws.yaml','deploy/aws/compose.sh','deploy/aws/Caddyfile','deploy/aws/.env.example','deploy/aws/archive-events.sh','dashboard/dist'];
for(const file of files) {
  assert.ok(!lstatSync(path.join(root,file)).isSymbolicLink(),'Do not package symlinks');
  const destination=path.join(stage,file);mkdirSync(path.dirname(destination),{recursive:true});
  cpSync(path.join(root,file),destination,{recursive:true,dereference:false});
}
writeFileSync(path.join(stage,'deploy/aws/release.yaml'),JSON.stringify(release,null,2)+'\n');
const metadata={builtAt:new Date().toISOString(),gitCheckpoint:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  workingTreeDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),images,upstream,
  platform:'linux/arm64',notice:'Prepared locally only. No AWS resources created or deployment performed.'};
writeFileSync(path.join(out,'release.json'),JSON.stringify(metadata,null,2)+'\n');
docker(['save','--output',path.join(out,'images.tar'),...tags],{timeout:300000,maxBuffer:1024});
execFileSync('tar',['-czf',path.join(out,'files.tar.gz'),'-C',stage,'.'],{cwd:root});
const sums=[];
for(const file of ['images.tar','files.tar.gz','release.json']) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path.join(out,file)))hash.update(chunk);
  sums.push(`${hash.digest('hex')}  ${file}`);
}
writeFileSync(path.join(out,'SHA256SUMS'),sums.join('\n')+'\n');
// Read-only merged-config check with the generated content-pinned release.
const config=JSON.parse(docker(['compose','--project-directory',stage,'-p','resilientcloud',
  ...['compose.yaml','compose.two.yaml','compose.recovery.yaml','compose.dashboard.yaml','deploy/aws/compose.aws.yaml','deploy/aws/release.yaml'].flatMap(f=>['-f',path.join(stage,f)]),
  'config','--format','json'],{env:{...dockerEnvironment(),PROJECT_DIRECTORY:stage,DEMO_DOMAIN:'demo.example.com',ACME_EMAIL:'operator@example.com'}}));
for(const [name,service]of Object.entries(config.services)) {assert.equal(service.image,services[name]);assert.equal(service.build,undefined);assert.equal(service.restart,'no');}
console.log(JSON.stringify({bundle:out,images:images.map(i=>({tag:i.tag,id:i.id})),config:'passed',deployed:false},null,2));
