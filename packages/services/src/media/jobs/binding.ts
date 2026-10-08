import type { MediaJobs } from "./runner.js";
const scopes: Array<{ jobs: MediaJobs }> = [];
export function bindMediaJobs(jobs: MediaJobs): () => void {
  const scope = { jobs };
  scopes.push(scope);
  return () => {
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
  };
}
export function boundMediaJobs(): MediaJobs {
  const one = scopes.at(-1);
  if (!one) throw new Error("媒体执行器未绑定实际运行时");
  return one.jobs;
}
