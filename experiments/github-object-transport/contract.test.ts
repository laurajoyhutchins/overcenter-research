import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validPath, validateRequest } from './contract.ts';
const fixture=n=>JSON.parse(readFileSync(new URL(`./fixtures/${n}`,import.meta.url),'utf8'));
test('declared request is accepted',()=>assert.equal(validateRequest(fixture('request.json')),true));
test('control-character request is rejected',()=>assert.equal(validateRequest(fixture('invalid-newline-request.json')),false));
test('hostile path grammar fails closed',()=>{for(const p of ['','/x','a//b','a/./b','a/../b','a\nb'])assert.equal(validPath(p),false,p);assert.equal(validPath('experiments/github-object-transport/fixtures/payload.txt'),true);});
