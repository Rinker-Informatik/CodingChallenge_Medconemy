import { test } from 'node:test';
import assert from 'node:assert/strict';
import {rights,canReadFile,canEditFile,canDeleteFile,canDeleteTree} from '../src/domain/permissions.js';
const share=(permission:'read'|'upload'|'write',delete_files=false,delete_folders=false)=>({permission,delete_files,delete_folders});
test('permission levels and owner rules',()=>{const none=rights(false,[]), read=rights(false,[share('read')]), upload=rights(false,[share('upload')]), write=rights(false,[share('write')]); assert.equal(canReadFile(false,true,none),true); assert.equal(canEditFile(false,true,read),false); assert.equal(canEditFile(false,true,upload),true); assert.equal(canEditFile(false,false,upload),false); assert.equal(canEditFile(false,false,write),true); assert.equal(canDeleteFile(false,true,write),true); assert.equal(canDeleteFile(false,false,write),false); assert.equal(canDeleteFile(false,false,rights(false,[share('read',true)])),true);});
test('folder deletion requires rights for every nested folder and file',()=>{const folder=rights(false,[share('write',false,true)]), denied=rights(false,[share('write')]), foreign=rights(false,[share('write',true,true)]); assert.equal(canDeleteTree(false,[folder,denied],[]),false); assert.equal(canDeleteTree(false,[folder],[{owner:false,rights:folder}]),false); assert.equal(canDeleteTree(false,[folder,foreign],[{owner:true,rights:folder},{owner:false,rights:foreign}]),true); assert.equal(canDeleteTree(true,[denied],[{owner:false,rights:denied}]),true);});
test('rights from multiple inherited and direct shares combine',()=>{const r=rights(false,[share('upload'),share('read',true,true)]); assert.deepEqual(r,{read:true,upload:true,write:false,deleteFiles:true,deleteFolders:true});});

test('owned files need write or explicit deletion permission', () => {
  const uploadOnly = rights(false, [share('upload')]);
  const explicitDelete = rights(false, [share('read', true)]);
  const folders = [rights(false, [share('read', false, true)])];

  assert.equal(canDeleteFile(false, true, uploadOnly), false);
  assert.equal(canDeleteFile(false, true, explicitDelete), true);
  assert.equal(canDeleteTree(false, folders, [{ owner: true, rights: uploadOnly }]), false);
  assert.equal(canDeleteTree(false, folders, [{ owner: true, rights: explicitDelete }]), true);
});
