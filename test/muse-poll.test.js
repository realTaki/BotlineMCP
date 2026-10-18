import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Muse poll client offline recovery, pagination and send idempotency regressions',()=>{
 const r=spawnSync('python3',['-B','test/muse_poll_test.py'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
