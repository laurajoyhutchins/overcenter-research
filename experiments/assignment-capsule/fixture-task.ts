import {readFileSync,writeFileSync} from 'node:fs';
import {connect} from 'node:net';

const [inputPath,outputPath]=process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('TASK_ARGUMENTS_REQUIRED');
if (process.env.GITHUB_TOKEN) throw new Error('TASK_RECEIVED_GITHUB_TOKEN');

const networkBlocked=await new Promise(resolve=>{
  const socket=connect({host:'1.1.1.1',port:443});
  const done=value=>{socket.destroy();resolve(value);};
  socket.setTimeout(1000,()=>done(true));
  socket.once('error',()=>done(true));
  socket.once('connect',()=>done(false));
});
if (!networkBlocked) throw new Error('TASK_NETWORK_NOT_BLOCKED');

const input=readFileSync(inputPath,'utf8').trim();
writeFileSync(outputPath,`completed:${input}\n`,'utf8');
