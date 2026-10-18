#!/usr/bin/env node
// Private artifact verification only: docker run, never Compose/deploy/shared services.
// Usage: node infra/docker/server/verify/document-conversion.mjs --image liyoxi/server:<private-tag>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { image: { type: "string" } } });
if (!values.image || !/^liyoxi\/server:w212-[a-z0-9-]+$/.test(values.image))
  throw new Error("a private w212 image tag is required");
const fixture = fileURLToPath(
  new URL("../../../../packages/services/src/testing/document-fixtures.ts", import.meta.url),
);
const source = stripTypeScriptTypes(readFileSync(fixture, "utf8"), { mode: "strip" });
// Fixture construction has large temporary ZIP/string buffers. Do it outside the constrained process;
// inside, the admitted loader reads the same immutable bytes as an actual bounded object read.
const { docx, boundaryDocx, pdf } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const fixtureDir = mkdtempSync(`${tmpdir()}/lyx-w212-artifact-`);
for (const [name, bytes] of [
  ["small.docx", docx()],
  ["small.pdf", pdf()],
  ["boundary.docx", boundaryDocx()],
  ["boundary.pdf", pdf(undefined, 1, true)],
])
  writeFileSync(`${fixtureDir}/${name}`, bytes);
const program = (targetApp) => `
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node24 required');
let sampledRss = 0; const sampler = setInterval(()=>sampledRss=Math.max(sampledRss,process.memoryUsage().rss),10);
const checks=[];
const loadPair=(boundary=false)=>({sourceBytes:readFileSync('/fixtures/'+(boundary?'boundary':'small')+'.docx'),pdfBytes:readFileSync('/fixtures/'+(boundary?'boundary':'small')+'.pdf')});
const loadWord=()=>({sourceBytes:readFileSync('/fixtures/small.docx'),pdfBytes:null});
const progress=(app,stage)=>console.log(JSON.stringify({app,stage,rss:process.memoryUsage().rss,cgroupPeak:Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8'))}));
try {
 for (const app of [${JSON.stringify(targetApp)}]) {
  const url=pathToFileURL('/app/apps/'+app+'/dist/document-converter.js');
  const {createDocumentConverter}=await import(url.href);
  const parentRequire=createRequire(url);
  if(Object.keys(parentRequire.cache).some(p=>p.includes('@napi-rs/canvas'))) throw Error('native loaded in parent');
  const converter=createDocumentConverter({workerUrl:url});
  try {
   for(const boundary of [false,true]) {
    let pdfHash;
    const result=await converter.convert({load:async()=>{
     const input=loadPair(boundary);
     if(boundary&&(input.sourceBytes.byteLength!==20971520||input.pdfBytes.byteLength!==20971520)) throw Error('boundary is not 20+20MiB');
     pdfHash=createHash('sha256').update(input.pdfBytes).digest('hex');return input;
    }});
    if(!result.ok||result.value.similarityBp!==10000||result.value.pdfSha256!==pdfHash) throw Error('real conversion failed '+JSON.stringify(result));
    checks.push({app,boundary,ok:true});
    progress(app,boundary?'20+20MiB':'small');
   }
   const controller=new AbortController(); let loaded;
   const ready=new Promise(r=>loaded=r);
   const cancelled=converter.convert({signal:controller.signal,load:signal=>new Promise((_,reject)=>{loaded();signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
   await ready;controller.abort();if((await cancelled).reason!=='cancelled')throw Error('load cancellation');
   if(!(await converter.convert({load:async()=>loadWord()})).ok)throw Error('parent did not recover');
  }finally{await converter.close();}
  writeFileSync('/tmp/stuck.mjs','import {parentPort} from "node:worker_threads";parentPort.on("message",()=>{while(true){}});');
  const stalled=createDocumentConverter({workerUrl:pathToFileURL('/tmp/stuck.mjs')});
  try {
   const abort=new AbortController();const cancelled=stalled.convert({signal:abort.signal,load:async()=>({sourceBytes:null,pdfBytes:null})});
   setTimeout(()=>abort.abort(),100);if((await cancelled).reason!=='cancelled')throw Error('worker cancellation');
   const start=Date.now();const timeout=await stalled.convert({load:async()=>({sourceBytes:null,pdfBytes:null})});
   if(timeout.reason!=='deadline_exceeded'||Date.now()-start>13000)throw Error('worker deadline');
  }finally{await stalled.close();}
  const recovered=createDocumentConverter({workerUrl:url});
  try{if(!(await recovered.convert({load:async()=>loadPair()})).ok)throw Error('recovery after CPU timeout');}finally{await recovered.close();}
  progress(app,'cancel+10s+recovered');
  if(Object.keys(parentRequire.cache).some(p=>p.includes('@napi-rs/canvas')))throw Error('native escaped worker');
 }
 clearInterval(sampler);
 const cgroupPeak=Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8'));
 const limit=Number(readFileSync('/sys/fs/cgroup/memory.max','utf8'));
 if(limit!==335544320||cgroupPeak>=limit)throw Error('320MiB boundary exceeded');
 if(process.getActiveResourcesInfo().includes('MessagePort'))throw Error('worker handle leaked');
 console.log(JSON.stringify({node:process.version,checks,sampledRss,cgroupPeak,limit,readOnly:true,tmpMiB:64,nativeInParent:false,recovered:true}));
}finally{clearInterval(sampler);}
`;
try {
  execFileSync("docker", ["image", "inspect", values.image], { stdio: "ignore" });
  // Production has a separate API and worker process, each with its own 320MiB limit.
  // Never accumulate both app bundles/native worker allocations in a single artificial parent.
  for (const app of ["api", "worker"]) {
    const name = `lyx-w212-verify-${app}-${process.pid}-${Date.now().toString(36)}`;
    const run = spawnSync(
      "docker",
      [
        "run",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=bind,source=${fixtureDir},target=/fixtures,readonly`,
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m",
        "--memory",
        "320m",
        "--memory-swap",
        "320m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--init",
        "-i",
        values.image,
        "node",
        "--input-type=module",
      ],
      { input: program(app), encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    let state, configuration;
    try {
      state = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .State}}", name], {
          encoding: "utf8",
        }),
      );
      configuration = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .HostConfig}}", name], {
          encoding: "utf8",
        }),
      );
    } finally {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    }
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    process.stdout.write(
      JSON.stringify({
        app,
        exitCode: state.ExitCode,
        OOMKilled: state.OOMKilled,
        memory: configuration.Memory,
        memorySwap: configuration.MemorySwap,
        readonlyRoot: configuration.ReadonlyRootfs,
        tmp: configuration.Tmpfs?.["/tmp"],
        network: configuration.NetworkMode,
      }) + "\n",
    );
    if (run.error || run.status !== 0 || state.OOMKilled)
      throw new Error(
        `private ${app} container failed: status=${run.status}, OOMKilled=${state.OOMKilled}`,
      );
    if (
      configuration.Memory !== 335544320 ||
      configuration.MemorySwap !== 335544320 ||
      !configuration.ReadonlyRootfs ||
      configuration.Tmpfs?.["/tmp"] !== "rw,nosuid,size=64m" ||
      configuration.NetworkMode !== "none"
    )
      throw new Error("private container resource configuration changed");
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
