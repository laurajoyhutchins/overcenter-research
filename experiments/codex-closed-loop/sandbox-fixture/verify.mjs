import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';

function walk(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sourceRoot=fileURLToPath(new URL('./src',import.meta.url));
const remaining=walk(sourceRoot).filter(path=>path.endsWith('.js'));
assert.deepEqual(remaining,[],'production JavaScript remains');

const workerSource=String.raw`
const {randomBytes}=require('node:crypto');
const {parentPort,workerData}=require('node:worker_threads');

const send=parentPort.postMessage.bind(parentPort);
const nonce=randomBytes(32).toString('hex');
send({type:'challenge',nonce});

(async()=>{
  const mod=await import(workerData.module_url);
  const results={
    add:[mod.add(2,5),mod.add(-4,9)],
    clamp:[mod.clamp(12,0,10),mod.clamp(-2,0,10),mod.clamp(5,0,10)],
    formatUser:[
      mod.formatUser({name:'Ada Lovelace',email:'ada@example.test'}),
      mod.formatUser({name:'Grace Hopper',email:'grace@example.test'}),
    ],
    initials:[
      mod.initials('  Grace   Brewster Murray Hopper '),
      mod.initials('ada lovelace'),
    ],
  };
  send({type:'complete',nonce,results});
})().catch(error=>{
  send({type:'error',nonce,message:String(error?.stack??error)});
  process.exitCode=1;
});
`;

function evaluateCandidate() {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(workerSource,{
      eval:true,
      workerData:{module_url:new URL('./src/index.ts',import.meta.url).href},
    });
    let challenge=null;
    let complete=false;
    const timeout=setTimeout(()=>{
      void worker.terminate();
      reject(new Error('CANDIDATE_VERIFICATION_TIMEOUT'));
    },5_000);

    const fail=error=>{
      clearTimeout(timeout);
      void worker.terminate();
      reject(error instanceof Error?error:new Error(String(error)));
    };

    worker.on('message',message=>{
      if (!message || typeof message!=='object') {
        fail(new Error('CANDIDATE_VERIFICATION_MESSAGE_INVALID'));
        return;
      }
      if (message.type==='challenge') {
        if (
          challenge!==null
          || typeof message.nonce!=='string'
          || !/^[0-9a-f]{64}$/.test(message.nonce)
        ) {
          fail(new Error('CANDIDATE_VERIFICATION_CHALLENGE_INVALID'));
          return;
        }
        challenge=message.nonce;
        return;
      }
      if (message.type==='complete') {
        if (challenge===null || message.nonce!==challenge || complete) {
          fail(new Error('CANDIDATE_VERIFICATION_COMPLETION_INVALID'));
          return;
        }
        complete=true;
        clearTimeout(timeout);
        const results=message.results;
        void worker.terminate();
        resolve(results);
        return;
      }
      if (message.type==='error') {
        fail(new Error(`CANDIDATE_VERIFICATION_ERROR:${String(message.message)}`));
        return;
      }
      fail(new Error('CANDIDATE_VERIFICATION_MESSAGE_UNKNOWN'));
    });
    worker.on('error',fail);
    worker.on('exit',code=>{
      if (!complete) {
        fail(new Error(`CANDIDATE_VERIFICATION_EARLY_EXIT:${code}`));
      }
    });
  });
}

const results=await evaluateCandidate();
assert.deepEqual(results,{
  add:[7,5],
  clamp:[10,0,5],
  formatUser:[
    'Ada Lovelace <ada@example.test>',
    'Grace Hopper <grace@example.test>',
  ],
  initials:['GBMH','AL'],
});
console.log('synthetic objective verified');
