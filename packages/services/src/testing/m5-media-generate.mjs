// Pure generation recipe. Only the resource owner runs this in the pinned CPU1 image.
export const M5_MEDIA_IMAGE =
  "sha256:344107b8230f189650b0133b31b7cb2c5e4830840121dafc3b341709b5623a3b";
export function createM5AdMediaScript() {
  return `import {execFileSync} from "node:child_process";
import {readFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {probe} from "/app/ops.mjs";
mkdirSync("/work/m5",{mode:0o700});
const version=execFileSync("ffmpeg",["-hide_banner","-version"],{encoding:"utf8"}).split("\\n")[0];
if(!version.startsWith("ffmpeg version 5.1.9")) throw Error("fixed ffmpeg required");
const args=["-hide_banner","-v","error","-nostdin","-n","-filter_threads","1","-filter_complex_threads","1","-f","lavfi","-i","testsrc2=size=1080x1920:rate=30","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-map","0:v:0","-map","1:a:0","-t","3","-vf","drawtext=fontfile=/app/fonts/NotoSansCJKsc-Regular.otf:text=广告:fontcolor=white:fontsize=72:x=48:y=48:box=1:boxcolor=black@0.6:boxborderw=16","-c:v","libx264","-preset","veryfast","-profile:v","high","-pix_fmt","yuv420p","-threads","1","-crf","23","-c:a","aac","-b:a","128k","-ac","2","-movflags","+faststart","-f","mp4","/work/m5/ad.mp4"];
execFileSync("ffmpeg",args,{timeout:120000,stdio:["ignore","ignore","inherit"]});
const report=await probe({path:"m5/ad.mp4",demuxers:["mov"]});
const raw=JSON.parse(execFileSync("ffprobe",["-v","error","-show_format","-show_streams","-of","json","/work/m5/ad.mp4"],{encoding:"utf8",timeout:10000}));
const bytes=readFileSync("/work/m5/ad.mp4");
process.stdout.write(JSON.stringify({version,args,bytes:bytes.toString("base64"),sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),report,raw}));`;
}
